'use client';

import React, { useState } from 'react';
import { Widget, DataSource } from '@/types/studio';

interface InspectorSidebarProps {
    currentView: 'build' | 'data-sources';
    selectedWidget?: Widget;
    selectedDataSource?: DataSource;
    onHide?: () => void;
}

const InspectorSidebar: React.FC<InspectorSidebarProps> = ({ currentView, selectedWidget, selectedDataSource, onHide }) => {
    const [activeTab, setActiveTab] = useState<'content' | 'style' | 'interaction'>('content');

    return (
        <aside className="w-[320px] flex flex-col border-l border-[#2d3748] bg-[#111318] shrink-0 relative shadow-2xl z-20">
            <div className="flex border-b border-[#2d3748] bg-[#1a202c]/40">
                {(['content', 'style', 'interaction'] as const).map((tab) => (
                    <button
                        key={tab}
                        onClick={() => setActiveTab(tab)}
                        className={`flex-1 py-3 text-[10px] font-extrabold uppercase transition-all tracking-[2px] relative ${activeTab === tab ? 'text-white' : 'text-slate-500 hover:text-slate-300'
                            }`}
                    >
                        {tab}
                        {activeTab === tab && <div className="absolute bottom-0 left-0 w-full h-0.5 bg-[#135bec]"></div>}
                    </button>
                ))}
            </div>

            <div className="flex-1 overflow-y-auto scrollbar-hide bg-[#0b0d11]">
                {currentView === 'build' && !selectedWidget && (
                    <div className="p-12 text-center text-slate-600 flex flex-col items-center gap-6 mt-20 opacity-40">
                        <span className="material-symbols-outlined text-[64px]">ads_click</span>
                        <div className="space-y-2">
                            <p className="text-sm font-bold uppercase tracking-widest">No Widget Selected</p>
                            <p className="text-xs leading-relaxed">Select a component on the canvas to configure its data and appearance.</p>
                        </div>
                    </div>
                )}

                {currentView === 'data-sources' && !selectedDataSource && (
                    <div className="p-12 text-center text-slate-600 flex flex-col items-center gap-6 mt-20 opacity-40">
                        <span className="material-symbols-outlined text-[64px]">database</span>
                        <div className="space-y-2">
                            <p className="text-sm font-bold uppercase tracking-widest">No Source Selected</p>
                            <p className="text-xs leading-relaxed">Select a data node from the fleet to view its configuration and health metrics.</p>
                        </div>
                    </div>
                )}

                {currentView === 'data-sources' && selectedDataSource && (
                    <div className="animate-slide-in-right divide-y divide-[#2d3748]/30 pb-20">
                        <div className="p-5 bg-[#1a202c]/10">
                            <div className="flex items-center justify-between mb-4">
                                <span className="text-[9px] font-extrabold uppercase tracking-[2px] text-slate-600">Active Node</span>
                                <span className="text-[10px] font-mono text-slate-600">{selectedDataSource.id}</span>
                            </div>
                            <div className="flex items-center gap-4">
                                <div className="w-10 h-10 rounded-xl bg-[#135bec]/20 text-[#135bec] flex items-center justify-center shadow-lg shadow-[#135bec]/5">
                                    <span className="material-symbols-outlined text-[24px]">{selectedDataSource.icon}</span>
                                </div>
                                <div>
                                    <h3 className="text-md font-bold text-white tracking-tight truncate">{selectedDataSource.name}</h3>
                                    <div className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">{selectedDataSource.type}</div>
                                </div>
                            </div>
                        </div>

                        <div className="p-5 space-y-6">
                            <div className="space-y-3">
                                <label className="text-[9px] font-extrabold text-slate-500 uppercase tracking-widest">Resource URI</label>
                                <div className="bg-[#1a202c] border border-[#2d3748] rounded-xl px-4 py-3 font-mono text-[10px] text-slate-300 break-all">
                                    {selectedDataSource.details || 'Internal Storage'}
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-1.5">
                                    <label className="text-[8px] font-black text-slate-500 uppercase tracking-widest">Status</label>
                                    <div className={`text-xs font-bold uppercase tracking-widest ${selectedDataSource.status === 'Connected' ? 'text-green-400' : 'text-red-400'}`}>
                                        {selectedDataSource.status}
                                    </div>
                                </div>
                                <div className="space-y-1.5">
                                    <label className="text-[8px] font-black text-slate-500 uppercase tracking-widest">Last Pulse</label>
                                    <div className="text-xs font-bold text-slate-300">
                                        {selectedDataSource.lastSync}
                                    </div>
                                </div>
                            </div>

                            <div className="space-y-3 pt-4">
                                <label className="text-[9px] font-extrabold text-slate-500 uppercase tracking-widest">Telemetry</label>
                                <div className="space-y-4">
                                    <div className="space-y-1.5">
                                        <div className="flex justify-between text-[9px] font-bold tracking-widest uppercase">
                                            <span className="text-slate-500">Node Load</span>
                                            <span className="text-white">12%</span>
                                        </div>
                                        <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                                            <div className="h-full w-[12%] bg-blue-500"></div>
                                        </div>
                                    </div>
                                    <div className="space-y-1.5">
                                        <div className="flex justify-between text-[9px] font-bold tracking-widest uppercase">
                                            <span className="text-slate-500">Memory Usage</span>
                                            <span className="text-white">45MB</span>
                                        </div>
                                        <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                                            <div className="h-full w-[25%] bg-green-500"></div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {currentView === 'build' && selectedWidget && (
                    <div className="animate-slide-in-right divide-y divide-[#2d3748]/30 pb-20">
                        {/* Widget Context */}
                        <div className="p-5 bg-[#1a202c]/10">
                            <div className="flex items-center justify-between mb-4">
                                <span className="text-[9px] font-extrabold uppercase tracking-[2px] text-slate-600">Selected Widget</span>
                                <span className="text-[10px] font-mono text-slate-600">id: {selectedWidget.id}</span>
                            </div>
                            <div className="flex items-center gap-4">
                                <div className="w-10 h-10 rounded-xl bg-[#135bec]/20 text-[#135bec] flex items-center justify-center shadow-lg shadow-[#135bec]/5">
                                    <span className="material-symbols-outlined text-[20px]">
                                        {selectedWidget.type === 'line_chart' ? 'show_chart' :
                                            selectedWidget.type === 'table' ? 'table_chart' : 'analytics'}
                                    </span>
                                </div>
                                <h3 className="text-md font-bold text-white tracking-tight truncate">{selectedWidget.title}</h3>
                            </div>
                        </div>

                        {/* Config Panels */}
                        <div className="p-5 space-y-8">
                            {/* Data Section */}
                            <div className="space-y-4">
                                <div className="flex items-center justify-between">
                                    <h4 className="text-[10px] font-black text-white uppercase tracking-[2px] flex items-center gap-2.5">
                                        <span className="material-symbols-outlined text-[#135bec] text-[18px]">database</span>
                                        Data
                                    </h4>
                                    <span className="material-symbols-outlined text-slate-600 text-[18px]">expand_less</span>
                                </div>
                                <div className="space-y-5">
                                    <div className="space-y-2">
                                        <label className="text-[9px] font-extrabold text-slate-500 uppercase tracking-widest">Dimensions (X-Axis)</label>
                                        <div className="bg-[#1a202c] border border-[#2d3748] rounded-xl px-4 py-3 flex items-center justify-between group cursor-pointer hover:border-[#135bec] transition-all shadow-inner">
                                            <div className="flex items-center gap-3">
                                                <span className="material-symbols-outlined text-slate-500 text-[18px]">calendar_month</span>
                                                <span className="text-xs text-white font-mono font-bold tracking-tighter">week_start_date</span>
                                            </div>
                                            <span className="text-[9px] text-[#135bec] font-bold uppercase border border-[#135bec]/20 px-1.5 py-0.5 rounded-md">Weekly</span>
                                        </div>
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-[9px] font-extrabold text-slate-500 uppercase tracking-widest">Measures (Y-Axis)</label>
                                        <div className="bg-[#1a202c] border border-[#2d3748] rounded-xl px-4 py-3 flex items-center justify-between shadow-inner">
                                            <div className="flex items-center gap-3">
                                                <div className="text-[9px] font-black text-[#135bec] border border-[#135bec]/20 rounded-md px-1.5 py-0.5">SUM</div>
                                                <span className="text-xs text-white font-mono font-bold tracking-tighter">revenue</span>
                                            </div>
                                            <span className="material-symbols-outlined text-slate-600 text-[18px] cursor-pointer hover:text-white transition-colors">close</span>
                                        </div>
                                        <button className="text-[10px] font-black text-[#135bec] flex items-center gap-1.5 hover:underline py-1 underline-offset-4">
                                            <span className="material-symbols-outlined text-[16px]">add_circle</span>
                                            Add Measure
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {/* Filters Section */}
                            <div className="space-y-4">
                                <div className="flex items-center justify-between">
                                    <h4 className="text-[10px] font-black text-white uppercase tracking-[2px] flex items-center gap-2.5">
                                        <span className="material-symbols-outlined text-[#135bec] text-[18px]">filter_alt</span>
                                        Filters
                                    </h4>
                                    <span className="material-symbols-outlined text-slate-600 text-[18px]">expand_less</span>
                                </div>
                                <div className="space-y-4">
                                    <div className="bg-[#1a202c] border border-[#2d3748] rounded-xl px-4 py-3 flex items-center justify-between group cursor-pointer hover:border-slate-500 transition-all shadow-inner">
                                        <span className="text-xs text-slate-200 font-bold">Status = Active</span>
                                        <span className="material-symbols-outlined text-slate-600 text-[18px] hover:text-red-400">close</span>
                                    </div>
                                    <label className="flex items-center gap-3 cursor-pointer group">
                                        <div className="relative w-4 h-4 rounded bg-slate-800 border border-slate-700 flex items-center justify-center group-hover:border-[#135bec] transition-all">
                                            <input type="checkbox" className="hidden" />
                                            <div className="w-2 h-2 rounded-sm bg-[#135bec] opacity-0 group-focus-within:opacity-100"></div>
                                        </div>
                                        <span className="text-[10px] font-bold text-slate-400 group-hover:text-white transition-colors uppercase tracking-widest">Override Global Filters</span>
                                    </label>
                                </div>
                            </div>

                            {/* Visualization Section */}
                            <div className="space-y-4">
                                <div className="flex items-center justify-between">
                                    <h4 className="text-[10px] font-black text-white uppercase tracking-[2px] flex items-center gap-2.5">
                                        <span className="material-symbols-outlined text-[#135bec] text-[18px]">auto_graph</span>
                                        Visualization
                                    </h4>
                                    <span className="material-symbols-outlined text-slate-600 text-[18px]">expand_less</span>
                                </div>
                                <div className="space-y-5">
                                    <div className="grid grid-cols-4 gap-2">
                                        <button className={`h-10 border rounded-xl flex items-center justify-center transition-all ${selectedWidget.type === 'line_chart' ? 'border-[#135bec] bg-[#135bec]/10 text-[#135bec] shadow-lg shadow-[#135bec]/5' : 'border-[#2d3748] bg-[#1a202c] text-slate-500 hover:text-white'}`}>
                                            <span className="material-symbols-outlined text-[20px]">show_chart</span>
                                        </button>
                                        <button className={`h-10 border rounded-xl flex items-center justify-center transition-all ${selectedWidget.type === 'bar_chart' ? 'border-[#135bec] bg-[#135bec]/10 text-[#135bec] shadow-lg shadow-[#135bec]/5' : 'border-[#2d3748] bg-[#1a202c] text-slate-500 hover:text-white'}`}>
                                            <span className="material-symbols-outlined text-[20px]">bar_chart</span>
                                        </button>
                                        <button className={`h-10 border rounded-xl flex items-center justify-center transition-all ${selectedWidget.type === 'donut_chart' ? 'border-[#135bec] bg-[#135bec]/10 text-[#135bec] shadow-lg shadow-[#135bec]/5' : 'border-[#2d3748] bg-[#1a202c] text-slate-500 hover:text-white'}`}>
                                            <span className="material-symbols-outlined text-[20px]">pie_chart</span>
                                        </button>
                                        <button className={`h-10 border rounded-xl flex items-center justify-center transition-all ${selectedWidget.type === 'table' ? 'border-[#135bec] bg-[#135bec]/10 text-[#135bec] shadow-lg shadow-[#135bec]/5' : 'border-[#2d3748] bg-[#1a202c] text-slate-500 hover:text-white'}`}>
                                            <span className="material-symbols-outlined text-[20px]">table_chart</span>
                                        </button>
                                    </div>
                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="space-y-3">
                                            <label className="text-[9px] font-extrabold text-slate-500 uppercase tracking-widest">Axes</label>
                                            <div className="space-y-2">
                                                <label className="flex items-center gap-2 cursor-pointer">
                                                    <input type="checkbox" defaultChecked className="w-3 h-3 rounded border-slate-700 bg-slate-800 text-[#135bec] focus:ring-0" />
                                                    <span className="text-[10px] font-bold text-slate-400 uppercase">Show X-Axis</span>
                                                </label>
                                                <label className="flex items-center gap-2 cursor-pointer">
                                                    <input type="checkbox" defaultChecked className="w-3 h-3 rounded border-slate-700 bg-slate-800 text-[#135bec] focus:ring-0" />
                                                    <span className="text-[10px] font-bold text-slate-400 uppercase">Show Y-Axis</span>
                                                </label>
                                            </div>
                                        </div>
                                        <div className="space-y-3">
                                            <label className="text-[9px] font-extrabold text-slate-500 uppercase tracking-widest">Legend</label>
                                            <div className="relative">
                                                <select className="w-full bg-[#1a202c] border border-[#2d3748] text-white text-[10px] font-bold rounded-lg px-3 py-2.5 outline-none appearance-none cursor-pointer focus:border-[#135bec] transition-all shadow-inner uppercase tracking-widest">
                                                    <option>Top</option>
                                                    <option>Bottom</option>
                                                    <option>None</option>
                                                </select>
                                                <span className="absolute right-3 top-1/2 -translate-y-1/2 material-symbols-outlined text-slate-500 text-[18px] pointer-events-none">expand_more</span>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Formatting Section */}
                            <div className="space-y-4">
                                <div className="flex items-center justify-between">
                                    <h4 className="text-[10px] font-black text-white uppercase tracking-[2px] flex items-center gap-2.5">
                                        <span className="material-symbols-outlined text-[#135bec] text-[18px]">format_paint</span>
                                        Formatting
                                    </h4>
                                    <span className="material-symbols-outlined text-slate-600 text-[18px]">expand_less</span>
                                </div>
                                <div className="grid grid-cols-2 gap-4">
                                    <div className="space-y-2">
                                        <label className="text-[9px] font-extrabold text-slate-500 uppercase tracking-widest">Type</label>
                                        <div className="relative">
                                            <select className="w-full bg-[#1a202c] border border-[#2d3748] text-white text-[10px] font-bold rounded-lg px-3 py-2.5 outline-none appearance-none cursor-pointer focus:border-[#135bec] transition-all shadow-inner uppercase">
                                                <option>Currency</option>
                                                <option>Percentage</option>
                                                <option>Number</option>
                                            </select>
                                            <span className="absolute right-3 top-1/2 -translate-y-1/2 material-symbols-outlined text-slate-500 text-[18px] pointer-events-none">expand_more</span>
                                        </div>
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-[9px] font-extrabold text-slate-500 uppercase tracking-widest">Decimals</label>
                                        <input
                                            type="number"
                                            defaultValue="0"
                                            className="w-full bg-[#1a202c] border border-[#2d3748] text-white text-[10px] font-bold rounded-lg px-3 py-2.5 outline-none focus:border-[#135bec] transition-all shadow-inner text-center"
                                        />
                                    </div>
                                </div>
                            </div>

                            {/* Interactions Section */}
                            <div className="space-y-4">
                                <div className="flex items-center justify-between">
                                    <h4 className="text-[10px] font-black text-white uppercase tracking-[2px] flex items-center gap-2.5">
                                        <span className="material-symbols-outlined text-[#135bec] text-[18px]">gesture</span>
                                        Interactions
                                    </h4>
                                    <span className="material-symbols-outlined text-slate-600 text-[18px]">expand_less</span>
                                </div>
                                <div className="flex items-center justify-between px-1">
                                    <span className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">Cross-filter on click</span>
                                    <div className="relative inline-block w-10 h-5 align-middle select-none transition duration-200 ease-in cursor-pointer">
                                        <input type="checkbox" defaultChecked className="absolute block w-5 h-5 rounded-full bg-white border-4 appearance-none cursor-pointer peer checked:right-0 checked:border-[#135bec]" />
                                        <label className="block overflow-hidden h-5 rounded-full bg-slate-700 peer-checked:bg-[#135bec] transition-colors cursor-pointer"></label>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            <div className="p-4 bg-[#111318] border-t border-[#2d3748] flex justify-between items-center text-[10px] font-black uppercase tracking-[2px]">
                <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]"></span>
                    <span className="text-slate-500">Auto-saved</span>
                </div>
                <div className="flex gap-4">
                    <span className="text-slate-500 hover:text-white cursor-pointer transition-colors">JSON</span>
                    <span className="text-slate-300">Mode</span>
                </div>
            </div>
        </aside>
    );
};

export default InspectorSidebar;
