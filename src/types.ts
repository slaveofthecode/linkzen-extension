export const MESSAGE_AUDIT_RUN = 'AUDIT_RUN';
export const MESSAGE_AUDIT_STATUS = 'AUDIT_STATUS';
export const MESSAGE_AUDIT_CANCEL = 'AUDIT_CANCEL';

export const STORAGE_KEY_PROGRESS = 'audit:progress';
export const STORAGE_KEY_SUMMARY = 'audit:summary';
export const STORAGE_KEY_ITEMS = 'audit:items';
export const STORAGE_KEY_LINKS = 'launcher:links';

export type AuditStatus =
	| 'active'
	| 'broken'
	| 'suspicious'
	| 'skipped'
	| 'untitled';

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
	untitled?: number;
	checkedAt: number;
	durationMs: number;
	cancelled?: boolean;
}

export interface AuditProgress {
	running: boolean;
	checked: number;
	total: number;
	error?: string;
}

export interface QuickLink {
	id: string;
	title: string;
	url: string;
}

export interface AuditRequest {
	type: typeof MESSAGE_AUDIT_RUN;
}

export interface AuditStatusRequest {
	type: typeof MESSAGE_AUDIT_STATUS;
}

export interface AuditCancelRequest {
	type: typeof MESSAGE_AUDIT_CANCEL;
}

export type AuditResponse =
	| { ok: true; summary: AuditSummary; cancelled?: boolean }
	| { ok: false; error: string };

export interface AuditStatusResponse {
	running: boolean;
	progress: AuditProgress;
}

export interface AuditCancelResponse {
	ok: boolean;
	cancelled: boolean;
	error?: string;
}
