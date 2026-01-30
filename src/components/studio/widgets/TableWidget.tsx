'use client';

import React, { useMemo, useState } from 'react';
import { Widget } from '@/types/studio';

interface TableWidgetProps {
    widget: Widget;
    isSelected: boolean;
}

const TableWidget: React.FC<TableWidgetProps> = ({ widget, isSelected }) => {
    const isSkuList = widget.id.includes('sku');
    const [searchTerm, setSearchTerm] = useState('');

    const dataRows = Array.isArray(widget.data) ? widget.data : [];
    const columns = dataRows[0] ? Object.keys(dataRows[0]) : [];
    const filteredRows = useMemo(() => {
        if (!searchTerm.trim()) return dataRows;
        const needle = searchTerm.trim().toLowerCase();
        return dataRows.filter((row: Record<string, any>) =>
            columns.some((key) => String(row?.[key] ?? '').toLowerCase().includes(needle))
        );
    }, [columns, dataRows, searchTerm]);

    return (
        <div className={`bg-[#111318] border rounded-2xl overflow-hidden transition-all duration-500 flex flex-col h-full ${isSelected
            ? 'border-[#135bec] border-2 shadow-[0_0_50px_rgba(19,91,236,0.15)] ring-4 ring-[#135bec]/10 translate-y-[-2px]'
            : 'border-slate-800 hover:border-slate-700 shadow-xl'
            }`}>
            {/* Header Bar */}
            <div className="bg-[#1a202c]/40 px-4 py-2 border-b border-[#2d3748] flex items-center gap-3">
                <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-slate-600 text-[14px]">drag_indicator</span>
                    <span className="text-[9px] font-extrabold text-slate-500 uppercase tracking-[2px] flex items-center gap-1.5">
                        <span className="material-symbols-outlined text-[14px] text-[#135bec]">table_chart</span>
                        Widget: {widget.id.toUpperCase()}
                    </span>
                </div>
            </div>

            <div className="p-6 border-b border-slate-800/50 flex flex-wrap gap-4 items-center justify-between">
                <div>
                    <h3 className="text-lg font-bold text-white tracking-tight">{widget.title}</h3>
                    <div className="text-[10px] uppercase tracking-[2px] text-slate-500 font-extrabold">
                        Rows: {filteredRows.length}
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <div className="relative">
                        <span className="material-symbols-outlined text-[16px] text-slate-500 absolute left-3 top-1/2 -translate-y-1/2">search</span>
                        <input
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            placeholder="Search table..."
                            className="pl-9 pr-8 py-2 text-xs bg-[#0b0f16] border border-[#1b2230] rounded-lg text-slate-300 placeholder-slate-600 focus:outline-none focus:border-[#135bec]/60"
                        />
                        {searchTerm && (
                            <button
                                onClick={() => setSearchTerm('')}
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white"
                                aria-label="Clear search"
                            >
                                <span className="material-symbols-outlined text-[16px]">close</span>
                            </button>
                        )}
                    </div>
                    <button className="text-slate-500 hover:text-white p-1.5 rounded-lg hover:bg-white/5 transition-colors">
                        <span className="material-symbols-outlined text-[20px]">{isSkuList ? 'filter_list' : 'download'}</span>
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto scrollbar-hide">
                {filteredRows.length > 0 ? (
                    <table className="w-full text-left text-[11px] border-collapse">
                        <thead className="bg-[#1a202c]/20 text-slate-500 font-extrabold uppercase tracking-widest border-b border-slate-800/50 sticky top-0 backdrop-blur-sm z-10">
                            <tr>
                                {columns.map((key) => (
                                    <th key={key} className="px-6 py-4 whitespace-nowrap">
                                        {key.replace(/_/g, ' ')}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody className="text-slate-300 divide-y divide-slate-800/40">
                            {filteredRows.map((row: any, idx: number) => (
                                <tr key={idx} className="hover:bg-white/5 transition-colors group">
                                    {columns.map((key) => {
                                        const val = row[key];
                                        return (
                                            <td key={key} className="px-6 py-5">
                                                {typeof val === 'number'
                                                    ? <span className="font-mono text-white">{val.toLocaleString()}</span>
                                                    : <span className="font-bold text-slate-300">{String(val ?? '-')}</span>
                                                }
                                            </td>
                                        );
                                    })}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                ) : (
                    <div className="flex items-center justify-center h-48 text-slate-500 text-xs uppercase font-bold tracking-widest">
                        {dataRows.length > 0 ? 'No matches found' : 'No Data Available'}
                    </div>
                )}
            </div>
        </div>
    );
};

export default TableWidget;
