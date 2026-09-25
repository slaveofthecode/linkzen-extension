import React, { useEffect, useMemo, useState } from 'react';
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
import { LastRunInfo } from '../components/LastRunInfo';

type FilterKey = 'total' | 'broken' | 'suspicious' | 'untitled';

const STATUS_STYLES: Record<BookmarkCheck['status'], string> = {
	active: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
	broken: 'bg-red-500/15 text-red-300 border-red-500/30',
	suspicious: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
	skipped: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
	untitled: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
};

const STATUS_LABELS: Record<BookmarkCheck['status'], string> = {
	active: 'Healthy',
	broken: 'Broken',
	suspicious: 'Suspicious',
	skipped: 'Skipped',
	untitled: 'Icon only',
};

const FILTERS: { key: FilterKey; label: string; hint: string }[] = [
	{ key: 'total', label: 'Total', hint: 'Every audited link' },
	{ key: 'broken', label: 'Broken', hint: 'Page is really gone' },
	{ key: 'suspicious', label: 'Suspicious', hint: 'Needs a manual look' },
	{ key: 'untitled', label: 'Icon only', hint: 'Reachable but untitled' },
];

/** Color de cada filtro: el borde inferior marca cuál está aplicado */
const TILE_TONES: Record<FilterKey, { hex: string; tint: string }> = {
	total: { hex: '#818cf8', tint: 'bg-indigo-500/10' },
	broken: { hex: '#f87171', tint: 'bg-red-500/10' },
	suspicious: { hex: '#fbbf24', tint: 'bg-amber-500/10' },
	untitled: { hex: '#38bdf8', tint: 'bg-sky-500/10' },
};
const TILE_BORDER_IDLE = '#1e293b';
const TILE_BORDER_HOVER = '#64748b';

/**
 * Counts frozen at audit time (what the summary reported) next to the live
 * count derived from the current rows, so edits done after the audit are
 * visible without pretending the audit result itself changed.
 */
function CountDelta({
	baseline,
	live,
}: {
	baseline: number | null;
	live: number;
}) {
	if (baseline === null || baseline === live) {
		return (
			<span className="text-xs tabular-nums text-slate-300">
				{baseline ?? live}
			</span>
		);
	}
	const delta = live - baseline;
	return (
		<span
			className="flex items-center gap-1.5"
			title={`Audited: ${baseline} · right now: ${live}`}
		>
			<span className="text-xs tabular-nums text-slate-500 line-through decoration-slate-600">
				{baseline}
			</span>
			<span className="text-xs font-semibold tabular-nums text-slate-100">{live}</span>
			<span
				className={`rounded px-1 text-[10px] font-semibold tabular-nums ${
					delta < 0
						? 'bg-emerald-500/15 text-emerald-300'
						: 'bg-amber-500/15 text-amber-300'
				}`}
			>
				{delta > 0 ? `+${delta}` : delta}
			</span>
		</span>
	);
}

function bookmarksRemove(id: string): Promise<void> {
	return new Promise((resolve, reject) => {
		chrome.bookmarks.remove(id, () => {
			const err = chrome.runtime.lastError;
			if (err) reject(new Error(err.message));
			else resolve();
		});
	});
}

function bookmarksUpdate(
	id: string,
	title: string,
	url?: string,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const changes: { title: string; url?: string } = { title };
		if (url) changes.url = url;
		chrome.bookmarks.update(id, changes, () => {
			const err = chrome.runtime.lastError;
			if (err) reject(new Error(err.message));
			else resolve();
		});
	});
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

function buildIdToPath(
	tree: chrome.bookmarks.BookmarkTreeNode[],
): Map<string, string> {
	const paths = new Map<string, string>();
	const walk = (nodes: chrome.bookmarks.BookmarkTreeNode[], ancestors: string[]) => {
		for (const node of nodes) {
			const nodePath = [...ancestors, node.title];
			if (node.url) paths.set(node.id, nodePath.slice(0, -1).join(' / '));
			if (node.children && node.children.length > 0) walk(node.children, nodePath);
		}
	};
	walk(tree, []);
	return paths;
}

function DashboardApp() {
	const [items, setItems] = useState<BookmarkCheck[]>([]);
	const [summary, setSummary] = useState<AuditSummary | null>(null);
	const [progress, setProgress] = useState<AuditProgress>({
		running: false,
		checked: 0,
		total: 0,
	});
	const [filter, setFilter] = useState<FilterKey>('total');
	const [query, setQuery] = useState('');
	const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());
	const [idToPath, setIdToPath] = useState<Map<string, string>>(new Map());
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editingTitle, setEditingTitle] = useState('');
	const [editingUrl, setEditingUrl] = useState('');
	const [runError, setRunError] = useState<string | null>(null);
	const [cancelling, setCancelling] = useState(false);
	const [confirmCancel, setConfirmCancel] = useState(false);
	const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
	const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

	const isRunning = progress.running;
	const busy = isRunning || cancelling;
	// Every mutating control is frozen while a re-run rewrites the results.
	const actionsLocked = busy;
	const progressPercent = progress.total
		? Math.min(100, Math.round((progress.checked / progress.total) * 100))
		: 0;

	useEffect(() => {
		chrome.storage.local.get(
			[STORAGE_KEY_ITEMS, STORAGE_KEY_SUMMARY, STORAGE_KEY_PROGRESS],
			(stored) => {
				const storedItems = stored[STORAGE_KEY_ITEMS] as BookmarkCheck[] | undefined;
				if (storedItems) setItems(storedItems);
				const s = stored[STORAGE_KEY_SUMMARY] as AuditSummary | undefined;
				if (s) setSummary(s);
				const p = stored[STORAGE_KEY_PROGRESS] as AuditProgress | undefined;
				if (p) setProgress(p);
			}
		);

		const onStorageChanged = (
			changes: Record<string, chrome.storage.StorageChange>
		) => {
			if (changes[STORAGE_KEY_ITEMS]) {
				setItems(changes[STORAGE_KEY_ITEMS].newValue as BookmarkCheck[]);
			}
			if (changes[STORAGE_KEY_SUMMARY]) {
				setSummary(changes[STORAGE_KEY_SUMMARY].newValue as AuditSummary);
			}
			if (changes[STORAGE_KEY_PROGRESS]) {
				setProgress(changes[STORAGE_KEY_PROGRESS].newValue as AuditProgress);
			}
		};
		chrome.storage.onChanged.addListener(onStorageChanged);
		const statusRequest: AuditStatusRequest = { type: MESSAGE_AUDIT_STATUS };
		chrome.runtime.sendMessage(
			statusRequest,
			(response: AuditStatusResponse | undefined) => {
				if (chrome.runtime.lastError || !response) return;
				setProgress({ ...response.progress, running: response.running });
			}
		);
		return () => chrome.storage.onChanged.removeListener(onStorageChanged);
	}, []);

	useEffect(() => {
		getBookmarkTree()
			.then((tree) => setIdToPath(buildIdToPath(tree)))
			.catch(() => setIdToPath(new Map()));
	}, []);

	const filteredItems = useMemo(() => {
		if (filter === 'untitled') {
			return items.filter((item) => item.status === 'untitled');
		}
		if (filter === 'broken' || filter === 'suspicious') {
			return items.filter((item) => item.status === filter);
		}
		return items;
	}, [items, filter]);

	const searchTokens = useMemo(
		() => query.toLowerCase().split(/\s+/).filter(Boolean),
		[query]
	);

	// Todos los términos deben aparecer en título, URL o carpeta: "docs 2024"
	// acota por ambos a la vez.
	const visibleItems = useMemo(() => {
		if (searchTokens.length === 0) return filteredItems;
		return filteredItems.filter((item) => {
			const haystack = `${item.title} ${item.actualTitle ?? ''} ${item.url} ${
				idToPath.get(item.id) ?? ''
			}`.toLowerCase();
			return searchTokens.every((token) => haystack.includes(token));
		});
	}, [filteredItems, searchTokens, idToPath]);

	// Los conteos ignoran lo ya borrado: por eso un "Broken 102" puede caer a 100
	// sin que desaparezca la fila, que se queda colapsada.
	const liveItems = useMemo(
		() => items.filter((item) => !deletedIds.has(item.id)),
		[items, deletedIds]
	);

	const filterCounts = useMemo(() => {
		const counts: Record<FilterKey, number> = {
			total: liveItems.length,
			broken: 0,
			suspicious: 0,
			untitled: 0,
		};
		for (const item of liveItems) {
			if (item.status === 'broken') counts.broken++;
			if (item.status === 'suspicious') counts.suspicious++;
			if (item.status === 'untitled') counts.untitled++;
		}
		return counts;
	}, [liveItems]);

	const baselineCounts = useMemo<Record<FilterKey, number | null>>(() => {
		if (!summary) {
			return { total: null, broken: null, suspicious: null, untitled: null };
		}
		return {
			total: summary.total,
			broken: summary.broken,
			suspicious: summary.suspicious,
			untitled: summary.untitled ?? 0,
		};
	}, [summary]);

	const handleRunAudit = () => {
		setRunError(null);
		setCancelling(false);
		setConfirmCancel(false);
		const request: AuditRequest = { type: MESSAGE_AUDIT_RUN };
		chrome.runtime.sendMessage(
			request,
			(response: AuditResponse | undefined) => {
				if (chrome.runtime.lastError) {
					setRunError(
						chrome.runtime.lastError.message ??
							'No response from the background service worker.'
					);
					return;
				}
				if (!response) {
					setRunError('No response from the background service worker.');
					return;
				}
				if (response.ok === false) setRunError(response.error);
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

	const clearRowError = (id: string) => {
		setRowErrors((prev) => {
			if (!prev[id]) return prev;
			const next = { ...prev };
			delete next[id];
			return next;
		});
	};

	const markBusy = (id: string, busy: boolean) => {
		setBusyIds((prev) => {
			const next = new Set(prev);
			if (busy) next.add(id);
			else next.delete(id);
			return next;
		});
	};

	const handleDelete = async (item: BookmarkCheck) => {
		if (actionsLocked) return;
		clearRowError(item.id);
		markBusy(item.id, true);
		try {
			await bookmarksRemove(item.id);
			// La fila no desaparece: se marca como eliminada y deja de contar.
			setDeletedIds((prev) => {
				const next = new Set(prev);
				next.add(item.id);
				return next;
			});
			if (editingId === item.id) setEditingId(null);
		} catch (err) {
			setRowErrors((prev) => ({
				...prev,
				[item.id]: err instanceof Error ? err.message : String(err),
			}));
		} finally {
			markBusy(item.id, false);
		}
	};

	const startEditing = (item: BookmarkCheck) => {
		if (actionsLocked) return;
		setEditingId(item.id);
		setEditingTitle(item.actualTitle ?? item.title);
		setEditingUrl(item.url);
	};

	const handleSaveEdit = async (item: BookmarkCheck) => {
		// Un nombre vacío es válido: deja el bookmark sin texto en la barra.
		const title = editingTitle.trim();
		// En Broken/Suspicious la URL también es editable: es el arreglo típico.
		const canEditUrl = item.status === 'broken' || item.status === 'suspicious';
		const url = editingUrl.trim();
		const urlChanged = canEditUrl && url !== '' && url !== item.url;
		if (urlChanged && !/^https?:\/\/\S+$/i.test(url)) {
			setRowErrors((prev) => ({
				...prev,
				[item.id]: 'The URL must start with http:// or https://',
			}));
			return;
		}
		clearRowError(item.id);
		markBusy(item.id, true);
		try {
			await bookmarksUpdate(item.id, title, urlChanged ? url : undefined);
			// Un link roto sigue roto aunque le quites el nombre; al resto de
			// casos, vaciar el nombre lo deja como "icon only".
			const status: BookmarkCheck['status'] =
				item.status === 'broken' ? 'broken' : title ? 'active' : 'untitled';
			setItems((prev) =>
				prev.map((it) =>
					it.id === item.id
						? {
								...it,
								title,
								url: urlChanged ? url : it.url,
								status,
								actualTitle: undefined,
							}
						: it
				)
			);
			setEditingId(null);
		} catch (err) {
			setRowErrors((prev) => ({
				...prev,
				[item.id]: err instanceof Error ? err.message : String(err),
			}));
		} finally {
			markBusy(item.id, false);
		}
	};

	const deltasEnabled = !isRunning;
	// While a run is in flight the rows are being rewritten, so any difference
	// against the previous summary is progress, not a user edit.
	const activeChanged = deltasEnabled
		? FILTERS.some(
				({ key }) => baselineCounts[key] !== null && baselineCounts[key] !== filterCounts[key]
			)
		: false;

	return (
		<div className="min-h-screen bg-slate-900 text-slate-100 font-sans select-none">
			<div className="max-w-5xl mx-auto px-6 pb-8 text-left">
				<div className="sticky top-0 z-20 -mx-6 border-b border-slate-800 bg-slate-900/95 px-6 pt-4 pb-3 backdrop-blur-sm">
					<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
						<span className="text-lg">🔗</span>
						<h1 className="text-sm font-bold tracking-wide">LinkZen Dashboard</h1>

						<div className="ml-auto flex items-center gap-2">
							<LastRunInfo
								summary={summary}
								placement="below"
								className="text-[11px] text-slate-500"
							/>
							{isRunning && (
								<button
									onClick={requestCancelAudit}
									disabled={cancelling}
									aria-label="Cancel audit"
									title={cancelling ? 'Cancelling…' : 'Cancel audit'}
									className="flex h-7 w-7 items-center justify-center rounded-lg border border-red-500/40 bg-red-500/10 text-xs text-red-300 transition-all hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
								>
									<span aria-hidden="true">✕</span>
								</button>
							)}
							<button
								onClick={handleRunAudit}
								disabled={busy}
								className="min-w-[7.5rem] py-1.5 px-3 rounded-lg bg-slate-700/60 hover:bg-slate-700 text-slate-100 text-xs font-medium transition-all disabled:cursor-not-allowed cursor-pointer"
							>
								{isRunning ? (
									<span className="animate-pulse text-indigo-200">
										Auditing…
									</span>
								) : (
									'▶ Re-run audit'
								)}
							</button>
						</div>
					</div>

					{isRunning && (
						<div className="mt-2.5 flex items-center gap-2.5">
							<div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800">
								<div
									className="h-full rounded-full bg-linear-to-r from-indigo-500 to-sky-400 transition-all duration-300"
									style={{ width: `${progressPercent}%` }}
								/>
							</div>
							<span className="shrink-0 text-[11px] tabular-nums text-slate-400">
								{progress.checked} / {progress.total}
							</span>
						</div>
					)}

					{isRunning && confirmCancel && (
						<div className="mt-2.5 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
							<p className="flex-1 text-xs leading-tight text-amber-200">
								Stop the audit? {Math.max(progress.total - progress.checked, 0)} link
								{Math.max(progress.total - progress.checked, 0) === 1 ? '' : 's'} left
								unchecked.
							</p>
							<button
								type="button"
								onClick={dismissCancelConfirm}
								className="shrink-0 cursor-pointer rounded-md border border-slate-600 px-2.5 py-1 text-[11px] text-slate-300 transition-all hover:bg-slate-700"
							>
								Keep going
							</button>
							<button
								type="button"
								onClick={handleCancelAudit}
								disabled={cancelling}
								className="shrink-0 cursor-pointer rounded-md bg-red-500/80 px-2.5 py-1 text-[11px] font-medium text-white transition-all hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50"
							>
								{cancelling ? 'Stopping…' : 'Stop'}
							</button>
						</div>
					)}

					<div className="mt-2.5 flex flex-wrap gap-2">
						{FILTERS.map(({ key, label, hint }) => (
							<StatTile
								key={key}
								label={label}
								hint={hint}
								filterKey={key}
								active={filter === key}
								baseline={deltasEnabled ? baselineCounts[key] : null}
								live={filterCounts[key]}
								onSelect={setFilter}
							/>
						))}
						<StatTile
							label="Duration"
							value={
								summary ? `${(summary.durationMs / 1000).toFixed(1)}s` : '—'
							}
						/>
					</div>

					{activeChanged && (
						<p className="mt-1.5 text-[10px] text-slate-600">
							Struck value = last audit · bold = current
						</p>
					)}

					{actionsLocked && visibleItems.length > 0 && (
						<p className="mt-2.5 text-[11px] text-slate-500">
							Audit in progress — deleting and renaming are disabled until it finishes.
						</p>
					)}

					<div className="mt-2.5 flex items-center gap-2">
						<div className="relative flex-1">
							<span
								aria-hidden="true"
								className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[11px] text-slate-500"
							>
								🔍
							</span>
							<input
								type="search"
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								placeholder="Search title, URL or folder…"
								aria-label="Search bookmarks by title, URL or folder"
								className="w-full rounded-lg border border-slate-700 bg-slate-800/60 py-1.5 pr-8 pl-8 text-xs text-slate-100 outline-none placeholder:text-slate-600 focus:border-indigo-400 [&::-webkit-search-cancel-button]:appearance-none"
							/>
							{query !== '' && (
								<button
									type="button"
									onClick={() => setQuery('')}
									aria-label="Clear search"
									title="Clear search"
									className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer rounded p-0.5 text-slate-500 transition-colors hover:text-slate-200"
								>
									<span aria-hidden="true">✕</span>
								</button>
							)}
						</div>
						{searchTokens.length > 0 && (
							<span className="shrink-0 text-[11px] tabular-nums text-slate-500">
								{visibleItems.length} / {filteredItems.length}
							</span>
						)}
					</div>
				</div>

				{runError && (
					<p className="mt-4 px-3 py-2 rounded-lg bg-red-500/10 text-red-300 text-sm border border-red-500/30">
						{runError}
					</p>
				)}

				{progress.error && !runError && (
					<p className="mt-4 px-3 py-2 rounded-lg bg-amber-500/10 text-amber-300 text-sm border border-amber-500/30">
						{progress.error}
					</p>
				)}

				<div className="mt-4 space-y-3">
					{visibleItems.length === 0 ? (
						<div className="py-16 text-center rounded-xl bg-slate-800/30 border border-dashed border-slate-700">
							<p className="text-sm text-slate-400">
								{items.length === 0
									? 'Run an audit to see your bookmark health.'
									: searchTokens.length > 0
										? `No results for “${query.trim()}”.`
										: 'No items match the selected filter.'}
							</p>
						</div>
					) : (
						visibleItems.map((item) => (
							<BookmarkRow
								key={item.id}
								item={item}
								path={idToPath.get(item.id)}
								isEditing={editingId === item.id}
								isBusy={busyIds.has(item.id)}
								actionsLocked={actionsLocked}
								deleted={deletedIds.has(item.id)}
								error={rowErrors[item.id]}
								editingTitle={editingTitle}
								editingUrl={editingUrl}
								onEditingTitleChange={setEditingTitle}
								onEditingUrlChange={setEditingUrl}
								onDelete={() => handleDelete(item)}
								onStartEditing={() => startEditing(item)}
								onCancelEditing={() => setEditingId(null)}
								onSaveEdit={() => handleSaveEdit(item)}
							/>
						))
					)}
				</div>
			</div>
		</div>
	);
}

interface StatTileProps {
	label: string;
	hint?: string;
	filterKey?: FilterKey;
	active?: boolean;
	baseline?: number | null;
	live?: number;
	value?: string;
	onSelect?: (key: FilterKey) => void;
}

function StatTile({
	label,
	hint,
	filterKey,
	active = false,
	baseline = null,
	live = 0,
	value,
	onSelect,
}: StatTileProps) {
	const tone = filterKey ? TILE_TONES[filterKey] : null;
	const isFilter = Boolean(tone && onSelect && filterKey);
	const shell = `flex min-w-[8.5rem] flex-1 items-center justify-between gap-3 rounded-lg border border-b-2 px-2.5 py-1.5 text-left transition-colors ${
		tone && active
			? `${tone.tint} border-x-slate-800 border-t-slate-800`
			: 'bg-slate-800/40 border-x-slate-800 border-t-slate-800 border-b-slate-800'
	} ${isFilter && !active ? 'cursor-pointer hover:bg-slate-800/70' : ''}`;

	const body = (
		<>
			<span className="min-w-0">
				<span
					className={`block text-[10px] uppercase tracking-wider ${
						tone && active ? 'text-slate-200' : 'text-slate-500'
					}`}
				>
					{label}
				</span>
				{hint && <span className="block text-[9px] text-slate-600">{hint}</span>}
			</span>
			{value !== undefined ? (
				<span className="text-sm font-semibold text-slate-100">{value}</span>
			) : (
				<CountDelta baseline={baseline} live={live} />
			)}
		</>
	);

	if (!onSelect || !filterKey || !tone) {
		return <div className={shell}>{body}</div>;
	}
	return (
		<button
			type="button"
			onClick={() => onSelect(filterKey)}
			aria-pressed={active}
			onMouseEnter={(e) => {
				if (!active) e.currentTarget.style.borderBottomColor = TILE_BORDER_HOVER;
			}}
			onMouseLeave={(e) => {
				if (!active) e.currentTarget.style.borderBottomColor = TILE_BORDER_IDLE;
			}}
			title={
				baseline !== null && baseline !== live
					? `Filtering by ${label} · audited ${baseline}, now ${live}`
					: `Filter by ${label}`
			}
			className={shell}
			style={{ borderBottomColor: active ? tone.hex : TILE_BORDER_IDLE }}
		>
			{body}
		</button>
	);
}

interface BookmarkRowProps {
	item: BookmarkCheck;
	path?: string;
	isEditing: boolean;
	isBusy: boolean;
	actionsLocked: boolean;
	deleted: boolean;
	error?: string;
	editingTitle: string;
	editingUrl: string;
	onEditingTitleChange: (value: string) => void;
	onEditingUrlChange: (value: string) => void;
	onDelete: () => void;
	onStartEditing: () => void;
	onCancelEditing: () => void;
	onSaveEdit: () => void;
}

function BookmarkRow({
	item,
	path,
	isEditing,
	isBusy,
	actionsLocked,
	deleted,
	error,
	editingTitle,
	editingUrl,
	onEditingTitleChange,
	onEditingUrlChange,
	onDelete,
	onStartEditing,
	onCancelEditing,
	onSaveEdit,
}: BookmarkRowProps) {
	// Fila colapsada: el bookmark ya no existe, pero se conserva el rastro de
	// qué se borró y por qué el conteo bajó.
	if (deleted) {
		return (
			<div className="rounded-xl border border-slate-800/80 border-dashed bg-slate-800/20 px-4 py-2.5 opacity-70">
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
					<span className="rounded-full border border-slate-600/60 bg-slate-700/30 px-2 py-0.5 text-[11px] font-medium text-slate-400 uppercase">
						Deleted
					</span>
					<span className="text-xs text-slate-400 line-through decoration-slate-600">
						{item.title || item.url}
					</span>
					<span className="min-w-0 truncate text-[11px] text-slate-600">
						{item.url}
					</span>
					<span className="ml-auto text-[11px] text-slate-500">
						Removed from Chrome bookmarks · no longer counted
					</span>
				</div>
			</div>
		);
	}

	const disabled = isBusy || actionsLocked;
	// Solo los estados que se "arreglan" cambiando el destino editan la URL.
	const canEditUrl = item.status === 'broken' || item.status === 'suspicious';
	const lockHint = actionsLocked ? 'Disabled while the audit is running' : undefined;
	return (
		<div className="p-4 rounded-xl bg-slate-800/50 border border-slate-800">
			<div className="flex items-start justify-between gap-4">
				<div className="min-w-0 flex-1">
					<div className="flex items-center space-x-2">
						<span
							className={`px-2 py-0.5 rounded-full text-[11px] font-medium border uppercase ${STATUS_STYLES[item.status]}`}
						>
							{STATUS_LABELS[item.status]}
						</span>
						{item.httpStatus !== undefined && (
							<span className="text-[11px] text-slate-500">
								HTTP {item.httpStatus}
							</span>
						)}
					</div>

					{isEditing ? (
						<div className="mt-2 space-y-2">
							<label className="block">
								<span className="mb-1 block text-[10px] uppercase tracking-wider text-slate-500">
									Name
								</span>
								<input
									value={editingTitle}
									onChange={(e) => onEditingTitleChange(e.target.value)}
									autoFocus
									placeholder="Leave empty to keep no text"
									className="w-full px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-indigo-500"
								/>
							</label>
							{canEditUrl && (
								<label className="block">
									<span className="mb-1 block text-[10px] uppercase tracking-wider text-slate-500">
										URL
									</span>
									<input
										value={editingUrl}
										onChange={(e) => onEditingUrlChange(e.target.value)}
										spellCheck={false}
										placeholder="https://example.com"
										className="w-full px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-xs text-slate-100 outline-none focus:border-indigo-500"
									/>
								</label>
							)}
							<div className="flex items-center space-x-2">
								<button
									onClick={onSaveEdit}
									disabled={disabled}
									title={lockHint}
									className="py-1.5 px-3 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
								>
									Save
								</button>
								<button
									onClick={onCancelEditing}
									disabled={isBusy}
									className="py-1.5 px-3 rounded-lg bg-slate-700 text-slate-200 text-xs font-medium disabled:opacity-50 cursor-pointer"
								>
									Cancel
								</button>
							</div>
						</div>
					) : (
						<h2 className="mt-2 text-sm font-semibold text-slate-100 break-words">
							{item.title || (
								<span className="text-slate-500 font-normal italic">
									No title — icon only
								</span>
							)}
						</h2>
					)}

					<a
						href={item.url}
						target="_blank"
						rel="noreferrer"
						className="mt-0.5 block text-xs text-slate-500 truncate hover:text-indigo-300 hover:underline"
						title={item.url}
					>
						{item.url}
					</a>

					{path && (
						<p className="mt-0.5 text-[11px] text-slate-600">
							📁 {path}
						</p>
					)}
					{item.status === 'suspicious' && item.actualTitle && (
						<p className="mt-1.5 text-xs text-amber-400">
							⚠️ Saved title may be outdated — detected: “{item.actualTitle}”
						</p>
					)}

					{item.note && (
						<p className="mt-1 text-[11px] text-slate-400">
							{item.status === 'suspicious' ? 'Reason: ' : ''}
							{item.note}
						</p>
					)}

					{error && (
						<p className="mt-1.5 text-xs text-red-400">Error: {error}</p>
					)}
				</div>

				<div className="flex items-center space-x-2 shrink-0">
					<button
						onClick={onDelete}
						disabled={disabled}
						title={lockHint ?? 'Delete bookmark'}
						className="py-1.5 px-3 rounded-lg bg-red-500/15 hover:bg-red-500/25 text-red-300 text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
					>
						Delete
					</button>
					<button
						onClick={isEditing ? onCancelEditing : onStartEditing}
						disabled={disabled}
						title={lockHint}
						className="py-1.5 px-3 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
					>
						{isEditing ? 'Cancel' : canEditUrl ? 'Edit' : 'Edit name'}
					</button>
				</div>
			</div>
		</div>
	);
}

ReactDOM.createRoot(document.getElementById('root')!).render(
	<React.StrictMode>
		<DashboardApp />
	</React.StrictMode>
);