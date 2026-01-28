'use client';

import React from 'react';

interface AiInsightsWidgetProps {
    insights?: string[];
}

const AiInsightsWidget: React.FC<AiInsightsWidgetProps> = ({ insights = [] }) => {
    if (insights.length === 0) return null;

    return (
        <div className="relative group perspective-1000">
            {/* Animated Glow Backdrop */}
            <div className="absolute -inset-1 bg-gradient-to-r from-[#135bec] via-[#4f46e5] to-[#7c3aed] rounded-[28px] blur-sm opacity-10 group-hover:opacity-25 transition duration-1000 group-hover:duration-200"></div>

            <div className="relative bg-[#0d1117]/80 backdrop-blur-3xl border border-white/5 rounded-[24px] p-10 overflow-hidden shadow-[0_20px_50px_rgba(0,0,0,0.5)]">
                {/* HUD Grid Overlay */}
                <div className="absolute inset-0 opacity-[0.03] pointer-events-none bg-[url('https://www.transparenttextures.com/patterns/carbon-fibre.png')]"></div>
                <div className="absolute top-0 right-0 w-80 h-80 bg-[#135bec]/10 blur-[120px] rounded-full -mr-40 -mt-40"></div>

                <div className="flex flex-col lg:flex-row gap-10 items-start relative z-10">
                    <div className="flex-shrink-0 relative">
                        <div className="w-16 h-16 rounded-2xl bg-gradient-to-tr from-[#135bec] to-[#4f46e5] flex items-center justify-center text-white shadow-[0_0_30px_rgba(19,91,236,0.4)] transform group-hover:scale-110 transition duration-500">
                            <span className="material-symbols-outlined text-[34px] font-black">insights</span>
                        </div>
                        <div className="absolute -bottom-2 -right-2 w-6 h-6 rounded-lg bg-[#0d1117] border border-white/10 flex items-center justify-center">
                            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
                        </div>
                    </div>

                    <div className="flex-1 space-y-6">
                        <h3 className="text-xs font-black text-white uppercase tracking-[4px]">Insights</h3>

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                            {insights.map((insight, idx) => (
                                <div
                                    key={idx}
                                    className="relative p-5 bg-white/2 border border-white/5 rounded-2xl transition-all duration-300 hover:bg-white/5 hover:border-white/10 group/item"
                                >
                                    <div className="absolute top-0 left-0 w-1 h-0 bg-[#135bec] group-hover/item:h-full transition-all duration-500 rounded-l-2xl"></div>
                                    <p className="text-slate-300 text-[13px] leading-relaxed font-medium">
                                        {insight}
                                    </p>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default AiInsightsWidget;
