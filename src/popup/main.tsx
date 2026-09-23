import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import '../index.css';

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

	const handleOpenDashboard = () => {
		// Opens the full audit dashboard in a new tab
		chrome.tabs.create({
			url: chrome.runtime.getURL('src/dashboard/index.html'),
		});
	};

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
					<span className="font-semibold text-slate-100">342 / 350</span>
				</div>
				<div className="mt-2 flex items-center space-x-1.5 text-amber-400 text-xs font-medium">
					<span>⚠️</span>
					<span>8 broken or suspicious links detected</span>
				</div>
			</div>

			{/* Audit Action Button */}
			<div className="mt-5">
				<button
					onClick={handleOpenDashboard}
					className="w-full py-2.5 px-4 rounded-xl bg-linear-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-medium text-sm shadow-md transition-all flex items-center justify-center space-x-2 cursor-pointer active:scale-98"
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
