'use client';

import React, { useState } from 'react';
import { ChatMessage, PlanStep } from '@/types/studio';
import PlanViewer from './PlanViewer';

interface CopilotSidebarProps {
    messages: ChatMessage[];
    plan: PlanStep[];
    onSendMessage: (text: string) => void;
    context?: string;
}

const CopilotSidebar: React.FC<CopilotSidebarProps> = ({ messages, plan, onSendMessage, context = 'Sales Dashboard' }) => {
    const [inputValue, setInputValue] = useState('');

    const handleSend = () => {
        if (inputValue.trim()) {
            onSendMessage(inputValue);
            setInputValue('');
        }
    };

    return (
        <aside className="w-80 flex flex-col border-r border-[#2d3748] bg-[#0b0d11] z-[50] shrink-0 relative">
            {/* Sidebar Header */}
            <div className="p-5 border-b border-[#2d3748] flex items-center justify-between bg-black/20">
                <div>
                    <h2 className="text-[13px] font-black text-white uppercase tracking-[2px]">Copilot</h2>
                    <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mt-0.5 opacity-60">Context: {context}</p>
                </div>
                <button className="p-2 text-slate-500 hover:text-white hover:bg-white/5 rounded-xl transition-all" title="New Chat">
                    <span className="material-symbols-outlined text-[20px]">add_comment</span>
                </button>
            </div>

            {/* Chat Messages */}
            <div className="flex-1 overflow-y-auto p-5 space-y-8 custom-scrollbar bg-black/10">
                {messages.map((msg) => (
                    <div key={msg.id} className={`flex gap-4 ${msg.role === 'user' ? 'flex-row-reverse' : ''} animate-fade-in`}>
                        <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 shadow-lg ${msg.role === 'user' ? 'bg-[#1a202c] border border-[#2d3748]' : 'bg-gradient-to-br from-[#135bec] to-[#6366f1] shadow-[0_0_15px_rgba(19,91,236,0.2)]'
                            }`}>
                            {msg.role === 'user' ? (
                                <span className="text-[10px] font-black text-slate-400">YO</span>
                            ) : (
                                <span className="material-symbols-outlined text-white text-[18px]">smart_toy</span>
                            )}
                        </div>
                        <div className={`flex flex-col gap-2 max-w-[85%] ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                            {msg.agent && <div className="text-[10px] font-black text-[#135bec] uppercase tracking-widest mb-0.5 opacity-80">{msg.agent}</div>}
                            <div className={`px-4 py-3.5 rounded-[20px] text-[13px] leading-relaxed border shadow-xl ${msg.role === 'user'
                                    ? 'bg-[#1a202c] text-slate-200 rounded-tr-sm border-[#2d3748] shadow-black/20'
                                    : 'bg-[#111318] text-slate-200 rounded-tl-sm border-[#2d3748] shadow-black/40'
                                }`}>
                                {msg.text}
                            </div>

                            {msg.role === 'assistant' && (
                                <div className="flex flex-wrap gap-2 mt-2">
                                    <button className="px-3 py-1.5 rounded-lg bg-[#1a202c] border border-[#2d3748] text-[9px] font-black text-slate-500 uppercase tracking-widest hover:text-white hover:bg-[#135bec]/10 hover:border-[#135bec]/40 transition-all">
                                        Add Date Filter
                                    </button>
                                    <button className="px-3 py-1.5 rounded-lg bg-[#1a202c] border border-[#2d3748] text-[9px] font-black text-slate-500 uppercase tracking-widest hover:text-white hover:bg-[#135bec]/10 hover:border-[#135bec]/40 transition-all">
                                        Change to Line Chart
                                    </button>
                                </div>
                            )}
                            <span className="text-[9px] text-slate-600 font-bold uppercase tracking-widest">{msg.timestamp}</span>
                        </div>
                    </div>
                ))}
            </div>

            {/* Bottom Area: Plan & Input */}
            <div className="border-t border-[#2d3748] bg-black/20">
                <PlanViewer plan={plan} />
                <div className="p-5 pt-0">
                    <div className="relative group">
                        <div className="absolute -inset-0.5 bg-gradient-to-r from-[#135bec]/50 to-indigo-500/50 rounded-[14px] opacity-0 group-focus-within:opacity-20 transition-opacity blur duration-500"></div>
                        <textarea
                            value={inputValue}
                            onChange={(e) => setInputValue(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), handleSend())}
                            className="relative block w-full bg-[#111318] text-white text-[13px] rounded-[14px] border border-[#2d3748] focus:border-[#135bec]/50 focus:ring-1 focus:ring-[#135bec]/10 pl-4 pr-12 py-3.5 min-h-[56px] max-h-32 resize-none scrollbar-hide placeholder-slate-600 focus:placeholder-slate-500 shadow-inner transition-all outline-none"
                            placeholder={context.includes('Data') ? "Ask AI to troubleshoot..." : "Ask AI to edit chart, filter..."}
                        />
                        <button
                            onClick={handleSend}
                            className="absolute bottom-2.5 right-2.5 w-8 h-8 bg-[#135bec] text-white rounded-lg hover:bg-blue-600 transition-all flex items-center justify-center shadow-[0_4px_10px_rgba(19,91,236,0.3)] active:scale-90"
                        >
                            <span className="material-symbols-outlined text-[20px]">arrow_upward</span>
                        </button>
                    </div>
                    <div className="flex justify-between items-center mt-3 px-1">
                        <span className="text-[9px] text-slate-600 flex items-center gap-1.5 font-bold uppercase tracking-widest">
                            <span className="material-symbols-outlined text-[14px] opacity-60">info</span>
                            Use @ to mention data
                        </span>
                        <button className="text-slate-600 hover:text-slate-400 transition-colors">
                            <span className="material-symbols-outlined text-[18px]">history</span>
                        </button>
                    </div>
                </div>
            </div>
        </aside>
    );
};

export default CopilotSidebar;
