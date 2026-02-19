'use client';

import React, { useState, useEffect } from 'react';
import { useConfigStore } from '@/state/stores';

const SettingsView: React.FC = () => {
    const [activeTab, setActiveTab] = useState('Admin & Security');
    const [theme, setTheme] = useState<'dark' | 'light' | 'high-contrast'>('dark');
    const { projectContext, setProjectContext, disabledWidgetTypes, setDisabledWidgetTypes } = useConfigStore();
    const [projectDraft, setProjectDraft] = useState(projectContext || '');
    const [projectSavedAt, setProjectSavedAt] = useState<string | null>(null);

    useEffect(() => {
        setProjectDraft(projectContext || '');
    }, [projectContext]);

    const navGroups = [
        {
            label: 'Workspace',
            items: [
                { name: 'General', icon: 'settings' },
                { name: 'Admin & Security', icon: 'security' },
                { name: 'Members', icon: 'group' },
                { name: 'Billing', icon: 'payments' },
            ]
        },
        {
            label: 'User Settings',
            items: [
                { name: 'Profile', icon: 'person' },
                { name: 'Notifications', icon: 'notifications' },
                { name: 'API Keys', icon: 'key' },
            ]
        }
    ];

    const widgetTypes = [
        { key: 'kpi', label: 'KPI Cards', desc: 'Single metric cards' },
        { key: 'line', label: 'Line Charts', desc: 'Time-series trends' },
        { key: 'area', label: 'Area Charts', desc: 'Filled trend charts' },
        { key: 'bar', label: 'Bar Charts', desc: 'Comparisons across categories' },
        { key: 'pie', label: 'Pie Charts', desc: 'Proportional breakdown' },
        { key: 'donut', label: 'Donut Charts', desc: 'Ring breakdowns' },
        { key: 'scatter', label: 'Scatter Charts', desc: 'Correlation analysis' },
        { key: 'map', label: 'Map Charts', desc: 'Geographic metrics' },
        { key: 'funnel', label: 'Funnel Charts', desc: 'Stage conversion' },
        { key: 'cohort', label: 'Cohort Charts', desc: 'Retention analysis' },
        { key: 'table', label: 'Tables', desc: 'Detailed records' },
        { key: 'markdown', label: 'Markdown', desc: 'Narrative blocks' },
    ];

    const toggleWidgetType = (type: string) => {
        const current = new Set(disabledWidgetTypes || []);
        if (current.has(type)) {
            current.delete(type);
        } else {
            current.add(type);
        }
        setDisabledWidgetTypes(Array.from(current));
    };

    return (
        <div className="flex flex-1 h-full overflow-hidden">
            {/* Settings Side Nav */}
            <aside className="w-64 border-r border-[#2d3748] bg-[#111318] flex flex-col shrink-0">
                <div className="flex-1 overflow-y-auto p-4 space-y-8">
                    {navGroups.map((group) => (
                        <div key={group.label} className="space-y-2">
                            <h3 className="px-3 text-[11px] font-bold text-slate-500 uppercase tracking-widest">{group.label}</h3>
                            <nav className="space-y-1">
                                {group.items.map((item) => (
                                    <button
                                        key={item.name}
                                        onClick={() => setActiveTab(item.name)}
                                        className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === item.name
                                            ? 'bg-[#135bec]/10 text-white'
                                            : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
                                            }`}
                                    >
                                        <span className={`material-symbols-outlined text-[18px] ${activeTab === item.name ? 'text-[#135bec]' : ''}`}>
                                            {item.icon}
                                        </span>
                                        {item.name}
                                    </button>
                                ))}
                            </nav>
                        </div>
                    ))}
                </div>

                {/* Pro Plan Card */}
                <div className="p-4 border-t border-[#2d3748]">
                    <div className="bg-gradient-to-br from-[#1e2532] to-[#111318] border border-[#2d3748] rounded-xl p-4 relative overflow-hidden group">
                        <div className="absolute top-0 right-0 w-16 h-16 bg-[#135bec]/20 blur-2xl rounded-full -mr-8 -mt-8 group-hover:bg-[#135bec]/30 transition-colors"></div>
                        <div className="flex items-center gap-2 mb-2">
                            <span className="material-symbols-outlined text-[#135bec] text-[18px]">workspace_premium</span>
                            <span className="text-sm font-bold text-white">Pro Plan</span>
                        </div>
                        <p className="text-[11px] text-slate-400 leading-relaxed mb-4">
                            Your team has access to advanced AI features and priority support.
                        </p>
                        <button className="w-full py-2 bg-[#135bec] text-white rounded-lg text-xs font-bold hover:bg-blue-600 transition-colors shadow-lg shadow-blue-900/20">
                            Manage Subscription
                        </button>
                    </div>
                </div>
            </aside>

            {/* Main Settings Content */}
            <main className="flex-1 overflow-y-auto bg-[#0b0d11] p-10 canvas-grid">
                <div className="max-w-4xl mx-auto space-y-10">
                    {/* Header */}
                    <div className="space-y-2">
                        <h1 className="text-3xl font-bold text-white">Admin Settings</h1>
                        <p className="text-slate-400 max-w-2xl">
                            Configure global workspace settings, manage team access, and customize the AI Studio experience.
                        </p>
                    </div>

                    {/* Rendering different tabs */}
                    {activeTab === 'General' ? (
                        <div className="bg-[#111318] border border-[#2d3748] rounded-2xl overflow-hidden shadow-xl">
                            <div className="p-6 border-b border-[#2d3748] flex items-center justify-between">
                                <div>
                                    <h2 className="text-lg font-bold text-white">Widget Visibility</h2>
                                    <p className="text-xs text-slate-500 mt-0.5">
                                        Disable widget types to prevent the planner from using them.
                                    </p>
                                </div>
                                <button
                                    onClick={() => setDisabledWidgetTypes([])}
                                    className="px-3 py-1.5 rounded-lg border border-[#2d3748] text-[11px] font-bold text-slate-300 hover:text-white hover:bg-white/5 transition-all"
                                >
                                    Enable All
                                </button>
                            </div>
                            <div className="p-8 grid grid-cols-2 gap-4">
                                {widgetTypes.map((item) => {
                                    const disabled = (disabledWidgetTypes || []).includes(item.key);
                                    return (
                                        <button
                                            key={item.key}
                                            onClick={() => toggleWidgetType(item.key)}
                                            className={`p-4 rounded-xl border text-left transition-all ${disabled
                                                ? 'border-red-500/40 bg-red-500/5 text-red-200'
                                                : 'border-[#2d3748] bg-[#0f1218] text-white hover:border-[#135bec]/60'
                                                }`}
                                        >
                                            <div className="flex items-center justify-between">
                                                <span className="text-sm font-bold">{item.label}</span>
                                                <span className={`text-[10px] font-black uppercase tracking-widest ${disabled ? 'text-red-300' : 'text-emerald-300'}`}>
                                                    {disabled ? 'Disabled' : 'Enabled'}
                                                </span>
                                            </div>
                                            <p className="text-[11px] text-slate-400 mt-2">{item.desc}</p>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    ) : activeTab === 'Profile' ? (
                        <div className="bg-[#111318] border border-[#2d3748] rounded-2xl overflow-hidden shadow-xl">
                            <div className="p-8 flex items-start gap-10">
                                <div className="flex flex-col items-center gap-4">
                                    <div className="w-24 h-24 rounded-3xl bg-[#135bec]/20 border border-[#135bec]/40 flex items-center justify-center text-[32px] font-black text-[#135bec] shadow-2xl shadow-blue-900/10">
                                        M
                                    </div>
                                    <button className="px-4 py-2 bg-white/5 border border-white/10 rounded-xl text-[10px] font-black uppercase tracking-widest text-slate-300 hover:text-white transition-all">
                                        Change Avatar
                                    </button>
                                </div>
                                <div className="flex-1 space-y-6">
                                    <div className="grid grid-cols-2 gap-6">
                                        <div className="space-y-2">
                                            <label className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">Full Name</label>
                                            <input type="text" defaultValue="Admin User" className="w-full px-4 py-3 bg-[#0a0d11] border border-[#2d3748] rounded-xl text-sm text-white focus:border-[#135bec]/50 outline-none transition-all" />
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">Email Address</label>
                                            <input type="email" defaultValue="admin@luman.ai" className="w-full px-4 py-3 bg-[#0a0d11] border border-[#2d3748] rounded-xl text-sm text-white focus:border-[#135bec]/50 outline-none transition-all opacity-50 cursor-not-allowed" disabled />
                                        </div>
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">Job Title</label>
                                        <input type="text" defaultValue="Principal Platform Engineer" className="w-full px-4 py-3 bg-[#0a0d11] border border-[#2d3748] rounded-xl text-sm text-white focus:border-[#135bec]/50 outline-none transition-all" />
                                    </div>
                                    <div className="pt-4 border-t border-[#2d3748] flex justify-end gap-3">
                                        <button className="px-6 py-2.5 bg-[#135bec] text-white rounded-xl text-xs font-bold hover:bg-blue-600 transition-all shadow-lg shadow-blue-900/20 active:scale-95">
                                            Save Profile
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="bg-[#111318] border border-[#2d3748] rounded-2xl overflow-hidden shadow-xl">
                            <div className="p-6 border-b border-[#2d3748] flex items-center justify-between">
                                <div>
                                    <h2 className="text-lg font-bold text-white">Theme & Branding</h2>
                                    <p className="text-xs text-slate-500 mt-0.5">Customize the look and feel of your workspace dashboards.</p>
                                </div>
                                <button className="px-3 py-1.5 rounded-lg border border-[#2d3748] text-[11px] font-bold text-slate-300 hover:text-white hover:bg-white/5 transition-all">
                                    Reset to Default
                                </button>
                            </div>

                            <div className="p-8 space-y-10">
                                <div className="grid grid-cols-12 gap-10">
                                    {/* Brand Color */}
                                    <div className="col-span-6 space-y-4">
                                        <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Primary Brand Color</label>
                                        <div className="flex items-center gap-3">
                                            <div className="w-10 h-10 rounded-lg bg-[#135bec] shadow-lg shadow-blue-900/20 flex-shrink-0 cursor-pointer"></div>
                                            <div className="flex-1 bg-[#1a202c] border border-[#2d3748] rounded-lg px-4 py-2 flex items-center justify-between group focus-within:border-[#135bec] transition-colors">
                                                <span className="text-sm font-mono text-slate-300">#135bec</span>
                                                <span className="material-symbols-outlined text-slate-500 text-[18px]">colorize</span>
                                            </div>
                                        </div>
                                        <p className="text-[10px] text-slate-500 leading-normal">
                                            This color will be used for buttons, links, and active states.
                                        </p>
                                    </div>

                                    {/* Logo Upload */}
                                    <div className="col-span-6 space-y-4">
                                        <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Logo Upload</label>
                                        <div className="border-2 border-dashed border-[#2d3748] rounded-xl p-6 flex flex-col items-center justify-center gap-3 bg-[#1a202c]/30 hover:bg-[#1a202c]/50 hover:border-[#135bec]/50 transition-all cursor-pointer group">
                                            <span className="material-symbols-outlined text-slate-500 text-[32px] group-hover:text-[#135bec] transition-colors">cloud_upload</span>
                                            <div className="text-center">
                                                <p className="text-xs font-bold text-white"><span className="text-[#135bec]">Click to upload</span> or drag and drop</p>
                                                <p className="text-[10px] text-slate-500 mt-1">SVG, PNG, JPG (MAX. 800×400px)</p>
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                {/* Interface Theme Selection */}
                                <div className="space-y-4">
                                    <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Interface Theme</label>
                                    <div className="grid grid-cols-3 gap-4">
                                        {[
                                            { id: 'dark', name: 'Dark Mode', color: '#101622', accent: '#3b82f6' },
                                            { id: 'light', name: 'Light Mode', color: '#f6f6f8', accent: '#3b82f6' },
                                            { id: 'high-contrast', name: 'High Contrast', color: '#000000', accent: '#a855f7' }
                                        ].map((t) => (
                                            <div
                                                key={t.id}
                                                onClick={() => setTheme(t.id as any)}
                                                className="space-y-3 group cursor-pointer"
                                            >
                                                <div className={`aspect-video rounded-xl border-2 transition-all p-2 flex flex-col gap-1.5 ${theme === t.id ? 'border-[#135bec] ring-4 ring-[#135bec]/10' : 'border-[#2d3748] group-hover:border-slate-600'
                                                    }`} style={{ backgroundColor: t.id === 'light' ? '#e2e8f0' : '#1a202c' }}>
                                                    <div className="w-1/2 h-2 rounded-full bg-slate-700/50"></div>
                                                    <div className="flex gap-1.5 flex-1">
                                                        <div className="w-1/3 rounded-lg border border-white/5" style={{ backgroundColor: t.color }}></div>
                                                        <div className="flex-1 flex flex-col gap-1.5">
                                                            <div className="h-2 w-full rounded-full bg-slate-700/30"></div>
                                                            <div className="h-2 w-2/3 rounded-full bg-slate-700/30"></div>
                                                            <div className="mt-auto flex justify-end">
                                                                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: t.accent }}></div>
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                                <div className="flex items-center justify-between px-1">
                                                    <span className={`text-xs font-medium ${theme === t.id ? 'text-white' : 'text-slate-500'}`}>{t.name}</span>
                                                    {theme === t.id && (
                                                        <div className="w-4 h-4 rounded-full bg-[#135bec] flex items-center justify-center">
                                                            <span className="material-symbols-outlined text-white text-[12px] font-bold">check</span>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Feature Flags Card */}
                    <div className="bg-[#111318] border border-[#2d3748] rounded-2xl overflow-hidden shadow-xl">
                        <div className="p-6 border-b border-[#2d3748]">
                            <h2 className="text-lg font-bold text-white">Feature Flags</h2>
                            <p className="text-xs text-slate-500 mt-0.5">Manage beta features and experimental functionality.</p>
                        </div>
                        <div className="divide-y divide-[#2d3748]">
                            <div className="p-6 flex items-center justify-between hover:bg-white/5 transition-colors">
                                <div className="space-y-1">
                                    <div className="flex items-center gap-2">
                                        <h3 className="text-sm font-bold text-white">AI Copilot v2.0</h3>
                                        <span className="px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400 text-[9px] font-bold uppercase border border-purple-500/20">Beta</span>
                                    </div>
                                    <p className="text-xs text-slate-500">Enable the new LLM-powered assistant for complex SQL generation.</p>
                                </div>
                                <label className="relative inline-flex items-center cursor-pointer">
                                    <input type="checkbox" defaultChecked className="sr-only peer" />
                                    <div className="w-11 h-6 bg-gray-600 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#135bec]"></div>
                                </label>
                            </div>

                            <div className="p-6 flex items-center justify-between hover:bg-white/5 transition-colors">
                                <div className="space-y-1">
                                    <div className="flex items-center gap-2">
                                        <h3 className="text-sm font-bold text-white">Real-time Collaboration</h3>
                                        <span className="px-1.5 py-0.5 rounded bg-orange-500/10 text-orange-400 text-[9px] font-bold uppercase border border-orange-500/20">Alpha</span>
                                    </div>
                                    <p className="text-xs text-slate-500">Allow multiple team members to edit dashboards simultaneously.</p>
                                </div>
                                <label className="relative inline-flex items-center cursor-pointer">
                                    <input type="checkbox" className="sr-only peer" />
                                    <div className="w-11 h-6 bg-gray-600 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#135bec]"></div>
                                </label>
                            </div>
                        </div>
                    </div>
                </div>
            </main>
        </div>
    );
};

export default SettingsView;
