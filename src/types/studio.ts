export type WidgetType = 'kpi' | 'bar_chart' | 'line_chart' | 'donut_chart' | 'table';

export interface Widget {
    id: string;
    type: WidgetType;
    title: string;
    subtitle?: string;
    colSpan: number;
    data: any;
    config?: any;
}

export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant';
    text: string;
    timestamp: string;
    agent?: string;
    actions?: string[];
}

export interface PlanStep {
    id: string;
    label: string;
    status: 'pending' | 'processing' | 'completed';
}

export type ConnectionStatus = 'Connected' | 'Auth Error' | 'Disconnected' | 'Pending';

export interface DataSource {
    id: string;
    name: string;
    type: string;
    details: string;
    status: ConnectionStatus;
    lastSync: string;
    icon: string;
    connectionString?: string;
    instructions?: string;
}

export interface Integration {
    id: string;
    name: string;
    icon: string;
    description?: string;
}

export type AppView = 'build' | 'data-sources' | 'settings' | 'workbench' | 'data-explorer' | 'schema';

export interface DashboardState {
    title: string;
    subtitle: string;
    widgets: Widget[];
    dateRange: string;
    region: string;
}
