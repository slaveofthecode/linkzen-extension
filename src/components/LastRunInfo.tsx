import type { AuditSummary } from '../types';

interface LastRunInfoProps {
	summary: AuditSummary | null;
	placement?: 'above' | 'below';
	className?: string;
}

function formatElapsed(ms: number): string {
	if (ms < 1000) return `${ms} ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000);
	return `${minutes}m ${seconds}s`;
}

function formatCheckedAt(timestamp: number): string {
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(timestamp);
}

export function LastRunInfo({
	summary,
	placement = 'below',
	className = '',
}: LastRunInfoProps) {
	if (!summary) {
		return <span className={className}>No audit run yet</span>;
	}

	const panelPosition =
		placement === 'above' ? 'bottom-full mb-1.5' : 'top-full mt-1.5';
	const elapsed = formatElapsed(summary.durationMs);
	const issues = summary.broken + summary.suspicious;

	return (
		<span className={`group relative inline-flex ${className}`}>
			<span
				tabIndex={0}
				title={`${summary.total} links audited in ${elapsed}`}
				className="cursor-help underline decoration-dotted underline-offset-2 hover:text-slate-300 focus:outline-none"
			>
				{summary.cancelled ? 'Last run (cancelled): ' : 'Last run: '}
				{formatCheckedAt(summary.checkedAt)}
			</span>

			<span
				className={`pointer-events-none absolute right-0 z-20 w-52 rounded-lg border border-slate-700 bg-slate-900 p-2.5 text-left text-[11px] leading-relaxed text-slate-400 shadow-xl opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 ${panelPosition}`}
			>
				<p className="flex justify-between gap-2">
					<span>Links audited</span>
					<span className="font-medium text-slate-100">{summary.total}</span>
				</p>
				<p className="flex justify-between gap-2">
					<span>Elapsed</span>
					<span className="font-medium text-slate-100">{elapsed}</span>
				</p>
				<p className="flex justify-between gap-2">
					<span>Healthy</span>
					<span className="font-medium text-emerald-300">{summary.active}</span>
				</p>
				<p className="flex justify-between gap-2">
					<span>Broken</span>
					<span className="font-medium text-red-300">{summary.broken}</span>
				</p>
				<p className="flex justify-between gap-2">
					<span>Suspicious</span>
					<span className="font-medium text-amber-300">{summary.suspicious}</span>
				</p>
				{summary.skipped > 0 && (
					<p className="flex justify-between gap-2">
						<span>Skipped</span>
						<span className="font-medium text-slate-300">{summary.skipped}</span>
					</p>
				)}
				{(summary.untitled ?? 0) > 0 && (
					<p className="flex justify-between gap-2">
						<span>Icon only</span>
						<span className="font-medium text-sky-300">{summary.untitled}</span>
					</p>
				)}
				<p className="mt-1.5 border-t border-slate-800 pt-1.5 text-slate-500">
					{issues === 0
						? 'No issues found'
						: `${issues} issue${issues === 1 ? '' : 's'} found`}
				</p>
			</span>
		</span>
	);
}
