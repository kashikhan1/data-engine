'use client';

import React from 'react';
import { Widget } from '@/types/studio';
import KpiCard from './widgets/KpiCard';
import ChartWidget from './widgets/ChartWidget';
import TableWidget from './widgets/TableWidget';
import AiInsightsWidget from './widgets/AiInsightsWidget';

interface DashboardCanvasProps {
    widgets: Widget[];
    selectedWidgetId: string | null;
    onSelectWidget: (id: string) => void;
}

const DashboardCanvas: React.FC<DashboardCanvasProps> = ({ widgets, selectedWidgetId, onSelectWidget }) => {
    const kpis = widgets.filter(w => w.type === 'kpi');
    const otherWidgets = widgets.filter(w => w.type !== 'kpi');

    return (
        <section className="flex-1 flex flex-col bg-bg-dark relative overflow-hidden h-full">
            {/* Canvas Top Bar */}
            <div className="h-20 shrink-0 border-b border-border-dark flex items-center justify-between px-8 bg-black/10">
                <div>
                    <h2 className="text-xl font-black text-white tracking-tight uppercase font-sans">Sales Performance Dashboard</h2>
                    <div className="flex items-center gap-3 mt-1">
                        <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest px-2 py-0.5 rounded bg-white/5 border border-white/5">Q4 2023 Analysis</span>
                        <span className="text-[10px] text-primary font-bold uppercase tracking-widest px-2 py-0.5 rounded bg-primary/10 border border-primary/20 flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse"></span>
                            Live Data
                        </span>
                    </div>
                </div>

                <div className="flex items-center gap-3">
                    <div className="flex items-center bg-black/20 p-1 rounded-xl border border-border-dark">
                        <button className="px-3 py-1.5 text-[10px] font-black uppercase text-white bg-primary rounded-lg shadow-lg">Desktop</button>
                        <button className="px-3 py-1.5 text-[10px] font-black uppercase text-slate-500 hover:text-slate-300">Tablet</button>
                        <button className="px-3 py-1.5 text-[10px] font-black uppercase text-slate-500 hover:text-slate-300">Mobile</button>
                    </div>
                    <div className="h-6 w-px bg-border-dark mx-1"></div>
                    <button className="p-2.5 bg-white/5 border border-white/5 rounded-xl text-slate-400 hover:text-white transition-all"><span className="material-symbols-outlined text-[18px]">tune</span></button>
                    <button className="p-2.5 bg-white/5 border border-white/5 rounded-xl text-slate-400 hover:text-white transition-all"><span className="material-symbols-outlined text-[18px]">more_vert</span></button>
                </div>
            </div>

            {/* Grid Content Area */}
            <div className="flex-1 overflow-y-auto p-5 custom-scrollbar canvas-grid">
                <div className="max-w-[1400px] mx-auto space-y-5 animate-fade-in">
                    {/* Top Section: AI Insights */}
                    <div className="grid grid-cols-12 gap-4">
                        <div className="col-span-12">
                            <AiInsightsWidget />
                        </div>
                    </div>

                    {/* Middle Section: Metrics */}
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 xl:grid-cols-3">
                        {kpis.map(widget => (
                            <div key={widget.id} onClick={() => onSelectWidget(widget.id)} className="cursor-pointer">
                                <KpiCard widget={widget} selected={selectedWidgetId === widget.id} />
                            </div>
                        ))}
                    </div>

                    {/* Main Data Layer */}
                    <div className="grid grid-cols-12 gap-5 pb-8">
                        {otherWidgets.map(widget => (
                            <div
                                key={widget.id}
                                onClick={() => onSelectWidget(widget.id)}
                                className={`cursor-pointer transition-all duration-300 ${widget.id === 'trend_chart_1' ? 'col-span-12' : 'col-span-12 lg:col-span-6'}`}
                            >
                                <div className={`h-full border transition-all rounded-2xl overflow-hidden bg-bg-sidebar shadow-2xl ${selectedWidgetId === widget.id
                                    ? 'border-primary ring-4 ring-primary/10 scale-[1.01]'
                                    : 'border-border-dark hover:border-slate-700'
                                    }`}>
                                    {widget.type === 'table' ? (
                                        <TableWidget widget={widget} isSelected={selectedWidgetId === widget.id} />
                                    ) : (
                                        <ChartWidget widget={widget} isSelected={selectedWidgetId === widget.id} />
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </section>
    );
};

export default DashboardCanvas;
