import type {
	AuditProgress,
	AuditRequest,
	AuditResponse,
	AuditSummary,
	BookmarkCheck,
} from './types';
import {
	MESSAGE_AUDIT_RUN,
	STORAGE_KEY_ITEMS,
	STORAGE_KEY_PROGRESS,
	STORAGE_KEY_SUMMARY,
} from './types';

type StorageListener = (
	changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
) => void;

const MOCK_ITEMS: BookmarkCheck[] = [
	{
		id: 'bm1',
		title: 'Dead Link 404',
		url: 'https://example.com/gone',
		status: 'broken',
		httpStatus: 404,
		note: 'HTTP 404',
	},
	{
		id: 'bm2',
		title: 'Timed Out Site',
		url: 'https://example.com/slow',
		status: 'broken',
		note: 'Response timeout',
	},
	{
		id: 'bm3',
		title: 'Moved Resource',
		url: 'https://example.com/moved',
		status: 'broken',
		note: 'Network failure',
	},
	{
		id: 'bm4',
		title: 'Old Page Name',
		url: 'https://example.com/actual',
		status: 'suspicious',
		httpStatus: 200,
		actualTitle: 'New Page Name',
	},
	{
		id: 'bm5',
		title: 'My Old Post',
		url: 'https://example.com/blog',
		status: 'suspicious',
		httpStatus: 200,
		actualTitle: 'My Updated Post',
	},
	{
		id: 'bm6',
		title: 'GitHub',
		url: 'https://github.com',
		status: 'active',
		httpStatus: 200,
	},
	{
		id: 'bm7',
		title: 'MDN Web Docs',
		url: 'https://developer.mozilla.org',
		status: 'active',
		httpStatus: 200,
	},
	{
		id: 'bm8',
		title: 'Local Notes',
		url: 'file:///Users/me/notes.txt',
		status: 'skipped',
		note: 'Non-http URL',
	},
];

const MOCK_SUMMARY: AuditSummary = {
	total: MOCK_ITEMS.length,
	active: 2,
	broken: 3,
	suspicious: 2,
	skipped: 1,
	checkedAt: Date.now(),
	durationMs: 1234,
};

type MockBookmark = { title: string; url: string };

const bookmarksStore = new Map<string, MockBookmark>(
	MOCK_ITEMS.map((item) => [
		item.id,
		{ title: item.title, url: item.url },
	]),
);

const store = new Map<string, unknown>([
	[STORAGE_KEY_SUMMARY, MOCK_SUMMARY],
	[STORAGE_KEY_ITEMS, MOCK_ITEMS],
	[STORAGE_KEY_PROGRESS, { running: false, checked: 0, total: 0 } satisfies AuditProgress],
]);
const listeners = new Set<StorageListener>();

function setValue(key: string, value: unknown): void {
	const oldValue = store.get(key);
	store.set(key, value);
	const changes: Record<string, { newValue?: unknown; oldValue?: unknown }> = {};
	changes[key] = { newValue: value, oldValue };
	listeners.forEach((fn) => fn(changes));
}

function runMockAudit(): void {
	let checked = 0;
	const total = 20;
	const tick = () => {
		checked = Math.min(checked + 4, total);
		setValue(
			STORAGE_KEY_PROGRESS,
			{ running: checked < total, checked, total } satisfies AuditProgress,
		);
		if (checked < total) {
			setTimeout(tick, 300);
		} else {
			setValue(STORAGE_KEY_SUMMARY, { ...MOCK_SUMMARY, checkedAt: Date.now() });
		}
	};
	tick();
}

function hasExtensionApis(): boolean {
	if (typeof globalThis.chrome === 'undefined') return false;
	return typeof (globalThis.chrome as { storage?: unknown }).storage !== 'undefined';
}

if (import.meta.env.DEV && !hasExtensionApis()) {
	(globalThis as Record<string, unknown>).chrome = {
		storage: {
			local: {
				get: (
					keys: string | string[] | Record<string, unknown> | null,
					cb?: (items: Record<string, unknown>) => void,
				) => {
					const result: Record<string, unknown> = {};
					const keyList = Array.isArray(keys)
						? keys
						: keys
							? typeof keys === 'string'
								? [keys]
								: Object.keys(keys)
							: [...store.keys()];
					keyList.forEach((key) => {
						if (store.has(key)) result[key] = store.get(key);
					});
					cb?.(result);
				},
				set: (items: Record<string, unknown>, cb?: () => void) => {
					Object.entries(items).forEach(([key, value]) => setValue(key, value));
					cb?.();
				},
			},
			onChanged: {
				addListener: (fn: StorageListener) => listeners.add(fn),
				removeListener: (fn: StorageListener) => listeners.delete(fn),
			},
		},
		runtime: {
			lastError: undefined,
			sendMessage: (message: AuditRequest, cb?: (response?: AuditResponse) => void) => {
				if (message?.type === MESSAGE_AUDIT_RUN) {
					runMockAudit();
					setTimeout(
						() => cb?.({ ok: true, summary: { ...MOCK_SUMMARY, checkedAt: Date.now() } }),
						400,
					);
				}
				cb?.();
				return undefined;
			},
			getURL: (path: string) => new URL(path, window.location.origin).toString(),
		},
		bookmarks: {
			getTree: (cb: (tree: chrome.bookmarks.BookmarkTreeNode[]) => void) => {
				const node = (id: string): chrome.bookmarks.BookmarkTreeNode => {
					const bookmark = bookmarksStore.get(id);
					return {
						id,
						title: bookmark?.title ?? 'Missing',
						url: bookmark?.url,
						syncing: false,
					};
				};
				const folder = (
					id: string,
					title: string,
					children: chrome.bookmarks.BookmarkTreeNode[],
				): chrome.bookmarks.BookmarkTreeNode => ({
					id,
					title,
					syncing: false,
					children,
				});
				cb([
					folder('0', 'Bookmarks Bar', [
						folder('f1', 'Favorites', [node('bm1'), node('bm2')]),
						folder('f2', 'Work', [node('bm3'), node('bm4'), node('bm6')]),
						node('bm5'),
						node('bm7'),
						node('bm8'),
					]),
				]);
			},
			remove: (id: string, cb?: () => void) => {
				if (bookmarksStore.has(id)) {
					bookmarksStore.delete(id);
					(globalThis.chrome as { runtime?: { lastError?: unknown } }).runtime!.lastError =
						undefined;
				} else {
					(globalThis.chrome as { runtime?: { lastError?: Error } }).runtime!.lastError =
						new Error('No bookmark with the specified id.');
				}
				cb?.();
			},
			update: (
				id: string,
				changes: { title?: string; url?: string },
				cb?: (result: chrome.bookmarks.BookmarkTreeNode) => void,
			) => {
				const bookmark = bookmarksStore.get(id);
				if (bookmark) {
					if (changes.title !== undefined) bookmark.title = changes.title;
					if (changes.url !== undefined) bookmark.url = changes.url;
					(globalThis.chrome as { runtime?: { lastError?: unknown } }).runtime!.lastError =
						undefined;
					cb?.({ id, title: bookmark.title, url: bookmark.url, syncing: false });
				} else {
					(globalThis.chrome as { runtime?: { lastError?: Error } }).runtime!.lastError =
						new Error('No bookmark with the specified id.');
					cb?.({ id, title: 'Missing', url: undefined, syncing: false });
				}
			},
		},
		tabs: {
			create: (props: { url?: string }) => {
				if (props?.url) window.open(props.url, '_blank', 'noopener');
			},
		},
	};
}

export {};