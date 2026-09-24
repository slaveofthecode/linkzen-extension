import type {
	AuditRequest,
	AuditResponse,
	AuditSummary,
	BookmarkCheck,
} from '../types';
import {
	MESSAGE_AUDIT_RUN,
	STORAGE_KEY_ITEMS,
	STORAGE_KEY_PROGRESS,
	STORAGE_KEY_SUMMARY,
} from '../types';

const MAX_CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 5000;
const TITLE_READ_LIMIT = 200_000;

interface FlatBookmark {
	id: string;
	title: string;
	url?: string;
}

let running = false;

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

function storageSet(values: Record<string, unknown>): Promise<void> {
	return new Promise((resolve) => chrome.storage.local.set(values, resolve));
}

function fetchReachable(
	url: string,
	method: 'HEAD' | 'GET'
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		return fetch(url, {
			method,
			redirect: 'follow',
			credentials: 'omit',
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timer);
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

async function tryExtractTitle(url: string): Promise<string | undefined> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			redirect: 'follow',
			credentials: 'omit',
			signal: controller.signal,
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
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

function normalizeTitle(title: string): string {
	return title.toLowerCase().replace(/\s+/g, ' ').trim();
}

function titlesMatch(saved: string, actual: string): boolean {
	const a = normalizeTitle(saved);
	const b = normalizeTitle(actual);
	if (a === b) return true;
	if (a.length >= 3 && a.length * 2 >= b.length && b.includes(a)) return true;
	if (b.length >= 3 && b.length * 2 >= a.length && a.includes(b)) return true;
	return false;
}

async function checkUrl(bookmark: FlatBookmark): Promise<BookmarkCheck> {
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
			response = await fetchReachable(url, 'HEAD');
		} catch {
			response = await fetchReachable(url, 'GET');
		}
	} catch (err) {
		const note =
			err instanceof Error && err.name === 'AbortError'
				? 'Response timeout'
				: 'Network failure';
		return { ...base, note };
	}

	base.httpStatus = response.status;

	if (response.status >= 200 && response.status < 300) {
		const actualTitle = await tryExtractTitle(url);
		if (
			actualTitle !== undefined &&
			!titlesMatch(bookmark.title, actualTitle)
		) {
			return { ...base, status: 'suspicious', actualTitle };
		}
		return { ...base, status: 'active' };
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

async function runAuditCore(): Promise<AuditSummary> {
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

	const results: BookmarkCheck[] = [];
	let checked = 0;

	await storageSet({
		[STORAGE_KEY_PROGRESS]: {
			running: true,
			checked: 0,
			total: httpBookmarks.length,
		},
	});

	await mapWithConcurrency(httpBookmarks, MAX_CONCURRENCY, async (bookmark) => {
		results.push(await checkUrl(bookmark));
		checked += 1;
		if (checked % 5 === 0 || checked === httpBookmarks.length) {
			await storageSet({
				[STORAGE_KEY_PROGRESS]: {
					running: true,
					checked,
					total: httpBookmarks.length,
				},
			});
		}
	});

	const all = [...results, ...skipped];
	const summary: AuditSummary = {
		total: all.length,
		active: all.filter((r) => r.status === 'active').length,
		broken: all.filter((r) => r.status === 'broken').length,
		suspicious: all.filter((r) => r.status === 'suspicious').length,
		skipped: all.filter((r) => r.status === 'skipped').length,
		checkedAt: Date.now(),
		durationMs: Math.round(performance.now() - startedAt),
	};

	await storageSet({
		[STORAGE_KEY_ITEMS]: all,
		[STORAGE_KEY_SUMMARY]: summary,
		[STORAGE_KEY_PROGRESS]: {
			running: false,
			checked: all.length,
			total: all.length,
		},
	});

	return summary;
}

chrome.runtime.onMessage.addListener(
	(
		message: AuditRequest,
		_sender,
		sendResponse: (response: AuditResponse) => void
	) => {
		if (message?.type !== MESSAGE_AUDIT_RUN) return undefined;

		if (running) {
			sendResponse({
				ok: false,
				error: 'An audit is already running.',
			} satisfies AuditResponse);
			return undefined;
		}

		running = true;
		runAuditCore()
			.then((summary) =>
				sendResponse({ ok: true, summary } satisfies AuditResponse)
			)
			.catch((error) =>
				sendResponse({
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				} satisfies AuditResponse)
			)
			.finally(() => {
				running = false;
			});

		return true;
	}
);
