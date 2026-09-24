import type {
	AuditProgress,
	AuditRequest,
	AuditResponse,
	AuditSummary,
} from './types';
import {
	MESSAGE_AUDIT_RUN,
	STORAGE_KEY_PROGRESS,
	STORAGE_KEY_SUMMARY,
} from './types';

type StorageListener = (
	changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
) => void;

const MOCK_SUMMARY: AuditSummary = {
	total: 350,
	active: 342,
	broken: 6,
	suspicious: 2,
	skipped: 0,
	checkedAt: Date.now(),
	durationMs: 1234,
};

const store = new Map<string, unknown>([
	[STORAGE_KEY_SUMMARY, MOCK_SUMMARY],
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
			getURL: (path: string) => path,
		},
		tabs: {
			create: () => undefined,
		},
	};
}

export {};