import { Widget, ChatMessage, PlanStep, DataSource, Integration } from '@/types/studio';

export const INITIAL_WIDGETS: Widget[] = [
    {
        id: 'kpi_1',
        type: 'kpi',
        title: 'Total Revenue',
        colSpan: 4,
        data: { value: '$1,245,000', change: '+12.5%', trend: 'up' }
    },
    {
        id: 'kpi_2',
        type: 'kpi',
        title: 'Weekly Growth',
        colSpan: 4,
        data: { value: '8.4%', change: '+2.1%', trend: 'up' }
    },
    {
        id: 'kpi_3',
        type: 'kpi',
        title: 'Avg Deal Size',
        colSpan: 4,
        data: { value: '$8,500', change: '-2.1%', trend: 'down' }
    },
    {
        id: 'trend_chart_1',
        type: 'line_chart',
        title: 'Weekly Revenue Trend',
        colSpan: 12,
        data: [
            { name: 'Week 1', value: 120000 },
            { name: 'Week 2', value: 150000 },
            { name: 'Week 3', value: 130000 },
            { name: 'Week 4', value: 180000 },
            { name: 'Week 5', value: 142500 },
            { name: 'Week 6', value: 210000 },
            { name: 'Week 7', value: 190000 }
        ]
    },
    {
        id: 'sku_list_1',
        type: 'table',
        title: 'Top 10 SKUs by Revenue',
        colSpan: 6,
        data: [
            { rank: '01', product: 'Pro Wireless Headset', revenue: '$42,500', category: 'Electronics' },
            { rank: '02', product: 'Ergo Chair Ultra', revenue: '$38,200', category: 'Furniture' },
            { rank: '03', product: '4K Monitor', revenue: '$29,000', category: 'Electronics' },
            { rank: '04', product: 'Standing Desk V2', revenue: '$25,400', category: 'Furniture' },
            { rank: '05', product: 'Mechanical Keyboard', revenue: '$18,900', category: 'Electronics' }
        ]
    },
    {
        id: 'region_bar_1',
        type: 'bar_chart',
        title: 'Revenue by Region',
        colSpan: 6,
        data: [
            { name: 'North', value: 420000 },
            { name: 'South', value: 650000 },
            { name: 'East', value: 310000 },
            { name: 'West', value: 540000 }
        ]
    },
    {
        id: 'category_donut_1',
        type: 'donut_chart',
        title: 'Revenue by Category',
        colSpan: 12,
        data: [
            { name: 'Electronics', value: 45, color: '#135bec' },
            { name: 'Furniture', value: 30, color: '#6366f1' },
            { name: 'Accessories', value: 15, color: '#a855f7' },
            { name: 'Other', value: 10, color: '#334155' }
        ]
    },
    {
        id: 'detailed_table_1',
        type: 'table',
        title: 'Recent Transactions',
        colSpan: 12,
        data: [
            { id: 'ORD-001', product: 'Pro Wireless Headset', region: 'North', amount: '$425.00', status: 'Paid' },
            { id: 'ORD-002', product: 'Ergo Chair Ultra', region: 'South', amount: '$899.00', status: 'Pending' },
            { id: 'ORD-003', product: '4K Monitor', region: 'East', amount: '$299.00', status: 'Paid' },
            { id: 'ORD-004', product: 'Standing Desk V2', region: 'West', amount: '$549.00', status: 'Paid' },
            { id: 'ORD-005', product: 'Mechanical Keyboard', region: 'North', amount: '$129.00', status: 'Paid' }
        ]
    }
];

export const MOCK_MESSAGES: ChatMessage[] = [
    {
        id: 'm1',
        role: 'user',
        text: 'Create a sales performance dashboard for Q3 grouped by region.',
        timestamp: '10:42 AM'
    },
    {
        id: 'm2',
        role: 'assistant',
        agent: 'AI Architect',
        text: "I've generated a sales performance dashboard for Q3. It includes:\n\n• Bar Chart: Revenue by Region\n• Metric Cards: Total Revenue, MoM Growth\n• Data Table: Regional breakdown",
        timestamp: '10:43 AM'
    }
];

export const DATA_SOURCE_MESSAGES: ChatMessage[] = [
    {
        id: 'dm1',
        role: 'user',
        text: 'I need to connect a new PostgreSQL database for the marketing team.',
        timestamp: '10:42 AM'
    }
];

export const MOCK_PLAN: PlanStep[] = [
    { id: 'p1', label: 'Understanding intent', status: 'completed' },
    { id: 'p2', label: 'Selecting dataset', status: 'completed' },
    { id: 'p3', label: 'Choosing measures/dimensions', status: 'processing' },
    { id: 'p4', label: 'Building widgets', status: 'pending' },
    { id: 'p5', label: 'Applying formatting', status: 'pending' }
];

export const ACTIVE_CONNECTIONS: DataSource[] = [
    {
        id: 'ds_mcp',
        name: 'Customer Support Agent',
        type: 'MCP Agent',
        details: 'mcp-server-memory',
        status: 'Connected',
        lastSync: 'Running',
        icon: 'smart_toy'
    },
    {
        id: 'ds1',
        name: 'Production DB',
        type: 'PostgreSQL',
        details: 'postgres-prod.internal:5432',
        status: 'Connected',
        lastSync: '5 min ago',
        icon: 'database'
    }
];

export const AVAILABLE_INTEGRATIONS: Integration[] = [
    { id: 'int_mcp', name: 'MCP Agent', icon: 'smart_toy', description: 'Model Context Protocol' },
    { id: 'int1', name: 'PostgreSQL', icon: 'database', description: 'Relational Database' },
    { id: 'int2', name: 'MSSQL', icon: 'database', description: 'SQL Server Database' }
];
