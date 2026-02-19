'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Card, Progress, Typography, List, Tag, Space, Alert, Button, Spin, Timeline, Badge, Divider } from 'antd';
import {
    DatabaseOutlined,
    BarChartOutlined,
    BulbOutlined,
    CheckCircleOutlined,
    ExclamationCircleOutlined,
    PlayCircleOutlined,
    RocketOutlined,
    EyeOutlined
} from '@ant-design/icons';
import { WidgetRenderer } from "@/components/widgets/WidgetRenderer";
import type { WidgetSpec } from "@/types/dashboard";

const { Title, Text, Paragraph } = Typography;

interface StreamEvent {
    type: "progress" | "query_progress" | "query_complete" | "query_error" |
    "widget_progress" | "widget_complete" | "widget_error" |
    "analytics_progress" | "analytics_complete" |
    "viz_progress" | "viz_complete" | "viz_error" | "complete" | "error";
    stage?: string;
    message: string;
    widgetId?: string;
    widgetTitle?: string;
    result?: any;
    error?: string;
    completed?: number;
    total?: number;
    successCount?: number;
    totalCount?: number;
    results?: any[];
    analytics?: any;
    insights?: string[];
    sql?: string;  // Add SQL query field to stream events
}

interface QueryProgress {
    widgetId: string;
    widgetTitle: string;
    status: 'pending' | 'executing' | 'complete' | 'error';
    message?: string;
    result?: any;
    error?: string;
    sql?: string;  // Add SQL query field
}

interface WidgetProgress {
    widgetId: string;
    widgetTitle: string;
    status: 'pending' | 'designing' | 'complete' | 'error';
    message?: string;
    result?: any;
    error?: string;
}

interface WorkflowPhase {
    name: string;
    status: 'waiting' | 'running' | 'complete' | 'error';
    icon: React.ReactNode;
    color: string;
    description: string;
    progress?: number;
}

export default function StreamingSqlEngineerView() {
    const [isStreaming, setIsStreaming] = useState(false);
    const [events, setEvents] = useState<StreamEvent[]>([]);
    const [queryProgress, setQueryProgress] = useState<Record<string, QueryProgress>>({});
    const [widgetProgress, setWidgetProgress] = useState<Record<string, WidgetProgress>>({});
    const [currentPhase, setCurrentPhase] = useState<string>('idle');
    const [overallProgress, setOverallProgress] = useState(0);
    const [finalResults, setFinalResults] = useState<any>(null);
    const [error, setError] = useState<string | null>(null);

    const eventSourceRef = useRef<EventSource | null>(null);
    const abortControllerRef = useRef<AbortController | null>(null);

    // Define workflow phases for better UX
    const [phases, setPhases] = useState<WorkflowPhase[]>([
        {
            name: 'starting',
            status: 'waiting',
            icon: <PlayCircleOutlined />,
            color: '#1890ff',
            description: 'Initializing workflow'
        },
        {
            name: 'query_execution',
            status: 'waiting',
            icon: <DatabaseOutlined />,
            color: '#52c41a',
            description: 'Executing SQL queries'
        },
        {
            name: 'analytics',
            status: 'waiting',
            icon: <BulbOutlined />,
            color: '#722ed1',
            description: 'Analyzing data patterns'
        },
        {
            name: 'dashboard_building',
            status: 'waiting',
            icon: <BarChartOutlined />,
            color: '#fa8c16',
            description: 'Creating visualizations'
        },
        {
            name: 'complete',
            status: 'waiting',
            icon: <RocketOutlined />,
            color: '#52c41a',
            description: 'Workflow complete'
        }
    ]);

    const startStreaming = async (params: any = {}) => {
        try {
            setIsStreaming(true);
            setEvents([]);
            setQueryProgress({});
            setWidgetProgress({});
            setError(null);
            setFinalResults(null);
            setOverallProgress(0);

            // Reset phases
            setPhases(phases.map(p => ({ ...p, status: 'waiting', progress: 0 })));

            const response = await fetch('/api/stream-sql-engineer', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(params),
            });

            if (!response.ok) {
                throw new Error('Failed to start streaming workflow');
            }

            const reader = response.body?.getReader();
            const decoder = new TextDecoder();

            if (!reader) {
                throw new Error('Response body is not readable');
            }

            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const eventData = JSON.parse(line.slice(6));
                            handleStreamEvent(eventData);
                        } catch (e) {
                            console.error('Failed to parse SSE data:', e);
                        }
                    }
                }
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
            setIsStreaming(false);
        }
    };

    const handleStreamEvent = (event: StreamEvent) => {
        setEvents(prev => [...prev, event]);

        switch (event.type) {
            case 'progress':
                handleProgressEvent(event);
                break;
            case 'query_progress':
                handleQueryProgress(event);
                break;
            case 'query_complete':
                handleQueryComplete(event);
                break;
            case 'query_error':
                handleQueryError(event);
                break;
            case 'widget_progress':
            case 'viz_progress':
                handleWidgetProgress(event);
                break;
            case 'widget_complete':
            case 'viz_complete':
                handleWidgetComplete(event);
                break;
            case 'widget_error':
            case 'viz_error':
                handleWidgetError(event);
                break;
            case 'complete':
                handleWorkflowComplete(event);
                break;
            case 'error':
                handleError(event);
                break;
        }
    };

    const handleProgressEvent = (event: StreamEvent) => {
        const stage = event.stage || 'unknown';
        setCurrentPhase(stage);

        setPhases(prev => prev.map(phase => {
            if (phase.name === stage || (stage === 'query_complete_phase' && phase.name === 'query_execution')) {
                return { ...phase, status: 'complete', progress: 100 };
            } else if (phase.name === stage) {
                return { ...phase, status: 'running', progress: 50 };
            }
            return phase;
        }));

        if (event.completed && event.total) {
            setOverallProgress(Math.round((event.completed / event.total) * 100));
        }
    };

    const handleQueryProgress = (event: StreamEvent) => {
        const widgetId = event.widgetId;
        if (!widgetId) return;

        setQueryProgress(prev => {
            return {
                ...prev,
                [widgetId]: {
                    widgetId: widgetId,
                    widgetTitle: event.widgetTitle || 'Unknown Widget',
                    status: 'executing',
                    message: event.message,
                    sql: event.sql  // Store the SQL query
                }
            };
        });

        setCurrentPhase('query_execution');
    };

    const handleQueryComplete = (event: StreamEvent) => {
        if (!event.widgetId) return;

        setQueryProgress(prev => {
            const widgetId = event.widgetId;
            if (!widgetId) return prev;

            return {
                ...prev,
                [widgetId]: {
                    ...(prev[widgetId] || { widgetId: widgetId, widgetTitle: event.widgetTitle || 'Unknown Widget', status: 'pending' }),
                    status: 'complete',
                    result: event.result,
                    message: event.message,
                    sql: event.sql || prev[widgetId]?.sql
                }
            };
        });
    };

    const handleQueryError = (event: StreamEvent) => {
        if (!event.widgetId) return;

        setQueryProgress(prev => {
            const widgetId = event.widgetId;
            if (!widgetId) return prev;

            return {
                ...prev,
                [widgetId]: {
                    ...(prev[widgetId] || { widgetId: widgetId, widgetTitle: event.widgetTitle || 'Unknown Widget', status: 'pending' }),
                    status: 'error',
                    error: event.error,
                    message: event.message
                }
            };
        });
    };

    const handleWidgetProgress = (event: StreamEvent) => {
        if (!event.widgetId) return;

        setWidgetProgress(prev => {
            const widgetId = event.widgetId as string;
            return {
                ...prev,
                [widgetId]: {
                    ...(prev[widgetId] || { widgetId: widgetId, widgetTitle: event.widgetTitle || 'Unknown Widget', status: 'pending' }),
                    status: 'designing',
                    message: event.message
                }
            };
        });

        setCurrentPhase('dashboard_building');
    };

    const handleWidgetComplete = (event: StreamEvent) => {
        if (!event.widgetId) return;

        setWidgetProgress(prev => {
            const widgetId = event.widgetId as string;
            return {
                ...prev,
                [widgetId]: {
                    ...(prev[widgetId] || { widgetId: widgetId, widgetTitle: event.widgetTitle || 'Unknown Widget', status: 'pending' }),
                    status: 'complete',
                    result: event.result,
                    message: event.message
                }
            };
        });

        // Update overall progress based on widget completion
        const progress = Object.values(queryProgress).filter(q => q.status === 'complete').length;
        const total = Object.keys(queryProgress).length;
        if (total > 0) {
            setOverallProgress(Math.round((progress / total) * 100));
        }
    };

    const handleWidgetError = (event: StreamEvent) => {
        if (!event.widgetId) return;

        setWidgetProgress(prev => {
            const widgetId = event.widgetId as string;
            return {
                ...prev,
                [widgetId]: {
                    ...(prev[widgetId] || { widgetId: widgetId, widgetTitle: event.widgetTitle || 'Unknown Widget', status: 'pending' }),
                    status: 'error',
                    error: event.error,
                    message: event.message
                }
            };
        });
    };

    const handleWorkflowComplete = (event: StreamEvent) => {
        setFinalResults(event);
        setIsStreaming(false);
        setOverallProgress(100);

        setPhases(prev => prev.map(phase => ({
            ...phase,
            status: 'complete',
            progress: 100
        })));
    };

    const handleError = (event: StreamEvent) => {
        setError(event.message);
        setIsStreaming(false);
    };

    const stopStreaming = () => {
        if (eventSourceRef.current) {
            eventSourceRef.current.close();
        }
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }
        setIsStreaming(false);
    };

    const toWidgetSpec = (result: any): WidgetSpec => {
        const columns = Array.isArray(result?.columns) ? result.columns : [];
        const tableColumns = columns.map((col: string) => ({
            field: col,
            header: col.charAt(0).toUpperCase() + col.slice(1).replace(/_/g, " "),
        }));

        const fallbackId = typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `widget_${Math.random().toString(36).slice(2)}`;

        return {
            id: String(result?.widgetId || result?.id || fallbackId),
            title: result?.widgetTitle || result?.title || "Widget",
            type: (result?.type || "table") as WidgetSpec["type"],
            data: Array.isArray(result?.data) ? result.data : [],
            vegaSpec: result?.vegaSpec,
            tableConfig: tableColumns.length > 0 ? { columns: tableColumns } : undefined,
            ui: result?.error ? { error: result.error } : undefined
        };
    };

    return (
        <div style={{ padding: '24px', maxWidth: '1400px', margin: '0 auto' }}>
            <Title level={2}>
                <RocketOutlined style={{ marginRight: 8 }} />
                SQL Engineer Streaming Dashboard
            </Title>

            <Paragraph>
                Watch real-time progress as queries execute, analytics run, and dashboards build in parallel.
            </Paragraph>

            {/* Control Panel */}
            <Card style={{ marginBottom: 24 }}>
                <Space>
                    <Button
                        type="primary"
                        size="large"
                        loading={isStreaming}
                        onClick={() => startStreaming()}
                        disabled={isStreaming}
                    >
                        <PlayCircleOutlined />
                        Start Workflow
                    </Button>
                    <Button
                        size="large"
                        onClick={stopStreaming}
                        disabled={!isStreaming}
                    >
                        <EyeOutlined />
                        Stop
                    </Button>
                </Space>
            </Card>

            {/* Error Display */}
            {error && (
                <Alert
                    title="Error"
                    description={error}
                    type="error"
                    showIcon
                    closable
                    style={{ marginBottom: 24 }}
                    onClose={() => setError(null)}
                />
            )}

            {/* Workflow Phases */}
            <Card title="Workflow Phases" style={{ marginBottom: 24 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap' }}>
                    {phases.map((phase, index) => (
                        <div
                            key={phase.name}
                            style={{
                                textAlign: 'center',
                                minWidth: '180px',
                                marginBottom: 16,
                                opacity: phase.status === 'waiting' ? 0.5 : 1
                            }}
                        >
                            <div
                                style={{
                                    fontSize: 24,
                                    color: phase.status === 'complete' ? phase.color :
                                        phase.status === 'running' ? phase.color : '#d9d9d9',
                                    marginBottom: 8
                                }}
                            >
                                {phase.icon}
                            </div>
                            <Text strong>{phase.description}</Text>
                            <div style={{ marginTop: 8 }}>
                                {phase.status === 'complete' && <CheckCircleOutlined style={{ color: phase.color }} />}
                                {phase.status === 'running' && <Spin size="small" />}
                                {phase.status === 'error' && <ExclamationCircleOutlined style={{ color: '#ff4d4f' }} />}
                            </div>
                            {phase.progress !== undefined && (
                                <Progress
                                    percent={phase.progress}
                                    size="small"
                                    showInfo={false}
                                    strokeColor={phase.color}
                                />
                            )}
                        </div>
                    ))}
                </div>

                {/* Overall Progress */}
                <div style={{ marginTop: 24 }}>
                    <Text strong>Overall Progress</Text>
                    <Progress
                        percent={overallProgress}
                        status={isStreaming ? 'active' : 'normal'}
                        strokeColor={{
                            '0%': '#108ee9',
                            '100%': '#52c41a',
                        }}
                    />
                </div>
            </Card>

            {/* Query Progress */}
            {Object.keys(queryProgress).length > 0 && (
                <Card title="Query Execution Progress" style={{ marginBottom: 24 }}>
                    <List
                        dataSource={Object.values(queryProgress)}
                        renderItem={(query) => (
                            <List.Item>
                                <List.Item.Meta
                                    avatar={
                                        query.status === 'complete' ?
                                            <CheckCircleOutlined style={{ color: '#52c41a', fontSize: 20 }} /> :
                                            query.status === 'error' ?
                                                <ExclamationCircleOutlined style={{ color: '#ff4d4f', fontSize: 20 }} /> :
                                                <Spin size="small" />
                                    }
                                    title={
                                        <div>
                                            <div style={{ fontWeight: 'bold' }}>{query.widgetTitle}</div>
                                            {query.status === 'executing' && (
                                                <div style={{ fontSize: 12, color: '#1890ff', marginTop: 4 }}>
                                                    Executing SQL query...
                                                </div>
                                            )}
                                        </div>
                                    }
                                    description={query.message}
                                />
                                <div>
                                    <Tag color={
                                        query.status === 'complete' ? 'success' :
                                            query.status === 'error' ? 'error' :
                                                'processing'
                                    }>
                                        {query.status}
                                    </Tag>
                                </div>
                                {/* Show SQL query when executing */}
                                {query.status === 'executing' && query.sql && (
                                    <div style={{
                                        marginTop: 8,
                                        padding: 8,
                                        backgroundColor: '#f5f5f5',
                                        border: '1px solid #d9d9d9',
                                        borderRadius: 4,
                                        fontSize: 12,
                                        fontFamily: 'monospace'
                                    }}>
                                        <div style={{ fontWeight: 'bold', marginBottom: 4, color: '#666' }}>
                                            SQL Query:
                                        </div>
                                        <div style={{
                                            whiteSpace: 'pre-wrap',
                                            wordBreak: 'break-all',
                                            color: '#333',
                                            backgroundColor: '#fff',
                                            padding: 8,
                                            borderRadius: 2
                                        }}>
                                            {query.sql}
                                        </div>
                                    </div>
                                )}
                                {/* Show results when complete */}
                                {query.status === 'complete' && query.result && (
                                    <div style={{
                                        marginTop: 8,
                                        padding: 8,
                                        backgroundColor: '#f6ffed',
                                        border: '1px solid #b7eb8f',
                                        borderRadius: 4
                                    }}>
                                        <div style={{ fontWeight: 'bold', marginBottom: 4, color: '#389e0d' }}>
                                            📊 Results ({query.result.data?.length || 0} rows):
                                        </div>
                                        {/* Show sample data */}
                                        {query.result.data && query.result.data.length > 0 && (
                                            <div style={{
                                                maxHeight: 200,
                                                overflowY: 'auto',
                                                backgroundColor: '#fff',
                                                padding: 8,
                                                borderRadius: 2,
                                                fontSize: 11
                                            }}>
                                                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                                    <thead>
                                                        <tr style={{ backgroundColor: '#fafafa' }}>
                                                            {query.result.columns?.map((col: string) => (
                                                                <th key={col} style={{
                                                                    padding: '6px 8px',
                                                                    textAlign: 'left',
                                                                    borderBottom: '1px solid #eee',
                                                                    fontWeight: 'bold',
                                                                    color: '#666'
                                                                }}>
                                                                    {col}
                                                                </th>
                                                            ))}
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {query.result.data.slice(0, 5).map((row: any, idx: number) => (
                                                            <tr key={idx}>
                                                                {query.result.columns?.map((col: string) => (
                                                                    <td key={col} style={{
                                                                        padding: '6px 8px',
                                                                        borderBottom: '1px solid #eee',
                                                                        fontSize: 11
                                                                    }}>
                                                                        {row[col]}
                                                                    </td>
                                                                ))}
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
                                                {query.result.data.length > 5 && (
                                                    <div style={{
                                                        textAlign: 'center',
                                                        padding: 8,
                                                        color: '#666',
                                                        fontStyle: 'italic'
                                                    }}>
                                                        ... and {query.result.data.length - 5} more rows
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                        {/* Show error details */}
                                        {query.result.error && (
                                            <div style={{
                                                color: '#ff4d4f',
                                                backgroundColor: '#fff2f0',
                                                padding: 8,
                                                borderRadius: 2,
                                                fontSize: 11
                                            }}>
                                                <div style={{ fontWeight: 'bold', marginBottom: 4 }}>❌ Error:</div>
                                                <div>{query.result.error}</div>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </List.Item>
                        )}
                    />
                </Card>
            )}

            {/* Widget Creation */}
            {Object.keys(widgetProgress).length > 0 && (
                <Card title="Widget Creation" style={{ marginBottom: 24 }}>
                    <List
                        dataSource={Object.values(widgetProgress)}
                        renderItem={(widget) => (
                            <List.Item>
                                <List.Item.Meta
                                    avatar={
                                        widget.status === 'complete' ?
                                            <CheckCircleOutlined style={{ color: '#52c41a', fontSize: 20 }} /> :
                                            widget.status === 'error' ?
                                                <ExclamationCircleOutlined style={{ color: '#ff4d4f', fontSize: 20 }} /> :
                                                <Spin size="small" />
                                    }
                                    title={
                                        <div>
                                            <div style={{ fontWeight: 'bold' }}>{widget.widgetTitle}</div>
                                            {widget.status === 'designing' && (
                                                <div style={{ fontSize: 12, color: '#fa8c16', marginTop: 4 }}>
                                                    Building widget...
                                                </div>
                                            )}
                                        </div>
                                    }
                                    description={widget.message}
                                />
                                <div>
                                    <Tag color={
                                        widget.status === 'complete' ? 'success' :
                                            widget.status === 'error' ? 'error' :
                                                'processing'
                                    }>
                                        {widget.status}
                                    </Tag>
                                </div>
                            </List.Item>
                        )}
                    />

                    {Object.values(widgetProgress).some(w => w.status === 'complete' && w.result) && (
                        <>
                            <Divider>Widget Previews</Divider>
                            <div style={{
                                display: 'grid',
                                gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
                                gap: 16
                            }}>
                                {Object.values(widgetProgress)
                                    .filter(w => w.status === 'complete' && w.result)
                                    .map((widget) => {
                                        const spec = toWidgetSpec(widget.result);
                                        return (
                                            <Card key={spec.id} size="small" title={spec.title}>
                                                <WidgetRenderer widget={spec} data={spec.data} />
                                            </Card>
                                        );
                                    })}
                            </div>
                        </>
                    )}
                </Card>
            )}

            {/* Real-time Events */}
            {events.length > 0 && (
                <Card title="Real-time Events" style={{ marginBottom: 24 }}>
                    <div style={{ maxHeight: '300px', overflowY: 'auto' }}>
                        <Timeline>
                            {events.slice(-10).map((event, index) => (
                                <Timeline.Item
                                    key={index}
                                    color={
                                        event.type === 'complete' ? 'green' :
                                            event.type.includes('error') ? 'red' :
                                                event.type.includes('progress') ? 'blue' :
                                                    'gray'
                                    }
                                    dot={
                                        event.type === 'query_progress' ? <DatabaseOutlined /> :
                                            event.type === 'query_complete' ? <CheckCircleOutlined /> :
                                                event.type === 'viz_progress' ? <BarChartOutlined /> :
                                                    event.type === 'analytics_progress' ? <BulbOutlined /> :
                                                        null
                                    }
                                >
                                    <Text>{event.message}</Text>
                                    <br />
                                    <Text type="secondary" style={{ fontSize: 12 }}>
                                        {new Date().toLocaleTimeString()}
                                    </Text>
                                </Timeline.Item>
                            ))}
                        </Timeline>
                    </div>
                </Card>
            )}

            {/* Final Results */}
            {finalResults && (
                <Card
                    title="🎉 Workflow Complete!"
                    style={{ marginBottom: 24 }}
                    extra={<Badge count={finalResults.results?.length || 0} />}
                >
                    <Space direction="vertical" style={{ width: '100%' }}>
                        <div>
                            <Text strong>Results Summary:</Text>
                            <ul>
                                <li>Queries Executed: {finalResults.successCount || 0} / {finalResults.totalCount || 0}</li>
                                <li>Widgets Generated: {finalResults.results?.filter((r: any) => !r.error).length || 0}</li>
                                <li>Insights Found: {finalResults.insights?.length || 0}</li>
                            </ul>
                        </div>

                        {finalResults.insights && finalResults.insights.length > 0 && (
                            <div>
                                <Text strong>Key Insights:</Text>
                                <ul>
                                    {finalResults.insights.map((insight: string, index: number) => (
                                        <li key={index}>{insight}</li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </Space>
                </Card>
            )}
        </div>
    );
}
