'use client';

import React, { useState } from 'react';
import { PlanStep } from '@/types/studio';

interface PlanViewerProps {
    plan: PlanStep[];
}

const PlanViewer: React.FC<PlanViewerProps> = ({ plan }) => {
    const [isExpanded, setIsExpanded] = useState(true);

    return (
        <div className="flex flex-col shrink-0 border-t border-[#2d3748]">
            <div
                onClick={() => setIsExpanded(!isExpanded)}
                className="flex items-center justify-between px-4 py-3 bg-[#1a202c]/40 cursor-pointer group hover:bg-[#1a202c]/60 transition-colors border-b border-[#2d3748]/50"
            >
                <h3 className="text-[11px] font-extrabold text-white uppercase tracking-[2px] flex items-center gap-2.5">
                    <span className="material-symbols-outlined text-[#135bec] text-[20px]">assignment</span>
                    Plan Viewer
                </h3>
                <button className={`text-slate-500 group-hover:text-white transition-all ${isExpanded ? '' : 'rotate-180'}`}>
                    <span className="material-symbols-outlined text-[20px]">expand_more</span>
                </button>
            </div>

            {isExpanded && (
                <div className="flex flex-col max-h-[600px] overflow-hidden animate-slide-in-top">
                    {/* Steps List */}
                    <div className="p-5 space-y-5 bg-[#111318]">
                        {plan.map((step) => (
                            <div key={step.id} className="flex items-start gap-4">
                                <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${step.status === 'completed' ? 'bg-green-500 text-[#111318]' :
                                        step.status === 'processing' ? 'bg-blue-500/20 text-blue-500 border border-blue-500/40' :
                                            'bg-slate-800 text-slate-600'
                                    }`}>
                                    <span className="material-symbols-outlined text-[14px] font-bold">
                                        {step.status === 'completed' ? 'check' : step.status === 'processing' ? 'sync' : 'radio_button_unchecked'}
                                    </span>
                                </div>
                                <div className="flex-1 flex flex-col">
                                    <div className="flex justify-between items-center">
                                        <span className={`text-[11px] font-extrabold uppercase tracking-wider ${step.status === 'completed' ? 'text-slate-400' :
                                                step.status === 'processing' ? 'text-white' : 'text-slate-600'
                                            }`}>
                                            {step.label}
                                        </span>
                                        {step.status === 'processing' && (
                                            <span className="px-2 py-0.5 rounded-full bg-blue-500/10 text-[8px] font-bold text-blue-400 uppercase tracking-widest border border-blue-500/20 animate-pulse">
                                                Processing
                                            </span>
                                        )}
                                        {step.status === 'completed' && (
                                            <span className="material-symbols-outlined text-green-500 text-[16px] font-bold">check</span>
                                        )}
                                    </div>

                                    {/* Fields Selected specifically for the active step */}
                                    {step.status === 'processing' && step.id === 'p3' && (
                                        <div className="mt-5 p-4 rounded-xl bg-[#1a202c]/50 border border-[#135bec]/20 space-y-4 shadow-xl">
                                            <div className="flex items-center gap-2">
                                                <span className="material-symbols-outlined text-slate-500 text-[16px]">grid_view</span>
                                                <h4 className="text-[10px] font-extrabold text-slate-400 uppercase tracking-widest">Fields Selected</h4>
                                            </div>
                                            <div className="flex flex-wrap gap-1.5">
                                                <div className="px-2.5 py-1 rounded bg-indigo-500/10 border border-indigo-500/30 text-[10px] font-mono text-indigo-300 flex items-center gap-2">
                                                    <span className="w-1.5 h-1.5 rounded-full bg-indigo-500"></span>
                                                    revenue
                                                </div>
                                                <div className="px-2.5 py-1 rounded bg-indigo-500/10 border border-indigo-500/30 text-[10px] font-mono text-indigo-300 flex items-center gap-2">
                                                    <span className="w-1.5 h-1.5 rounded-full bg-indigo-500"></span>
                                                    product_name
                                                </div>
                                                <div className="px-2.5 py-1 rounded bg-indigo-500/10 border border-indigo-500/30 text-[10px] font-mono text-indigo-300 flex items-center gap-2">
                                                    <span className="w-1.5 h-1.5 rounded-full bg-indigo-500"></span>
                                                    week
                                                </div>
                                            </div>
                                            <div className="grid grid-cols-2 gap-2 pt-2">
                                                <button className="py-2.5 bg-[#135bec] text-white rounded-lg text-[11px] font-bold uppercase tracking-widest hover:bg-blue-600 transition-all shadow-lg shadow-blue-900/20 active:scale-[0.98]">
                                                    Apply
                                                </button>
                                                <div className="flex gap-2">
                                                    <button className="flex-1 py-2.5 border border-[#2d3748] rounded-lg text-[11px] font-bold text-slate-400 hover:text-white hover:bg-white/5 transition-all">Undo</button>
                                                    <button className="px-3 py-2.5 border border-[#2d3748] rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition-all flex items-center justify-center">
                                                        <span className="material-symbols-outlined text-[18px]">refresh</span>
                                                    </button>
                                                </div>
                                            </div>
                                            <div className="pt-2 flex items-center gap-1.5">
                                                <span className="text-[10px] font-bold text-slate-600 uppercase tracking-tighter">Ask:</span>
                                                <button className="text-[10px] font-bold text-[#135bec] hover:underline underline-offset-2">Which region? +</button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

export default PlanViewer;
