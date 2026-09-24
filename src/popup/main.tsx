import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import '../index.css';
import '../chromeMock';
import type {
	AuditProgress,
	AuditRequest,
	AuditResponse,
	AuditSummary,
} from '../types';
import {
	MESSAGE_AUDIT_RUN,
	STORAGE_KEY_PROGRESS,
	STORAGE_KEY_SUMMARY,
} from '../types';

interface QuickLink {
	id: string;
	title: string;
	url: string;
	icon: string;
	bgColor: string;
}

const INITIAL_LINKS: QuickLink[] = [
	{
		id: '1',
		title: 'YouTube',
		url: 'https://youtube.com',
		icon: '▶',
		bgColor: 'bg-red-600/20 text-red-400 border-red-500/30',
	},
	{
		id: '2',
		title: 'Spotify',
		url: 'https://spotify.com',
		icon: '♫',
		bgColor: 'bg-emerald-600/20 text-emerald-400 border-emerald-500/30',
	},
	{
		id: '3',
		title: 'Notion',
		url: 'https://notion.so',
		icon: 'N',
		bgColor: 'bg-stone-600/20 text-stone-200 border-stone-500/30',
	},
	{
		id: '4',
		title: 'GitHub',
		url: 'https://github.com',
		icon: '⚡',
		bgColor: 'bg-purple-600/20 text-purple-400 border-purple-500/30',
	},
];

function PopupApp() {
	const [links] = useState<QuickLink[]>(INITIAL_LINKS);
	const [progress, setProgress] = useState<AuditProgress>({
		running: false,
		checked: 0,
		total: 0,
	});
	const [summary, setSummary] = useState<AuditSummary | null>(null);
	const [runError, setRunError] = useState<string | null>(null);

	const isRunning = progress.running;

	useEffect(() => {
		chrome.storage.local.get(
			[STORAGE_KEY_PROGRESS, STORAGE_KEY_SUMMARY],
			(stored) => {
				const p = stored[STORAGE_KEY_PROGRESS] as AuditProgress | undefined;
				const s = stored[STORAGE_KEY_SUMMARY] as AuditSummary | undefined;
				if (p) setProgress(p);
				if (s) setSummary(s);
			}
		);

		const onStorageChanged = (
			changes: Record<string, chrome.storage.StorageChange>
		) => {
			if (changes[STORAGE_KEY_PROGRESS]) {
				setProgress(changes[STORAGE_KEY_PROGRESS].newValue as AuditProgress);
			}
			if (changes[STORAGE_KEY_SUMMARY]) {
				setSummary(changes[STORAGE_KEY_SUMMARY].newValue as AuditSummary);
			}
		};
		chrome.storage.onChanged.addListener(onStorageChanged);
		return () => chrome.storage.onChanged.removeListener(onStorageChanged);
	}, []);

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

	const handleOpenDashboard = () => {
		chrome.tabs.create({
			url: chrome.runtime.getURL('src/dashboard/index.html'),
		});
	};

	const analyzedLabel = isRunning
		? `${progress.checked} / ${progress.total}`
		: summary
			? `${summary.total}`
			: '—';
	const issues = summary ? summary.broken + summary.suspicious : 0;

	return (
		<div className="w-95 bg-slate-900 text-slate-100 p-4 font-sans select-none">
			{/* Header */}
			<div className="flex items-center justify-between pb-3 border-b border-slate-800">
				<div className="flex items-center space-x-2">
					<span className="text-xl">🔗</span>
					<h1 className="font-bold text-base tracking-wide">LinkZen</h1>
				</div>
				<span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700">
					v1.0.0
				</span>
			</div>

			{/* Quick Access Section */}
			<div className="mt-4">
				<h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
					Key Access
				</h2>
				<div className="grid grid-cols-4 gap-2">
					{links.map((link) => (
						<a
							key={link.id}
							href={link.url}
							target="_blank"
							rel="noreferrer"
							className={`flex flex-col items-center justify-center p-3 rounded-xl border transition-all hover:scale-105 hover:shadow-lg ${link.bgColor}`}
							title={link.title}
						>
							<span className="text-lg mb-1">{link.icon}</span>
							<span className="text-[11px] font-medium truncate w-full text-center">
								{link.title}
							</span>
						</a>
					))}
				</div>
			</div>

			{/* Bookmarks Status Section */}
			<div className="mt-5 p-3 rounded-xl bg-slate-800/50 border border-slate-800">
				<h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
					Bookmarks Status
				</h2>
				<div className="flex items-center justify-between text-sm">
					<span className="text-slate-300">Analyzed links</span>
					<span className="font-semibold text-slate-100">{analyzedLabel}</span>
				</div>
				{issues > 0 && (
					<div className="mt-2 flex items-center space-x-1.5 text-amber-400 text-xs font-medium">
						<span>⚠️</span>
						<span>{issues} broken or suspicious links detected</span>
					</div>
				)}
				{runError && <p className="mt-2 text-xs text-red-400">{runError}</p>}
				<button
					onClick={handleRunAudit}
					disabled={isRunning}
					className="w-full mt-3 py-2 rounded-lg bg-slate-700/60 hover:bg-slate-700 text-slate-100 text-xs font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
				>
					{isRunning ? (
						<span className="animate-pulse">
							⏳ Auditing… {progress.checked}/{progress.total}
						</span>
					) : (
						<span>▶ Run audit</span>
					)}
				</button>
			</div>

			{/* Audit Action Button */}
			<div className="mt-5">
				<button
					onClick={handleOpenDashboard}
					disabled={isRunning}
					className="w-full py-2.5 px-4 rounded-xl bg-linear-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-medium text-sm shadow-md transition-all flex items-center justify-center space-x-2 cursor-pointer active:scale-98 disabled:opacity-50 disabled:cursor-not-allowed"
				>
					<span>🧹</span>
					<span>Open Audit & Hygiene Panel</span>
				</button>
			</div>
		</div>
	);
}

ReactDOM.createRoot(document.getElementById('root')!).render(
	<React.StrictMode>
		<PopupApp />
	</React.StrictMode>
);
