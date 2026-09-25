import type { AuditProgress, AuditSummary } from '../types';

const RUNNING_FRAMES = ['·', '··', '···', '··'];
const PULSE_INTERVAL_MS = 320;
const FLASH_STEPS = 6;
const FLASH_INTERVAL_MS = 300;

const COLOR_RUNNING = '#6366f1';
const COLOR_BROKEN = '#ef4444';
const COLOR_SUSPICIOUS = '#f59e0b';
const COLOR_OK = '#16a34a';
const COLOR_ERROR = '#dc2626';
const COLOR_STOPPED = '#64748b';

let pulseTimer: ReturnType<typeof setInterval> | null = null;
let flashTimer: ReturnType<typeof setInterval> | null = null;
let frameIndex = 0;
let runningProgress: AuditProgress | null = null;

function setBadge(text: string, color: string): void {
	try {
		void chrome.action?.setBadgeText({ text });
		void chrome.action?.setBadgeBackgroundColor({ color });
	} catch {
		return;
	}
}

function setTitle(title: string): void {
	try {
		void chrome.action?.setTitle({ title });
	} catch {
		return;
	}
}

function stopPulse(): void {
	if (pulseTimer !== null) {
		clearInterval(pulseTimer);
		pulseTimer = null;
	}
}

function stopFlash(): void {
	if (flashTimer !== null) {
		clearInterval(flashTimer);
		flashTimer = null;
	}
}

function formatTime(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString([], {
		hour: '2-digit',
		minute: '2-digit',
	});
}

function renderRunningFrame(): void {
	if (!runningProgress) return;
	const frame = RUNNING_FRAMES[frameIndex % RUNNING_FRAMES.length];
	const { checked, total } = runningProgress;
	const detail = total > 0 ? `${checked}/${total}` : 'starting…';
	const percent = total > 0 ? ` · ${Math.round((checked / total) * 100)}%` : '';
	setBadge(frame, COLOR_RUNNING);
	setTitle(`LinkZen — auditing ${detail}${percent}`);
}

function flashFinal(text: string, color: string): void {
	stopFlash();
	let step = 0;
	flashTimer = setInterval(() => {
		step += 1;
		if (step >= FLASH_STEPS) {
			stopFlash();
			setBadge(text, color);
			return;
		}
		setBadge(step % 2 === 0 ? text : '', color);
	}, FLASH_INTERVAL_MS);
}

export function showRunning(progress: AuditProgress): void {
	runningProgress = progress;
	stopFlash();
	frameIndex = 0;
	if (pulseTimer !== null) {
		renderRunningFrame();
		return;
	}
	renderRunningFrame();
	pulseTimer = setInterval(() => {
		frameIndex = (frameIndex + 1) % RUNNING_FRAMES.length;
		renderRunningFrame();
	}, PULSE_INTERVAL_MS);
}

export function showFinished(summary: AuditSummary): void {
	stopPulse();
	runningProgress = null;
	const issues = summary.broken + summary.suspicious;
	const detail =
		issues === 0
			? `all ${summary.total} links look healthy`
			: `${summary.broken} broken · ${summary.suspicious} suspicious`;
	setTitle(`LinkZen — ${detail} · last run ${formatTime(summary.checkedAt)}`);

	if (summary.broken > 0) {
		flashFinal(String(summary.broken), COLOR_BROKEN);
		return;
	}
	if (summary.suspicious > 0) {
		flashFinal(String(summary.suspicious), COLOR_SUSPICIOUS);
		return;
	}
	flashFinal('OK', COLOR_OK);
}

export function showInterrupted(error: string): void {
	stopPulse();
	stopFlash();
	runningProgress = null;
	setBadge('!', COLOR_ERROR);
	setTitle(`LinkZen — audit failed: ${error}`);
}

export function showCancelled(summary: AuditSummary): void {
	stopPulse();
	stopFlash();
	runningProgress = null;
	setBadge('STOP', COLOR_STOPPED);
	const seconds = (summary.durationMs / 1000).toFixed(1);
	setTitle(
		`LinkZen — audit cancelled · ${summary.total} links checked in ${seconds}s`
	);
}

export function showIdle(): void {
	stopPulse();
	stopFlash();
	runningProgress = null;
	setBadge('', COLOR_RUNNING);
	setTitle('LinkZen — audit your bookmarks');
}
