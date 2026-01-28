'use client';

import React from 'react';
import { Widget } from '@/types/studio';

interface KpiCardProps {
    widget: Widget;
    selected?: boolean;
}

const KpiCard: React.FC<KpiCardProps> = ({ widget, selected }) => {
    const isUp = !widget.title.toLowerCase().includes('size'); // Mock logic for trend color

    const getIcon = (title: string) => {
        if (title.toLowerCase().includes('revenue')) return 'payments';
        if (title.toLowerCase().includes('growth')) return 'show_chart';
        if (title.toLowerCase().includes('size')) return 'shopping_bag';
        return 'analytics';
    };

    return (
        <div className={`relative p-6 rounded-2xl bg-bg-sidebar border transition-all h-full group ${selected
                ? 'border-primary ring-4 ring-primary/5 shadow-[0_0_20px_rgba(19,91,236,0.1)]'
                : 'border-border-dark hover:border-slate-700 shadow-xl'
            }`}>
            <div className="flex justify-between items-start mb-6">
                <div className={`w-11 h-11 rounded-xl flex items-center justify-center ${selected ? 'bg-primary text-white shadow-lg' : 'bg-white/5 text-slate-400 group-hover:text-slate-200'
                    } transition-all`}>
                    <span className="material-symbols-outlined text-[20px]">{getIcon(widget.title)}</span>
                </div>
                <div className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px] font-black uppercase tracking-widest ${isUp ? 'text-green-500 bg-green-500/10' : 'text-red-500 bg-red-500/10'
                    }`}>
                    <span className="material-symbols-outlined text-[14px]">
                        {isUp ? 'trending_up' : 'trending_down'}
                    </span>
                    {isUp ? '+12.5%' : '-2.1%'}
                </div>
            </div>

            <div className="space-y-1">
                <h4 className="text-[11px] font-black text-slate-500 uppercase tracking-[2px]">{widget.title}</h4>
                <div className="flex items-baseline gap-2">
                    <span className="text-2xl font-black text-white tracking-tighter sm:text-3xl">
                        {widget.title.toLowerCase().includes('revenue') ? '$1,245,000' :
                            widget.title.toLowerCase().includes('growth') ? '8.4%' : '$8,500'}
                    </span>
                </div>
                <p className="text-[10px] text-slate-600 font-bold uppercase tracking-widest mt-2">vs. last quarter</p>
            </div>

            {selected && (
                <div className="absolute top-3 right-3 flex items-center gap-1 animate-fade-in">
                    <div className="w-1.5 h-1.5 rounded-full bg-primary shadow-[0_0_8px_rgba(19,91,236,0.8)]"></div>
                    <span className="text-[8px] font-black text-primary uppercase tracking-widest">Selected</span>
                </div>
            )}
        </div>
    );
};

export default KpiCard;
