import { create } from 'zustand';
import { DashboardLayoutSchema } from '../schemas';
import { z } from 'zod';

interface DashboardState {
    layout: z.infer<typeof DashboardLayoutSchema> | null;
    setLayout: (layout: z.infer<typeof DashboardLayoutSchema>) => void;
    isLoading: boolean;
    setIsLoading: (loading: boolean) => void;
}

export const useDashboardStore = create<DashboardState>((set) => ({
    layout: null,
    setLayout: (layout) => set({ layout }),
    isLoading: false,
    setIsLoading: (isLoading) => set({ isLoading }),
}));
