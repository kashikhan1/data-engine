'use client';

import React, { useState } from 'react';

interface NewMcpAgentModalProps {
    isOpen: boolean;
    onClose: () => void;
}

const NewMcpAgentModal: React.FC<NewMcpAgentModalProps> = ({ isOpen, onClose }) => {
    const [showPassword, setShowPassword] = useState(false);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            {/* Backdrop */}
            <div
                className="absolute inset-0 bg-black/80 backdrop-blur-sm animate-fade-in"
                onClick={onClose}
            />

            {/* Modal Content */}
            <div className="relative w-full max-w-lg bg-[#111318] border border-[#2d3748] rounded-2xl shadow-2xl shadow-black/50 overflow-hidden animate-slide-in-top">
                {/* Header */}
                <div className="px-6 py-5 border-b border-[#2d3748] flex items-center justify-between">
                    <div>
                        <h2 className="text-xl font-bold text-white tracking-tight">Add New MCP Agent</h2>
                        <p className="text-xs text-slate-500 mt-1">Connect an external Model Context Protocol source.</p>
                    </div>
                    <button
                        onClick={onClose}
                        className="text-slate-500 hover:text-white transition-colors p-1"
                    >
                        <span className="material-symbols-outlined text-[22px]">close</span>
                    </button>
                </div>

                {/* Form Body */}
                <div className="p-6 space-y-5">
                    {/* Agent Name */}
                    <div className="space-y-2">
                        <label className="text-xs font-bold text-slate-300 tracking-wide">Agent Name</label>
                        <input
                            type="text"
                            placeholder="e.g., Sales Data Oracle"
                            className="w-full bg-[#1a202c] border border-[#2d3748] rounded-lg px-4 py-3 text-sm text-slate-200 placeholder-slate-600 focus:border-[#135bec] focus:ring-1 focus:ring-[#135bec]/20 transition-all outline-none"
                        />
                    </div>

                    {/* Endpoint URL */}
                    <div className="space-y-2">
                        <label className="text-xs font-bold text-slate-300 tracking-wide">Endpoint URL</label>
                        <div className="relative group">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 material-symbols-outlined text-slate-500 text-[18px]">link</span>
                            <input
                                type="text"
                                placeholder="https://api.example.com/mcp/v1"
                                className="w-full bg-[#1a202c] border border-[#2d3748] rounded-lg pl-10 pr-4 py-3 text-sm text-slate-200 placeholder-slate-600 focus:border-[#135bec] focus:ring-1 focus:ring-[#135bec]/20 transition-all outline-none font-mono"
                            />
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        {/* Authentication Type */}
                        <div className="space-y-2">
                            <label className="text-xs font-bold text-slate-300 tracking-wide">Authentication Type</label>
                            <div className="relative">
                                <select className="w-full bg-[#1a202c] border border-[#2d3748] rounded-lg px-4 py-3 text-sm text-slate-200 appearance-none focus:border-[#135bec] focus:ring-1 focus:ring-[#135bec]/20 transition-all outline-none cursor-pointer">
                                    <option>Bearer Token</option>
                                    <option>Basic Auth</option>
                                    <option>OAuth 2.0</option>
                                    <option>None</option>
                                </select>
                                <span className="absolute right-3 top-1/2 -translate-y-1/2 material-symbols-outlined text-slate-500 text-[18px] pointer-events-none">expand_more</span>
                            </div>
                        </div>

                        {/* API Key / Token */}
                        <div className="space-y-2">
                            <label className="text-xs font-bold text-slate-300 tracking-wide">API Key / Token</label>
                            <div className="relative">
                                <input
                                    type={showPassword ? "text" : "password"}
                                    placeholder="sk-..."
                                    className="w-full bg-[#1a202c] border border-[#2d3748] rounded-lg px-4 py-3 text-sm text-slate-200 placeholder-slate-600 focus:border-[#135bec] focus:ring-1 focus:ring-[#135bec]/20 transition-all outline-none font-mono"
                                />
                                <button
                                    onClick={() => setShowPassword(!showPassword)}
                                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
                                >
                                    <span className="material-symbols-outlined text-[18px]">
                                        {showPassword ? "visibility_off" : "visibility"}
                                    </span>
                                </button>
                            </div>
                        </div>
                    </div>

                    {/* Description */}
                    <div className="space-y-2">
                        <label className="text-xs font-bold text-slate-300 tracking-wide">Description <span className="text-slate-500 font-medium">(Optional)</span></label>
                        <textarea
                            rows={4}
                            placeholder="Briefly describe what data this agent provides..."
                            className="w-full bg-[#1a202c] border border-[#2d3748] rounded-lg px-4 py-3 text-sm text-slate-200 placeholder-slate-600 focus:border-[#135bec] focus:ring-1 focus:ring-[#135bec]/20 transition-all outline-none resize-none"
                        />
                    </div>
                </div>

                {/* Footer */}
                <div className="px-6 py-5 border-t border-[#2d3748] bg-[#111318] flex items-center justify-between">
                    <button className="flex items-center gap-2 px-4 py-2 border border-[#2d3748] rounded-lg text-sm font-bold text-slate-300 hover:text-white hover:bg-white/5 transition-all">
                        <span className="material-symbols-outlined text-[18px]">cell_tower</span>
                        Test Connection
                    </button>

                    <div className="flex items-center gap-3">
                        <button
                            onClick={onClose}
                            className="px-4 py-2 text-sm font-bold text-slate-400 hover:text-white transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            className="flex items-center gap-2 px-5 py-2 bg-[#135bec] text-white rounded-lg text-sm font-bold hover:bg-blue-600 transition-all shadow-lg shadow-blue-900/40"
                        >
                            <span className="material-symbols-outlined text-[18px]">add</span>
                            Save Source
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default NewMcpAgentModal;
