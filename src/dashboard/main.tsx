import React, { useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom/client';
import '../index.css';
import '../chromeMock';
import type {
	AuditProgress,
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

type FilterKey = 'issues' | 'broken' | 'suspicious';

const STATUS_STYLES: Record<BookmarkCheck['status'], string> = {
	active: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
	broken: 'bg-red-500/15 text-red-300 border-red-500/30',
	suspicious: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
	skipped: 'bg-slate-500/15 text-slate-400 border-slate-500/30',
};

const FILTERS: { key: FilterKey; label: string }[] = [
	{ key: 'issues', label: 'Issues' },
	{ key: 'broken', label: 'Broken' },
	{ key: 'suspicious', label: 'Suspicious' },
];

function bookmarksRemove(id: string): Promise<void> {
	return new Promise((resolve, reject) => {
		chrome.bookmarks.remove(id, () => {
			const err = chrome.runtime.lastError;
			if (err) reject(new Error(err.message));
			else resolve();
		});
	});
}

function bookmarksUpdateTitle(id: string, title: string): Promise<void> {
	return new Promise((resolve, reject) => {
		chrome.bookmarks.update(id, { title }, () => {
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
	const [filter, setFilter] = useState<FilterKey>('issues');
	const [idToPath, setIdToPath] = useState<Map<string, string>>(new Map());
	const [dismissed, setDismissed] = useState<Set<string>>(new Set());
	const [editingId, setEditingId] = useState<string | null>(null);
	const [editingTitle, setEditingTitle] = useState('');
	const [runError, setRunError] = useState<string | null>(null);
	const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
	const [busyIds, setBusyIds] = useState<Set<string>>(new Set());

	const isRunning = progress.running;

	useEffect(() => {
		chrome.storage.local.get(
			[STORAGE_KEY_ITEMS, STORAGE_KEY_SUMMARY, STORAGE_KEY_PROGRESS],
			(stored) => {
				const storedItems = stored[STORAGE_KEY_ITEMS] as BookmarkCheck[] | undefined;
				if (storedItems) {
					setItems(storedItems);
					setDismissed(new Set());
				}
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
				setDismissed(new Set());
			}
			if (changes[STORAGE_KEY_SUMMARY]) {
				setSummary(changes[STORAGE_KEY_SUMMARY].newValue as AuditSummary);
			}
			if (changes[STORAGE_KEY_PROGRESS]) {
				setProgress(changes[STORAGE_KEY_PROGRESS].newValue as AuditProgress);
			}
		};
		chrome.storage.onChanged.addListener(onStorageChanged);
		return () => chrome.storage.onChanged.removeListener(onStorageChanged);
	}, []);

	useEffect(() => {
		getBookmarkTree()
			.then((tree) => setIdToPath(buildIdToPath(tree)))
			.catch(() => setIdToPath(new Map()));
	}, []);

	const visibleItems = useMemo(() => {
		let list = items.filter(
			(item) =>
				!dismissed.has(item.id) &&
				(item.status === 'broken' || item.status === 'suspicious')
		);
		if (filter === 'broken' || filter === 'suspicious') {
			list = list.filter((item) => item.status === filter);
		}
		return list;
	}, [items, dismissed, filter]);

	const filterCounts = useMemo(() => {
		const counts: Record<FilterKey, number> = {
			issues: 0,
			broken: 0,
			suspicious: 0,
		};
		for (const item of items) {
			if (item.status === 'broken' || item.status === 'suspicious')
				counts.issues++;
			if (item.status === 'broken') counts.broken++;
			if (item.status === 'suspicious') counts.suspicious++;
		}
		return counts;
	}, [items]);

	const handleRunAudit = () => {
		setRunError(null);
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
		clearRowError(item.id);
		markBusy(item.id, true);
		try {
			await bookmarksRemove(item.id);
			setItems((prev) => prev.filter((it) => it.id !== item.id));
		} catch (err) {
			setRowErrors((prev) => ({
				...prev,
				[item.id]: err instanceof Error ? err.message : String(err),
			}));
		} finally {
			markBusy(item.id, false);
		}
	};

	const handleDismiss = (id: string) => {
		setDismissed((prev) => new Set(prev).add(id));
	};

	const startEditing = (item: BookmarkCheck) => {
		setEditingId(item.id);
		setEditingTitle(item.actualTitle ?? item.title);
	};

	const handleSaveTitle = async (item: BookmarkCheck) => {
		const title = editingTitle.trim();
		if (!title) return;
		clearRowError(item.id);
		markBusy(item.id, true);
		try {
			await bookmarksUpdateTitle(item.id, title);
			setItems((prev) =>
				prev.map((it) =>
					it.id === item.id ? { ...it, title, status: 'active' } : it
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

	const total = summary?.total ?? items.length;
	const issues = summary
		? summary.broken + summary.suspicious
		: filterCounts.issues;

	return (
		<div className="min-h-screen bg-slate-900 text-slate-100 font-sans select-none">
			<div className="max-w-5xl mx-auto px-6 py-8 text-left">
				<div className="flex items-center justify-between">
					<div className="flex items-center space-x-3">
						<span className="text-2xl">🔗</span>
						<h1 className="text-xl font-bold tracking-wide">LinkZen Dashboard</h1>
					</div>
					<div className="flex items-center space-x-3">
						{isRunning && (
							<span className="animate-pulse text-xs text-slate-300">
								⏳ Auditing… {progress.checked}/{progress.total}
							</span>
						)}
						<button
							onClick={handleRunAudit}
							disabled={isRunning}
							className="py-2 px-4 rounded-lg bg-slate-700/60 hover:bg-slate-700 text-slate-100 text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
						>
							▶ Re-run audit
						</button>
					</div>
				</div>

				{isRunning && (
					<div className="mt-4 h-1.5 rounded-full bg-slate-800 overflow-hidden">
						<div
							className="h-full bg-indigo-500 transition-all"
							style={{
								width: progress.total
									? `${Math.round((progress.checked / progress.total) * 100)}%`
									: '0%',
							}}
						/>
					</div>
				)}

				{runError && (
					<p className="mt-4 px-3 py-2 rounded-lg bg-red-500/10 text-red-300 text-sm border border-red-500/30">
						{runError}
					</p>
				)}

				<div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
					<Tile label="Total" value={total} />
					<Tile label="Broken" value={summary?.broken ?? 0} accent="text-red-300" />
					<Tile
						label="Suspicious"
						value={summary?.suspicious ?? 0}
						accent="text-amber-300"
					/>
					<Tile
						label="Duration"
						value={
							summary ? `${(summary.durationMs / 1000).toFixed(1)}s` : '—'
						}
					/>
				</div>

				<div className="mt-6 flex items-center space-x-2">
					{FILTERS.map(({ key, label }) => (
						<button
							key={key}
							onClick={() => setFilter(key)}
							className={`py-1.5 px-3 rounded-full text-xs font-medium border transition-all cursor-pointer ${
								filter === key
									? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40'
									: 'bg-slate-800/50 text-slate-400 border-slate-700 hover:text-slate-200'
							}`}
						>
							{label} · {filterCounts[key]}
						</button>
					))}
				</div>

				{issues > 0 && (
					<p className="mt-4 text-sm text-amber-400">
						⚠️ {issues} broken or suspicious links detected
					</p>
				)}

				<div className="mt-4 space-y-3">
					{visibleItems.length === 0 ? (
						<div className="py-16 text-center rounded-xl bg-slate-800/30 border border-dashed border-slate-700">
							<p className="text-sm text-slate-400">
								{items.length === 0
									? 'Run an audit to see your bookmark health.'
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
								error={rowErrors[item.id]}
								editingTitle={editingTitle}
								onEditingTitleChange={setEditingTitle}
								onDelete={() => handleDelete(item)}
								onDismiss={() => handleDismiss(item.id)}
								onStartEditing={() => startEditing(item)}
								onCancelEditing={() => setEditingId(null)}
								onSaveTitle={() => handleSaveTitle(item)}
							/>
						))
					)}
				</div>
			</div>
		</div>
	);
}

interface TileProps {
	label: string;
	value: number | string;
	accent?: string;
}

function Tile({ label, value, accent }: TileProps) {
	return (
		<div className="p-3 rounded-xl bg-slate-800/50 border border-slate-800">
			<p className="text-[11px] uppercase tracking-wider text-slate-500">
				{label}
			</p>
			<p className={`mt-1 text-lg font-semibold ${accent ?? 'text-slate-100'}`}>
				{value}
			</p>
		</div>
	);
}

interface BookmarkRowProps {
	item: BookmarkCheck;
	path?: string;
	isEditing: boolean;
	isBusy: boolean;
	error?: string;
	editingTitle: string;
	onEditingTitleChange: (value: string) => void;
	onDelete: () => void;
	onDismiss: () => void;
	onStartEditing: () => void;
	onCancelEditing: () => void;
	onSaveTitle: () => void;
}

function BookmarkRow({
	item,
	path,
	isEditing,
	isBusy,
	error,
	editingTitle,
	onEditingTitleChange,
	onDelete,
	onDismiss,
	onStartEditing,
	onCancelEditing,
	onSaveTitle,
}: BookmarkRowProps) {
	return (
		<div className="p-4 rounded-xl bg-slate-800/50 border border-slate-800">
			<div className="flex items-start justify-between gap-4">
				<div className="min-w-0 flex-1">
					<div className="flex items-center space-x-2">
						<span
							className={`px-2 py-0.5 rounded-full text-[11px] font-medium border uppercase ${STATUS_STYLES[item.status]}`}
						>
							{item.status}
						</span>
						{item.httpStatus !== undefined && (
							<span className="text-[11px] text-slate-500">
								HTTP {item.httpStatus}
							</span>
						)}
					</div>

					{isEditing ? (
						<div className="mt-2 flex items-center space-x-2">
							<input
								value={editingTitle}
								onChange={(e) => onEditingTitleChange(e.target.value)}
								autoFocus
								className="flex-1 px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-sm text-slate-100 outline-none focus:border-indigo-500"
							/>
							<button
								onClick={onSaveTitle}
								disabled={isBusy}
								className="py-1.5 px-3 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium disabled:opacity-50 cursor-pointer"
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
					) : (
						<h2 className="mt-2 text-sm font-semibold text-slate-100 break-words">
							{item.title}
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
					{item.note && item.status !== 'suspicious' && (
						<p className="mt-1.5 text-xs text-slate-400">{item.note}</p>
					)}

					{error && (
						<p className="mt-1.5 text-xs text-red-400">Error: {error}</p>
					)}
				</div>

				<div className="flex items-center space-x-2 shrink-0">
					<button
						onClick={onDelete}
						disabled={isBusy}
						className="py-1.5 px-3 rounded-lg bg-red-500/15 hover:bg-red-500/25 text-red-300 text-xs font-medium disabled:opacity-50 cursor-pointer"
					>
						Delete
					</button>
					<button
						onClick={isEditing ? onCancelEditing : onStartEditing}
						disabled={isBusy}
						className="py-1.5 px-3 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-medium disabled:opacity-50 cursor-pointer"
					>
						{isEditing ? 'Cancel' : 'Edit name'}
					</button>
					<button
						onClick={onDismiss}
						disabled={isBusy}
						className="py-1.5 px-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 text-xs font-medium disabled:opacity-50 cursor-pointer"
					>
						Keep
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