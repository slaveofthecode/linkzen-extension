export const MESSAGE_AUDIT_RUN = 'AUDIT_RUN';

export const STORAGE_KEY_PROGRESS = 'audit:progress';
export const STORAGE_KEY_SUMMARY = 'audit:summary';
export const STORAGE_KEY_ITEMS = 'audit:items';

export type AuditStatus = 'active' | 'broken' | 'suspicious' | 'skipped';

export interface BookmarkCheck {
	id: string;
	title: string;
	url: string;
	status: AuditStatus;
	httpStatus?: number;
	actualTitle?: string;
	note?: string;
}

export interface AuditSummary {
	total: number;
	active: number;
	broken: number;
	suspicious: number;
	skipped: number;
	checkedAt: number;
	durationMs: number;
}

export interface AuditProgress {
	running: boolean;
	checked: number;
	total: number;
}

export interface AuditRequest {
	type: typeof MESSAGE_AUDIT_RUN;
}

export type AuditResponse =
	| { ok: true; summary: AuditSummary }
	| { ok: false; error: string };