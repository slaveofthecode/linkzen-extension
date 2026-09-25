import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import '../index.css';
import '../chromeMock';
import type {
	AuditCancelRequest,
	AuditCancelResponse,
	AuditProgress,
	AuditRequest,
	AuditResponse,
	AuditStatusRequest,
	AuditStatusResponse,
	AuditSummary,
	QuickLink,
} from '../types';
import {
	MESSAGE_AUDIT_CANCEL,
	MESSAGE_AUDIT_RUN,
	MESSAGE_AUDIT_STATUS,
	STORAGE_KEY_LINKS,
	STORAGE_KEY_PROGRESS,
	STORAGE_KEY_SUMMARY,
} from '../types';
import { LastRunInfo } from '../components/LastRunInfo';

const IDLE_PROGRESS: AuditProgress = { running: false, checked: 0, total: 0 };

const MAX_LINKS = 15;

const INITIAL_LINKS: QuickLink[] = [
	{ id: 'youtube', title: 'YouTube', url: 'https://youtube.com' },
	{ id: 'spotify', title: 'Spotify', url: 'https://spotify.com' },
	{ id: 'notion', title: 'Notion', url: 'https://notion.so' },
	{ id: 'github', title: 'GitHub', url: 'https://github.com' },
];

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

function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

function isQuickLink(value: unknown): value is QuickLink {
	if (!value || typeof value !== 'object') return false;
	const link = value as Partial<QuickLink>;
	return (
		typeof link.id === 'string' &&
		typeof link.title === 'string' &&
		typeof link.url === 'string'
	);
}

function normalizeUrl(value: string): string | null {
	try {
		const url = new URL(value.trim());
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
		return url.href;
	} catch {
		return null;
	}
}

function urlKey(value: string): string | null {
	const normalized = normalizeUrl(value);
	if (!normalized) return null;
	const url = new URL(normalized);
	const host = url.hostname.replace(/^www\./i, '').toLowerCase();
	const path = url.pathname.replace(/\/+$/, '');
	return `${host}${path}${url.search}`;
}

function createLinkId(): string {
	return typeof crypto.randomUUID === 'function'
		? crypto.randomUUID()
		: `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getFaviconUrl(url: string): string {
	try {
		return new URL('/favicon.ico', url).toString();
	} catch {
		return '';
	}
}

function getLinkInitial(link: QuickLink): string {
	return link.title.trim().charAt(0).toUpperCase() || '↗';
}

function titleFromUrl(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, '') || 'Link';
	} catch {
		return 'Link';
	}
}

interface LinkFaviconProps {
	link: QuickLink;
	className?: string;
}

function LinkFavicon({ link, className = '' }: LinkFaviconProps) {
	const [faviconState, setFaviconState] = useState({
		url: link.url,
		failed: false,
	});
	const faviconUrl = getFaviconUrl(link.url);
	const failed = faviconState.url === link.url && faviconState.failed;

	if (failed || !faviconUrl) {
		return (
			<span
				aria-hidden="true"
				className={`flex items-center justify-center text-[10px] font-bold text-slate-300 ${className}`}
			>
				{getLinkInitial(link)}
			</span>
		);
	}

	return (
		<img
			src={faviconUrl}
			alt=""
			aria-hidden="true"
			className={`object-contain ${className}`}
			onError={() => setFaviconState({ url: link.url, failed: true })}
		/>
	);
}

function PopupApp() {
	const [links, setLinks] = useState<QuickLink[]>(INITIAL_LINKS);
	const [progress, setProgress] = useState<AuditProgress>(IDLE_PROGRESS);
	const [summary, setSummary] = useState<AuditSummary | null>(null);
	const [runError, setRunError] = useState<string | null>(null);
	const [linkError, setLinkError] = useState<string | null>(null);
	const [panelOpen, setPanelOpen] = useState(false);
	const [draftLinks, setDraftLinks] = useState<QuickLink[]>([]);
	const [cancelling, setCancelling] = useState(false);
	const [confirmCancel, setConfirmCancel] = useState(false);

	const isRunning = progress.running;
	const issues = summary ? summary.broken + summary.suspicious : 0;
	const progressPercent = progress.total
		? Math.min(100, Math.round((progress.checked / progress.total) * 100))
		: 0;
	const auditStatus = isRunning
		? 'Running'
		: progress.error
			? 'Interrupted'
			: summary
				? 'Complete'
				: 'Not started';
	const analyzedLabel = isRunning
		? `${progress.checked} / ${progress.total}`
		: summary
			? `${summary.total} links`
			: '—';
	const pendingLinks = Math.max(progress.total - progress.checked, 0);
	const busy = isRunning || cancelling;

	useEffect(() => {
		let active = true;

		const load = async () => {
			try {
				const stored = await storageGet([
					STORAGE_KEY_LINKS,
					STORAGE_KEY_PROGRESS,
					STORAGE_KEY_SUMMARY,
				]);
				if (!active) return;

				const storedProgress = stored[STORAGE_KEY_PROGRESS] as
					| AuditProgress
					| undefined;
				const storedSummary = stored[STORAGE_KEY_SUMMARY] as
					| AuditSummary
					| undefined;
				const storedLinks = stored[STORAGE_KEY_LINKS];

				if (storedProgress) setProgress(storedProgress);
				if (storedSummary) setSummary(storedSummary);

				if (Array.isArray(storedLinks)) {
					setLinks(storedLinks.filter(isQuickLink));
				} else {
					setLinks(INITIAL_LINKS);
					await storageSet({ [STORAGE_KEY_LINKS]: INITIAL_LINKS });
				}
			} catch (error) {
				if (active) {
					setLinkError(
						errorMessage(error, 'Could not load the saved links.')
					);
				}
			}

			if (!active) return;
			const request: AuditStatusRequest = { type: MESSAGE_AUDIT_STATUS };
			chrome.runtime.sendMessage(
				request,
				(response: AuditStatusResponse | undefined) => {
					if (!active || chrome.runtime.lastError || !response) return;
					setProgress({ ...response.progress, running: response.running });
				}
			);
		};

		void load();

		const onStorageChanged = (
			changes: Record<string, chrome.storage.StorageChange>
		) => {
			if (changes[STORAGE_KEY_LINKS]) {
				const nextLinks = changes[STORAGE_KEY_LINKS].newValue;
				if (Array.isArray(nextLinks)) {
					setLinks(nextLinks.filter(isQuickLink));
				}
			}
			if (changes[STORAGE_KEY_PROGRESS]) {
				setProgress(
					(changes[STORAGE_KEY_PROGRESS].newValue as
						| AuditProgress
						| undefined) ?? IDLE_PROGRESS
				);
			}
			if (changes[STORAGE_KEY_SUMMARY]) {
				setSummary(
					(changes[STORAGE_KEY_SUMMARY].newValue as
						| AuditSummary
						| undefined) ?? null
				);
			}
		};

		chrome.storage.onChanged.addListener(onStorageChanged);
		return () => {
			active = false;
			chrome.storage.onChanged.removeListener(onStorageChanged);
		};
	}, []);

	const commitLinks = async (nextLinks: QuickLink[]): Promise<boolean> => {
		setLinkError(null);
		try {
			await storageSet({ [STORAGE_KEY_LINKS]: nextLinks });
			setLinks(nextLinks);
			return true;
		} catch (error) {
			setLinkError(errorMessage(error, 'Could not save the links.'));
			return false;
		}
	};

	const openPanel = () => {
		setLinkError(null);
		setDraftLinks(links.map((link) => ({ ...link })));
		setPanelOpen(true);
	};

	const closePanel = () => {
		setPanelOpen(false);
		setDraftLinks([]);
		setLinkError(null);
	};

	const updateDraftLink = (id: string, url: string) => {
		setDraftLinks((current) =>
			current.map((link) => (link.id === id ? { ...link, url } : link))
		);
	};

	const addDraftLink = () => {
		setDraftLinks((current) => {
			if (current.length >= MAX_LINKS) return current;
			return [...current, { id: createLinkId(), title: '', url: '' }];
		});
	};

	const removeDraftLink = (id: string) => {
		setDraftLinks((current) => current.filter((link) => link.id !== id));
	};

	const saveDraftLinks = async () => {
		const nextLinks: QuickLink[] = [];
		const seen = new Map<string, string>();
		for (const link of draftLinks) {
			if (!link.url.trim()) continue;
			const url = normalizeUrl(link.url);
			if (!url) {
				setLinkError(`${link.url.trim()} is not a valid http(s) URL.`);
				return;
			}
			const key = urlKey(url);
			const duplicateOf = key ? seen.get(key) : undefined;
			if (key && duplicateOf) {
				setLinkError(
					`${url} is already in the list (${duplicateOf}). Change or remove it.`
				);
				return;
			}
			if (key) seen.set(key, link.title || url);
			nextLinks.push({
				...link,
				url,
				title: link.title.trim() || titleFromUrl(url),
			});
		}
		if (nextLinks.length > MAX_LINKS) {
			setLinkError(`You can save up to ${MAX_LINKS} links.`);
			return;
		}
		if (await commitLinks(nextLinks)) closePanel();
	};

	const handleRunAudit = () => {
		setRunError(null);
		setConfirmCancel(false);
		setCancelling(false);
		const request: AuditRequest = { type: MESSAGE_AUDIT_RUN };
		chrome.runtime.sendMessage(
			request,
			(response: AuditResponse | undefined) => {
				if (chrome.runtime.lastError) {
					const message =
						chrome.runtime.lastError.message ??
						'No response from the background service worker.';
					setRunError(message);
					setProgress((current) => ({ ...current, running: false, error: message }));
					return;
				}
				if (!response) {
					setRunError('No response from the background service worker.');
					setProgress((current) => ({
						...current,
						running: false,
						error: 'No response from the background service worker.',
					}));
					return;
				}
				if (response.ok === false) {
					setRunError(response.error);
					setProgress((current) => ({
						...current,
						running: false,
						error: response.error,
					}));
					return;
				}
				setSummary(response.summary);
			}
		);
	};

	const requestCancelAudit = () => {
		if (cancelling) return;
		setConfirmCancel(true);
	};

	const dismissCancelConfirm = () => {
		setConfirmCancel(false);
	};

	const handleCancelAudit = () => {
		setConfirmCancel(false);
		setCancelling(true);
		const request: AuditCancelRequest = { type: MESSAGE_AUDIT_CANCEL };
		chrome.runtime.sendMessage(
			request,
			(response: AuditCancelResponse | undefined) => {
				setCancelling(false);
				if (chrome.runtime.lastError) {
					setRunError(
						chrome.runtime.lastError.message ??
							'No response from the background service worker.'
					);
					return;
				}
				if (!response?.cancelled) {
					setRunError(response?.error ?? 'No audit is running.');
				}
			}
		);
	};

	const handleOpenDashboard = () => {
		chrome.tabs.create({
			url: chrome.runtime.getURL('src/dashboard/index.html'),
		});
	};

	return (
		<div className="w-[380px] max-w-full bg-slate-900 text-slate-100 font-sans">
			<div className="max-h-[600px] overflow-y-auto p-4">
				<div className="flex items-center justify-between pb-3 border-b border-slate-800">
					<div className="flex items-center space-x-2">
						<span className="text-xl">🔗</span>
						<h1 className="font-bold text-base tracking-wide">LinkZen</h1>
					</div>
					<span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700">
						v1.0.0
					</span>
				</div>

				<div className="mt-4">
					<div className="flex items-center justify-between mb-2">
						<h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
							Key Access
						</h2>
						<span className="text-[11px] text-slate-500">
							{links.length} / {MAX_LINKS} links
						</span>
					</div>
					<div className="grid grid-cols-6 gap-2">
						{links.map((link) => (
							<a
								key={link.id}
								href={link.url}
								target="_blank"
								rel="noopener noreferrer"
								className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-700 bg-slate-800/80 transition-all hover:scale-105 hover:border-indigo-400/60"
								title={link.title}
							>
								<LinkFavicon link={link} className="h-4 w-4" />
								<span className="sr-only">{link.title}</span>
							</a>
						))}
						<button
							type="button"
							onClick={openPanel}
							disabled={busy}
							className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-xl border border-dashed border-slate-600 text-base leading-none text-slate-400 transition-all hover:border-indigo-400/60 hover:text-indigo-300 disabled:cursor-not-allowed disabled:opacity-40"
							title={busy ? 'Not available while the audit is running' : 'Manage links'}
							aria-label="Manage links"
						>
							<span aria-hidden="true">…</span>
						</button>
					</div>
					<p className="mt-2 text-[10px] text-slate-600">
						Use … to add, edit or remove links. Up to {MAX_LINKS} links.
					</p>
				</div>

				{panelOpen && (
					<div className="mt-4 rounded-xl border border-slate-700 bg-slate-800/50 p-3">
						<div className="flex items-center justify-between">
							<h2 className="text-xs font-semibold text-slate-200">Manage links</h2>
							<span className="text-[11px] text-slate-500">
								{draftLinks.length} / {MAX_LINKS}
							</span>
						</div>

						<div className="mt-2 max-h-52 space-y-1.5 overflow-y-auto">
							{draftLinks.length === 0 ? (
								<p className="py-3 text-center text-[11px] text-slate-500">
									No links yet. Add one below.
								</p>
							) : (
								draftLinks.map((link) => (
									<div key={link.id} className="flex items-center gap-2">
										<LinkFavicon link={link} className="h-4 w-4 shrink-0" />
										<input
											value={link.url}
											onChange={(event) =>
												updateDraftLink(link.id, event.target.value)
											}
											aria-label={`URL for ${link.title || 'new link'}`}
											placeholder="https://example.com"
											className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-100 outline-none focus:border-indigo-400"
										/>
										<button
											type="button"
											onClick={() => removeDraftLink(link.id)}
											className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-xs text-red-300 hover:bg-red-500/20"
											aria-label={`Remove ${link.title || 'link'}`}
											title="Remove link"
										>
											<span aria-hidden="true">×</span>
										</button>
									</div>
								))
							)}
						</div>

						{linkError && (
							<p className="mt-2 text-[11px] text-red-400">{linkError}</p>
						)}

						<div className="mt-2 flex items-center justify-between gap-2">
							<button
								type="button"
								onClick={addDraftLink}
								disabled={draftLinks.length >= MAX_LINKS}
								aria-label="Add link"
								title={
									draftLinks.length >= MAX_LINKS
										? `Maximum of ${MAX_LINKS} links`
										: 'Add link'
								}
								className="flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2 text-[11px] font-medium text-emerald-300 transition-all hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
							>
								<span aria-hidden="true">+</span>
								Add
							</button>
							<div className="flex items-center gap-2">
								<button
									type="button"
									onClick={closePanel}
									aria-label="Cancel changes"
									title="Cancel"
									className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg border border-slate-700 text-xs text-slate-300 transition-all hover:bg-slate-700"
								>
									<span aria-hidden="true">✕</span>
								</button>
								<button
									type="button"
									onClick={() => void saveDraftLinks()}
									aria-label="Save changes"
									title="Save"
									className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg bg-indigo-600 text-xs font-medium text-white transition-all hover:bg-indigo-500"
								>
									<span aria-hidden="true">✓</span>
								</button>
							</div>
						</div>
					</div>
				)}

				<div className="mt-5 p-3 rounded-xl bg-slate-800/50 border border-slate-800">
					<div className="flex items-center justify-between">
						<h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
							Bookmarks audit
						</h2>
						<span className="text-[11px] text-slate-500">{auditStatus}</span>
					</div>
					<div className="mt-3 flex items-center justify-between text-sm">
						<span className="text-slate-300">Analyzed links</span>
						<span className="font-semibold text-slate-100">{analyzedLabel}</span>
					</div>
					{isRunning && (
						<div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-800">
							<div
								className="h-full rounded-full bg-linear-to-r from-indigo-500 to-sky-400 transition-all duration-300"
								style={{ width: `${progressPercent}%` }}
							/>
						</div>
					)}
					{summary && (
						<LastRunInfo
							summary={summary}
							placement="above"
							className="mt-1.5 text-[11px] text-slate-500"
						/>
					)}
					{issues > 0 && !isRunning && (
						<div className="mt-2 flex items-center space-x-1.5 text-amber-400 text-xs font-medium">
							<span>⚠️</span>
							<span>{issues} broken or suspicious links detected</span>
						</div>
					)}
					{progress.error && (
						<p className="mt-2 text-[11px] text-amber-300">{progress.error}</p>
					)}
					{runError && <p className="mt-2 text-xs text-red-400">{runError}</p>}
					{linkError && !panelOpen && (
						<p className="mt-2 text-xs text-red-400">{linkError}</p>
					)}
					{isRunning && confirmCancel && (
						<div className="mt-2 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2">
							<p className="flex-1 text-[11px] leading-tight text-amber-200">
								Stop the audit? {pendingLinks} link{pendingLinks === 1 ? '' : 's'} left
								unchecked.
							</p>
							<button
								type="button"
								onClick={dismissCancelConfirm}
								aria-label="Keep auditing"
								title="Keep auditing"
								className="shrink-0 cursor-pointer rounded-md border border-slate-600 px-2 py-1 text-[11px] text-slate-300 transition-all hover:bg-slate-700"
							>
								Keep going
							</button>
							<button
								type="button"
								onClick={handleCancelAudit}
								disabled={cancelling}
								aria-label="Confirm stop audit"
								title={cancelling ? 'Stopping…' : 'Stop audit'}
								className="shrink-0 cursor-pointer rounded-md bg-red-500/80 px-2 py-1 text-[11px] font-medium text-white transition-all hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50"
							>
								{cancelling ? 'Stopping…' : 'Stop'}
							</button>
						</div>
					)}
					<div className="mt-3 flex items-start">
						<button
							type="button"
							onClick={handleRunAudit}
							disabled={busy}
							className="flex-1 cursor-pointer rounded-lg bg-slate-700/60 py-2 text-xs font-medium text-slate-100 transition-all hover:bg-slate-700 disabled:cursor-not-allowed cursor-pointer"
						>
							{isRunning ? (
								<span className="animate-pulse text-indigo-200">Auditing…</span>
							) : (
								'▶ Run audit'
							)}
						</button>
						{isRunning && (
							<button
								type="button"
								onClick={requestCancelAudit}
								disabled={cancelling}
								aria-label="Cancel audit"
								title={cancelling ? 'Cancelling…' : 'Cancel audit'}
								className="ml-2 flex h-[30px] w-[30px] shrink-0 cursor-pointer items-center justify-center rounded-lg border border-red-500/40 bg-red-500/10 text-xs text-red-300 transition-all hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
							>
								<span aria-hidden="true">✕</span>
							</button>
						)}
					</div>
				</div>

				<div className="mt-4">
					<button
						type="button"
						onClick={handleOpenDashboard}
						disabled={busy}
						className="flex w-full cursor-pointer items-center justify-center space-x-2 rounded-xl bg-linear-to-r from-blue-600 to-indigo-600 px-4 py-2.5 text-sm font-medium text-white shadow-md transition-all hover:from-blue-500 hover:to-indigo-500 active:scale-98 disabled:cursor-not-allowed disabled:opacity-50"
					>
						<span>📊</span>
						<span>Dashboard</span>
					</button>
				</div>
			</div>
		</div>
	);
}

ReactDOM.createRoot(document.getElementById('root')!).render(
	<React.StrictMode>
		<PopupApp />
	</React.StrictMode>
);
