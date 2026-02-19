'use client';

import React, { useState } from 'react';
import { useAuthStore } from '@/state/stores';
import { App } from 'antd';

export const LoginPage: React.FC = () => {
    const { message } = App.useApp();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const login = useAuthStore((state) => state.login);

    const requiredEmail = process.env.NEXT_PUBLIC_FAKE_AUTH_EMAIL || 'admin@luman.ai';
    const requiredPassword = process.env.NEXT_PUBLIC_FAKE_AUTH_PASSWORD || 'admin123';

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsLoading(true);

        // Simulate API call
        setTimeout(() => {
            if (email === requiredEmail && password === requiredPassword) {
                login({
                    id: '1',
                    email: requiredEmail,
                    name: 'Admin User',
                    avatar: 'M'
                });
                message.success('Welcome back, Admin!');
            } else {
                const hint = `Hint: ${requiredEmail} / ${requiredPassword}`;
                message.error(`Invalid email or password. ${hint}`);
            }
            setIsLoading(false);
        }, 800);
    };

    return (
        <div className="flex h-screen w-full items-center justify-center bg-[#0b0d11] canvas-grid">
            <div className="w-full max-w-md p-8 bg-[#11141d]/80 backdrop-blur-2xl border border-white/[0.05] rounded-[2.5rem] shadow-2xl">
                <div className="flex flex-col items-center mb-10">
                    <div className="w-16 h-16 bg-[#135bec] rounded-2xl flex items-center justify-center text-white shadow-xl shadow-blue-900/40 mb-6">
                        <span className="material-symbols-outlined text-[32px] font-bold">auto_awesome</span>
                    </div>
                    <h1 className="text-2xl font-black text-white uppercase tracking-[4px]">Luman AI</h1>
                    <p className="text-slate-500 text-[10px] font-bold uppercase tracking-widest mt-2">Enterprise Data Engine</p>
                </div>

                <form onSubmit={handleLogin} className="space-y-6">
                    <div className="space-y-2">
                        <label className="text-[10px] font-black uppercase tracking-[2px] text-slate-400 ml-1">Email Address</label>
                        <div className="relative">
                            <span className="absolute left-4 top-1/2 -translate-y-1/2 material-symbols-outlined text-slate-500 text-[18px]">mail</span>
                            <input
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                className="w-full pl-12 pr-4 py-4 bg-white/5 border border-white/5 rounded-2xl text-sm font-medium text-white placeholder-slate-600 focus:outline-none focus:border-[#135bec]/50 focus:bg-white/[0.08] transition-all"
                                placeholder="name@company.com"
                                required
                            />
                        </div>
                    </div>

                    <div className="space-y-2">
                        <label className="text-[10px] font-black uppercase tracking-[2px] text-slate-400 ml-1">Password</label>
                        <div className="relative">
                            <span className="absolute left-4 top-1/2 -translate-y-1/2 material-symbols-outlined text-slate-500 text-[18px]">lock</span>
                            <input
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                className="w-full pl-12 pr-4 py-4 bg-white/5 border border-white/5 rounded-2xl text-sm font-medium text-white placeholder-slate-600 focus:outline-none focus:border-[#135bec]/50 focus:bg-white/[0.08] transition-all"
                                placeholder="••••••••"
                                required
                            />
                        </div>
                    </div>

                    <div className="flex items-center justify-between px-1">
                        <label className="flex items-center gap-2 cursor-pointer group">
                            <input type="checkbox" className="sr-only peer" />
                            <div className="w-5 h-5 border border-white/10 rounded-md bg-white/5 peer-checked:bg-[#135bec] peer-checked:border-[#135bec] transition-all flex items-center justify-center">
                                <span className="material-symbols-outlined text-white text-[14px] opacity-0 peer-checked:opacity-100 italic transition-all">check</span>
                            </div>
                            <span className="text-[11px] font-bold text-slate-500 group-hover:text-slate-300 transition-colors">Remember me</span>
                        </label>
                        <a href="#" className="text-[11px] font-bold text-[#135bec] hover:text-blue-400 transition-colors">Forgot Password?</a>
                    </div>

                    <button
                        type="submit"
                        disabled={isLoading}
                        className="w-full py-4 bg-[#135bec] text-white rounded-2xl text-xs font-black uppercase tracking-[3px] hover:bg-blue-600 transition-all shadow-xl shadow-blue-900/20 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                    >
                        {isLoading ? (
                            <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                        ) : (
                            <>
                                Sign In
                                <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
                            </>
                        )}
                    </button>
                </form>

                <div className="mt-10 text-center">
                    <p className="text-[11px] font-bold text-slate-500">
                        Don't have an account? <a href="#" className="text-white hover:text-[#135bec] transition-colors">Contact Administrator</a>
                    </p>
                </div>
            </div>
        </div>
    );
};
