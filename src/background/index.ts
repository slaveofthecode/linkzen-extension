import type {
	AuditCancelRequest,
	AuditCancelResponse,
	AuditProgress,
	AuditRequest,
	AuditResponse,
	AuditStatusRequest,
	AuditStatusResponse,
	AuditSummary,
	BookmarkCheck,
} from '../types';
import {
	MESSAGE_AUDIT_CANCEL,
	MESSAGE_AUDIT_RUN,
	MESSAGE_AUDIT_STATUS,
	STORAGE_KEY_ITEMS,
	STORAGE_KEY_PROGRESS,
	STORAGE_KEY_SUMMARY,
} from '../types';
import {
	showCancelled,
	showFinished,
	showIdle,
	showInterrupted,
	showRunning,
} from './actionBadge';

const MAX_CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 5000;
const TITLE_READ_LIMIT = 200_000;
const IDLE_PROGRESS: AuditProgress = { running: false, checked: 0, total: 0 };
const CANCELLED_MESSAGE = 'Audit cancelled — showing partial results.';
const METHOD_RETRY_STATUS = new Set([400, 403, 405, 406, 501]);

interface FlatBookmark {
	id: string;
	title: string;
	url?: string;
}

interface AuditOutcome {
	summary: AuditSummary;
	cancelled: boolean;
}

class AuditCancelledError extends Error {
	constructor() {
		super('Audit cancelled');
		this.name = 'AuditCancelledError';
	}
}

let running = false;
let activeRun: AbortController | null = null;

function flattenTree(
	nodes: chrome.bookmarks.BookmarkTreeNode[],
	out: FlatBookmark[] = []
): FlatBookmark[] {
	for (const node of nodes) {
		if (node.url) out.push({ id: node.id, title: node.title, url: node.url });
		if (node.children && node.children.length > 0)
			flattenTree(node.children, out);
	}
	return out;
}

function isHttpUrl(url: string): boolean {
	return /^https?:\/\//i.test(url);
}

function getBookmarkTree(): Promise<chrome.bookmarks.BookmarkTreeNode[]> {
	return new Promise((resolve, reject) => {
		chrome.bookmarks.getTree((tree) => {
			const err = chrome.runtime.lastError;
			if (err) reject(new Error(err.message));
			else resolve(tree);
		});
	});
}

function storageGet(keys: string[]): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		chrome.storage.local.get(keys, (stored) => {
			const error = chrome.runtime.lastError;
			if (error) reject(new Error(error.message));
			else resolve(stored as Record<string, unknown>);
		});
	});
}

function storageSet(values: Record<string, unknown>): Promise<void> {
	return new Promise((resolve, reject) => {
		chrome.storage.local.set(values, () => {
			const error = chrome.runtime.lastError;
			if (error) reject(new Error(error.message));
			else resolve();
		});
	});
}

function createRequestSignal(
	timeoutMs: number,
	external: AbortSignal
): { signal: AbortSignal; release: () => void } {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const forward = () => controller.abort();
	if (external.aborted) controller.abort();
	else external.addEventListener('abort', forward);
	return {
		signal: controller.signal,
		release() {
			clearTimeout(timer);
			external.removeEventListener('abort', forward);
		},
	};
}

async function fetchReachable(
	url: string,
	method: 'HEAD' | 'GET',
	external: AbortSignal
): Promise<Response> {
	const request = createRequestSignal(REQUEST_TIMEOUT_MS, external);
	try {
		return await fetch(url, {
			method,
			redirect: 'follow',
			credentials: 'omit',
			signal: request.signal,
		});
	} finally {
		request.release();
	}
}

function decodeEntities(input: string): string {
	return input
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, ' ')
		.replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) =>
			String.fromCodePoint(parseInt(hex, 16))
		)
		.replace(/&#(\d+);/g, (_m, dec: string) =>
			String.fromCodePoint(Number(dec))
		);
}

async function tryExtractTitle(
	url: string,
	external: AbortSignal
): Promise<string | undefined> {
	if (external.aborted) throw new AuditCancelledError();
	const request = createRequestSignal(REQUEST_TIMEOUT_MS, external);
	try {
		const res = await fetch(url, {
			redirect: 'follow',
			credentials: 'omit',
			signal: request.signal,
		});
		if (!res.ok || !res.body) return undefined;
		const contentType = res.headers.get('content-type') ?? '';
		if (!/text\/html|application\/xhtml/i.test(contentType)) return undefined;

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		let total = 0;
		try {
			while (total < TITLE_READ_LIMIT) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				total += value.byteLength;
			}
		} finally {
			reader.cancel().catch(() => {});
		}

		const match = buffer.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
		if (!match) return undefined;
		return decodeEntities(match[1]).replace(/\s+/g, ' ').trim();
	} catch {
		if (external.aborted) throw new AuditCancelledError();
		return undefined;
	} finally {
		request.release();
	}
}

function normalizeTitle(title: string): string {
	return title.toLowerCase().replace(/\s+/g, ' ').trim();
}

function tokenSimilarity(a: string, b: string): number {
	const tokensA = new Set(a.split(' ').filter(Boolean));
	const tokensB = new Set(b.split(' ').filter(Boolean));
	if (tokensA.size === 0 || tokensB.size === 0) return 0;
	let shared = 0;
	for (const token of tokensA) if (tokensB.has(token)) shared += 1;
	return (2 * shared) / (tokensA.size + tokensB.size);
}

function titlesMatch(saved: string, actual: string): boolean {
	const a = normalizeTitle(saved);
	const b = normalizeTitle(actual);
	if (a === b) return true;
	if (a.length >= 3 && a.length * 2 >= b.length && b.includes(a)) return true;
	if (b.length >= 3 && b.length * 2 >= a.length && a.includes(b)) return true;
	// Same site, different page/login titles: compare word overlap so a
	// page like "Iniciar Sesión - Mi Empresa" is not flagged as outdated.
	return tokenSimilarity(a, b) >= 0.6;
}

async function checkUrl(
	bookmark: FlatBookmark,
	external: AbortSignal
): Promise<BookmarkCheck> {
	const url = bookmark.url as string;
	const base: BookmarkCheck = {
		id: bookmark.id,
		title: bookmark.title,
		url,
		status: 'broken',
	};

	let response: Response;
	try {
		try {
			response = await fetchReachable(url, 'HEAD', external);
		} catch {
			if (external.aborted) throw new AuditCancelledError();
			response = await fetchReachable(url, 'GET', external);
		}
	} catch (err) {
		if (external.aborted) throw new AuditCancelledError();
		const note =
			err instanceof Error && err.name === 'AbortError'
				? 'Response timeout — may still be alive'
				: 'Unreachable (network error) — may still be alive';
		return { ...base, status: 'suspicious', note };
	}

	// Plenty of servers and CDNs reject HEAD, so confirm with a real GET
	// before considering the link dead.
	if (METHOD_RETRY_STATUS.has(response.status)) {
		try {
			response = await fetchReachable(url, 'GET', external);
		} catch {
			if (external.aborted) throw new AuditCancelledError();
		}
	}

	base.httpStatus = response.status;

	if (response.status >= 200 && response.status < 300) {
		if (bookmark.title.trim() === '') {
			return {
				...base,
				status: 'untitled',
				note: 'Bookmark has no title (icon only)',
			};
		}
		const actualTitle = await tryExtractTitle(url, external);
		if (
			actualTitle !== undefined &&
			!titlesMatch(bookmark.title, actualTitle)
		) {
			return { ...base, status: 'suspicious', actualTitle };
		}
		return { ...base, status: 'active' };
	}

	// Only conclusive codes mean "the page is gone". Everything else is
	// reported as suspicious so real broken links stay trustworthy.
	if (response.status === 401 || response.status === 403 || response.status === 429) {
		return { ...base, status: 'suspicious', note: `Access restricted (HTTP ${response.status})` };
	}
	if (response.status >= 500) {
		return { ...base, status: 'suspicious', note: `Server error (HTTP ${response.status})` };
	}
	if (METHOD_RETRY_STATUS.has(response.status)) {
		return {
			...base,
			status: 'suspicious',
			note: `Method not allowed (HTTP ${response.status})`,
		};
	}

	return { ...base, status: 'broken', note: `HTTP ${response.status}` };
}

async function mapWithConcurrency<T>(
	items: T[],
	limit: number,
	worker: (item: T) => Promise<void>
): Promise<void> {
	let cursor = 0;
	const runner = async () => {
		while (cursor < items.length) {
			const index = cursor++;
			await worker(items[index]);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, runner)
	);
}

async function runAuditCore(signal: AbortSignal): Promise<AuditOutcome> {
	const startedAt = performance.now();
	const tree = await getBookmarkTree();
	const bookmarks = flattenTree(tree).filter(
		(b): b is FlatBookmark & { url: string } => Boolean(b.url)
	);

	const httpBookmarks = bookmarks.filter((b) => isHttpUrl(b.url));
	const skipped = bookmarks
		.filter((b) => !isHttpUrl(b.url))
		.map<BookmarkCheck>((b) => ({
			id: b.id,
			title: b.title,
			url: b.url,
			status: 'skipped',
			note: 'Non-http URL',
		}));

	const results: BookmarkCheck[] = [...skipped];
	let checked = skipped.length;
	const total = bookmarks.length;

	const runningProgress: AuditProgress = {
		running: true,
		checked,
		total,
	};
	showRunning(runningProgress);
	await storageSet({ [STORAGE_KEY_PROGRESS]: runningProgress });

	let cancelled = false;
	try {
		await mapWithConcurrency(httpBookmarks, MAX_CONCURRENCY, async (bookmark) => {
			if (signal.aborted) throw new AuditCancelledError();
			results.push(await checkUrl(bookmark, signal));
			checked += 1;
			if (checked % 5 === 0 || checked === total) {
				const progress: AuditProgress = { running: true, checked, total };
				showRunning(progress);
				await storageSet({ [STORAGE_KEY_PROGRESS]: progress });
			}
		});
	} catch (error) {
		if (!(error instanceof AuditCancelledError)) throw error;
		cancelled = true;
	}

	const all = results;
	const summary: AuditSummary = {
		total: all.length,
		active: all.filter((r) => r.status === 'active').length,
		broken: all.filter((r) => r.status === 'broken').length,
		suspicious: all.filter((r) => r.status === 'suspicious').length,
		skipped: all.filter((r) => r.status === 'skipped').length,
		untitled: all.filter((r) => r.status === 'untitled').length,
		checkedAt: Date.now(),
		durationMs: Math.round(performance.now() - startedAt),
		cancelled,
	};

	const finalProgress: AuditProgress = {
		running: false,
		checked: all.length,
		total,
	};
	if (cancelled) finalProgress.error = CANCELLED_MESSAGE;

	await storageSet({
		[STORAGE_KEY_ITEMS]: all,
		[STORAGE_KEY_SUMMARY]: summary,
		[STORAGE_KEY_PROGRESS]: finalProgress,
	});
	if (cancelled) showCancelled(summary);
	else showFinished(summary);

	return { summary, cancelled };
}

async function resetStaleProgress(): Promise<void> {
	try {
		const stored = await storageGet([STORAGE_KEY_PROGRESS]);
		const progress = stored[STORAGE_KEY_PROGRESS] as
			| AuditProgress
			| undefined;
		if (progress?.running) {
			await storageSet({
				[STORAGE_KEY_PROGRESS]: {
					running: false,
					checked: 0,
					total: 0,
					error: 'The previous audit was interrupted. Run it again.',
				},
			});
		}
	} catch {
		return;
	}
}

const startupReady = resetStaleProgress();

async function syncActionState(): Promise<void> {
	try {
		const stored = await storageGet([STORAGE_KEY_PROGRESS, STORAGE_KEY_SUMMARY]);
		const progress = (stored[STORAGE_KEY_PROGRESS] as AuditProgress | undefined) ??
			IDLE_PROGRESS;
		const summary = stored[STORAGE_KEY_SUMMARY] as AuditSummary | undefined;
		if (progress.running) showRunning(progress);
		else if (summary?.cancelled) showCancelled(summary);
		else if (progress.error) showInterrupted(progress.error);
		else if (summary) showFinished(summary);
		else showIdle();
	} catch {
		showIdle();
	}
}

chrome.storage.onChanged.addListener((changes) => {
	if (!changes[STORAGE_KEY_PROGRESS] && !changes[STORAGE_KEY_SUMMARY]) return;
	void startupReady.then(syncActionState);
});

void startupReady.then(syncActionState);

chrome.runtime.onInstalled.addListener(() => {
	void startupReady
		.then(() => storageSet({ [STORAGE_KEY_PROGRESS]: IDLE_PROGRESS }))
		.then(() => showIdle())
		.catch(() => {});
});

chrome.runtime.onMessage.addListener(
	(
		message: AuditRequest | AuditStatusRequest | AuditCancelRequest,
		_sender,
		sendResponse: (
			response: AuditResponse | AuditStatusResponse | AuditCancelResponse
		) => void
	) => {
		if (message?.type === MESSAGE_AUDIT_STATUS) {
			void (async () => {
				await startupReady;
				try {
					const stored = await storageGet([STORAGE_KEY_PROGRESS]);
					const progress = (stored[STORAGE_KEY_PROGRESS] as
						| AuditProgress
						| undefined) ?? IDLE_PROGRESS;
					sendResponse({ running, progress } satisfies AuditStatusResponse);
				} catch {
					sendResponse({ running, progress: IDLE_PROGRESS });
				}
			})();
			return true;
		}

		if (message?.type === MESSAGE_AUDIT_CANCEL) {
			void (async () => {
				await startupReady;
				if (!activeRun) {
					sendResponse({
						ok: true,
						cancelled: false,
						error: 'No audit is running.',
					} satisfies AuditCancelResponse);
					return;
				}
				activeRun.abort();
				sendResponse({ ok: true, cancelled: true } satisfies AuditCancelResponse);
			})();
			return true;
		}

		if (message?.type !== MESSAGE_AUDIT_RUN) return undefined;

		void (async () => {
			await startupReady;
			if (running) {
				sendResponse({
					ok: false,
					error: 'An audit is already running.',
				} satisfies AuditResponse);
				return;
			}

			running = true;
			const controller = new AbortController();
			activeRun = controller;
			try {
				const { summary, cancelled } = await runAuditCore(controller.signal);
				sendResponse({ ok: true, summary, cancelled } satisfies AuditResponse);
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				showInterrupted(errorMessage);
				await storageSet({
					[STORAGE_KEY_PROGRESS]: {
						running: false,
						checked: 0,
						total: 0,
						error: errorMessage,
					},
				}).catch(() => {});
				sendResponse({ ok: false, error: errorMessage } satisfies AuditResponse);
			} finally {
				running = false;
				activeRun = null;
			}
		})();

		return true;
	}
);
