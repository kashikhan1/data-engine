'use client';

import React from 'react';
import { AppView } from '@/types/studio';
import { useUIStore, useAuthStore } from '@/state/stores';
import { Dropdown } from 'antd';

const Header: React.FC = () => {
    const { currentView, setCurrentView } = useUIStore();
    const { logout, user } = useAuthStore();
    const isWorkbench = currentView === 'workbench';

    return (
        <header className="h-14 shrink-0 border-b border-border-dark bg-black/80 backdrop-blur-xl flex items-center px-4 z-[100] relative">
            <div className="flex items-center gap-6 w-[320px] shrink-0 border-r border-border-dark pr-6 h-full">
                <div className="flex items-center gap-3">
                    <div className={`w-8 h-8 ${isWorkbench ? 'bg-slate-800' : 'bg-primary'} rounded-lg flex items-center justify-center text-white shadow-lg`}>
                        <span className="material-symbols-outlined text-[18px] font-bold">{isWorkbench ? 'terminal' : 'auto_awesome'}</span>
                    </div>
                    <div className="flex flex-col">
                        <h1 className="text-[12px] font-black leading-none tracking-[1.5px] text-white uppercase font-sans">
                            LUMAN AI DATA ENGINE
                        </h1>
                        <span className="text-[8px] text-slate-500 font-bold mt-1 tracking-widest uppercase font-sans">
                            PRO EDITION v2.4
                        </span>
                    </div>
                </div>
            </div>

            <div className="flex-1 flex items-center px-6 gap-8 overflow-hidden">
                <nav className="flex items-center gap-1 shrink-0">
                    {(['build', 'data-sources'] as AppView[]).map((view) => (
                        <button
                            key={view}
                            onClick={() => setCurrentView(view)}
                            className={`px-4 py-2 text-[10px] font-black uppercase tracking-[2px] rounded-lg transition-all relative whitespace-nowrap ${currentView === view
                                ? 'text-white bg-white/5 shadow-inner'
                                : 'text-slate-500 hover:text-slate-200'
                                }`}
                        >
                            {view === 'data-sources' ? 'Data Source' : view}
                        </button>
                    ))}
                </nav>

                <div className="flex-1 max-w-sm relative hidden sm:block">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 material-symbols-outlined text-slate-600 text-[16px]">search</span>
                    <input
                        className="w-full pl-9 pr-4 py-1.5 bg-white/5 border border-white/5 rounded-lg text-xs font-medium text-slate-300 placeholder-slate-600 focus:outline-none focus:border-primary/50 transition-all"
                        placeholder="Search dashboard..."
                        type="text"
                    />
                </div>
            </div>

            <div className="flex items-center gap-4 pl-6 border-l border-border-dark h-full shrink-0">
                <div className="flex items-center gap-1">
                    <button className="p-2 text-slate-500 hover:text-white transition-all"><span className="material-symbols-outlined text-[20px]">notifications</span></button>
                    <button
                        className={`p-2 transition-all ${currentView === 'settings' ? 'text-white' : 'text-slate-500 hover:text-white'}`}
                        onClick={() => setCurrentView('settings')}
                        title="Settings"
                    >
                        <span className="material-symbols-outlined text-[20px]">settings</span>
                    </button>
                </div>
                <button className="flex items-center gap-2 px-4 py-1.5 bg-white text-black rounded-lg text-[10px] font-black uppercase tracking-[2px] hover:bg-slate-200 transition-all shadow-lg active:scale-95 mr-2">
                    <span className="material-symbols-outlined text-[16px]">rocket_launch</span>
                    Publish
                </button>

                <Dropdown
                    trigger={['click']}
                    placement="bottomRight"
                    menu={{
                        items: [
                            {
                                key: 'profile',
                                label: (
                                    <div className="flex flex-col px-1 py-1">
                                        <span className="text-white font-bold text-xs">{user?.name || 'User'}</span>
                                        <span className="text-slate-500 text-[10px]">{user?.email || 'user@luman.ai'}</span>
                                    </div>
                                ),
                            },
                            { type: 'divider' },
                            {
                                key: 'account',
                                label: 'Account Settings',
                                icon: <span className="material-symbols-outlined text-[16px]">person</span>,
                                onClick: () => setCurrentView('settings')
                            },
                            {
                                key: 'logout',
                                label: <span className="text-red-400">Sign Out</span>,
                                icon: <span className="material-symbols-outlined text-[16px] text-red-400">logout</span>,
                                onClick: logout
                            }
                        ],
                        className: "studio-dropdown"
                    }}
                >
                    <div className="w-8 h-8 rounded-lg bg-[#135bec]/20 border border-[#135bec]/40 flex items-center justify-center text-[11px] font-black text-[#135bec] cursor-pointer hover:bg-[#135bec]/30 transition-all active:scale-95 shadow-lg shadow-blue-900/10 uppercase">
                        {user?.name?.[0] || user?.avatar || 'U'}
                    </div>
                </Dropdown>
            </div>
        </header>
    );
};

export default Header;
