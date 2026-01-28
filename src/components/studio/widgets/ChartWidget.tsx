'use client';

import React from 'react';
import { Widget } from '@/types/studio';

interface ChartWidgetProps {
    widget: Widget;
    isSelected: boolean;
}

const ChartWidget: React.FC<ChartWidgetProps> = ({ widget, isSelected }) => {
    // Helper to normalize data keys
    const processChartData = (data: any[]) => {
        if (!data || data.length === 0) return [];

        // Find first numeric key for value
        const keys = Object.keys(data[0]);
        const valueKey = keys.find(k => typeof data[0][k] === 'number') || keys[0];
        // Find best candidate for name (string or date), excluding the value key
        const nameKey = keys.find(k => k !== valueKey && (typeof data[0][k] === 'string' || data[0][k] instanceof Date)) || keys.find(k => k !== valueKey) || keys[0];

        return data.map(d => ({
            name: String(d[nameKey]),
            value: Number(d[valueKey]) || 0,
            original: d,
            color: d.color // preserve if exists
        }));
    };

    const chartData = processChartData(widget.data);

    // Simple bar representation for bar_chart
    const renderSimpleBars = () => {
        if (chartData.length === 0) return null;
        const maxValue = Math.max(...chartData.map(d => d.value));
        return (
            <div className="h-full flex items-end justify-around gap-3 px-4 pb-8">
                {chartData.map((item, index) => {
                    const height = maxValue > 0 ? (item.value / maxValue) * 100 : 0;
                    return (
                        <div key={index} className="flex flex-col items-center gap-2 flex-1">
                            <div
                                className="w-full bg-gradient-to-t from-[#135bec] to-[#6366f1] rounded-t-md transition-all duration-500 hover:from-[#1a6af7] hover:to-[#7c7ff2]"
                                style={{ height: `${height}%`, minHeight: '20px' }}
                                title={`${item.name}: ${item.value}`}
                            />
                            <span className="text-[10px] text-slate-500 font-medium truncate w-full text-center">{item.name}</span>
                        </div>
                    );
                })}
            </div>
        );
    };

    // Simple line representation for line_chart
    const renderSimpleLine = () => {
        if (chartData.length === 0) return null;
        const maxValue = Math.max(...chartData.map(d => d.value));
        const minValue = Math.min(...chartData.map(d => d.value));
        const range = maxValue - minValue || 1; // avoid divide by zero

        return (
            <div className="h-full relative px-4 pb-8">
                <svg className="w-full h-full" preserveAspectRatio="none">
                    <defs>
                        <linearGradient id={`gradient-${widget.id}`} x1="0%" y1="0%" x2="0%" y2="100%">
                            <stop offset="0%" stopColor="#135bec" stopOpacity="0.3" />
                            <stop offset="100%" stopColor="#135bec" stopOpacity="0" />
                        </linearGradient>
                    </defs>
                    {/* Area fill */}
                    <path
                        d={`M ${chartData.map((item, index) => {
                            const x = (index / (chartData.length - 1)) * 100;
                            const y = 100 - ((item.value - minValue) / range) * 80;
                            return `${x}%,${y}%`;
                        }).join(' L ')} L 100%,100% L 0%,100% Z`}
                        fill={`url(#gradient-${widget.id})`}
                    />
                    {/* Line */}
                    <polyline
                        points={chartData.map((item, index) => {
                            const x = (index / (chartData.length - 1)) * 100;
                            const y = 100 - ((item.value - minValue) / range) * 80;
                            return `${x}%,${y}%`;
                        }).join(' ')}
                        fill="none"
                        stroke="#135bec"
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />
                    {/* Dots */}
                    {chartData.map((item, index) => {
                        const x = (index / (chartData.length - 1)) * 100;
                        const y = 100 - ((item.value - minValue) / range) * 80;
                        return (
                            <circle
                                key={index}
                                cx={`${x}%`}
                                cy={`${y}%`}
                                r="5"
                                fill="#111318"
                                stroke="#135bec"
                                strokeWidth="2"
                                className="hover:r-7 transition-all"
                            />
                        );
                    })}
                </svg>
                <div className="absolute bottom-0 left-0 right-0 flex justify-between px-4">
                    {chartData.map((item, index) => (
                        <span key={index} className="text-[10px] text-slate-500 font-mono">{item.name}</span>
                    ))}
                </div>
            </div>
        );
    };

    // Simple donut representation
    const renderSimpleDonut = () => {
        if (chartData.length === 0) return null;
        const total = chartData.reduce((acc, item) => acc + item.value, 0);
        let currentAngle = 0;

        return (
            <div className="h-full flex items-center justify-center gap-8">
                <div className="relative w-48 h-48">
                    <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
                        {chartData.map((item, index) => {
                            const percentage = total > 0 ? item.value / total : 0;
                            const startAngle = currentAngle;
                            const endAngle = currentAngle + percentage * 360;
                            currentAngle = endAngle;

                            const largeArc = percentage > 0.5 ? 1 : 0;
                            const startX = 50 + 40 * Math.cos((startAngle * Math.PI) / 180);
                            const startY = 50 + 40 * Math.sin((startAngle * Math.PI) / 180);
                            const endX = 50 + 40 * Math.cos((endAngle * Math.PI) / 180);
                            const endY = 50 + 40 * Math.sin((endAngle * Math.PI) / 180);

                            const pathData = `M ${startX} ${startY} A 40 40 0 ${largeArc} 1 ${endX} ${endY}`;
                            const color = item.color || `hsl(${index * 60}, 70%, 50%)`;

                            return (
                                <path
                                    key={index}
                                    d={pathData}
                                    fill="none"
                                    stroke={color}
                                    strokeWidth="12"
                                    strokeLinecap="round"
                                    className="transition-all hover:stroke-[14]"
                                />
                            );
                        })}
                    </svg>
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                        <span className="text-4xl font-extrabold text-white tracking-tighter">{chartData.length}</span>
                        <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Segments</span>
                    </div>
                </div>
                <div className="space-y-3">
                    {chartData.map((item, index) => (
                        <div key={index} className="flex items-center gap-3">
                            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: item.color || `hsl(${index * 60}, 70%, 50%)` }} />
                            <span className="text-xs text-slate-300 font-medium">{item.name}</span>
                            <span className="text-xs text-slate-500 font-mono">{total > 0 ? Math.round((item.value / total) * 100) : 0}%</span>
                        </div>
                    ))}
                </div>
            </div>
        );
    };

    return (
        <div className={`bg-[#111318] border rounded-2xl overflow-hidden transition-all duration-500 flex flex-col group/widget ${isSelected
            ? 'border-[#135bec] border-2 shadow-[0_0_50px_rgba(19,91,236,0.15)] ring-4 ring-[#135bec]/10'
            : 'border-slate-800 hover:border-slate-700 shadow-xl'
            }`}>
            {/* Header Bar - Attached floating style */}
            <div className="bg-[#1a202c]/60 px-4 py-2 border-b border-[#2d3748] flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-slate-600 text-[14px] cursor-grab active:cursor-grabbing">drag_indicator</span>
                    <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-slate-800 border border-white/5">
                        <span className="material-symbols-outlined text-[12px] text-[#135bec]">analytics</span>
                        <span className="text-[9px] font-extrabold text-slate-300 uppercase tracking-[1px]">
                            WIDGET: {widget.id.toUpperCase()}
                        </span>
                    </div>
                </div>
                {isSelected && (
                    <span className="px-2 py-0.5 rounded-full bg-[#135bec] text-white text-[8px] font-black uppercase tracking-widest shadow-lg shadow-[#135bec]/20">Selected</span>
                )}
            </div>

            <div className="p-6 pb-2">
                <div className="flex justify-between items-start mb-6">
                    <div className="space-y-1">
                        <h3 className="text-lg font-bold text-white tracking-tight">{widget.title}</h3>
                        {widget.id.includes('trend') && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded bg-indigo-500/10 border border-indigo-500/20 text-[9px] font-bold text-indigo-400 uppercase tracking-[1px] gap-1.5">
                                <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 shadow-[0_0_8px_#6366f1] animate-pulse"></span>
                                Trend Chart
                            </span>
                        )}
                    </div>
                    <button className="text-slate-500 hover:text-white p-1.5 rounded-lg hover:bg-white/5 transition-colors">
                        <span className="material-symbols-outlined text-[20px]">more_horiz</span>
                    </button>
                </div>

                <div className="h-[280px] w-full relative">
                    {widget.type === 'line_chart' && renderSimpleLine()}
                    {widget.type === 'bar_chart' && renderSimpleBars()}
                    {widget.type === 'donut_chart' && renderSimpleDonut()}
                </div>
            </div>

            {/* Visual handle for selected state */}
            {isSelected && (
                <div className="absolute right-0 top-1/2 -translate-y-1/2 w-1.5 h-12 bg-[#135bec] rounded-l-full shadow-[0_0_15px_#135bec]"></div>
            )}
        </div>
    );
};

export default ChartWidget;
