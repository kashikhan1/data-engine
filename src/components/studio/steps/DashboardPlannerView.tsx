'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useConfigStore, useWorkflowStore } from '@/state/stores';
import { runDashboardPlanner } from '@/lib/agents/dashboard-planner';
import {
    Button,
    Card,
    Typography,
    Space,
    Divider,
    Input,
    Spin,
    Alert,
    Tooltip,
    Badge,
    Tag,
    List,
    Switch
} from 'antd';
import {
    ReloadOutlined,
    ArrowRightOutlined,
    LayoutOutlined,
    EditOutlined,
    SaveOutlined,
    RollbackOutlined,
    BulbOutlined
} from '@ant-design/icons';
import styles from './StepView.module.css';

const { Title, Text, Paragraph } = Typography;
const { TextArea } = Input;

export const DashboardPlannerView: React.FC = () => {
    const {
        query,
        schemaData,
        schemaTimestamp,
        aiPlan,
        setAiPlan,
        userPlan,
        setUserPlan,
        isProcessing,
        setProcessing,
        error,
        setError,
        setStep,
        staleStep,
        setStaleStep
    } = useWorkflowStore();
    const { disabledWidgetTypes } = useConfigStore();

    const [isEditing, setIsEditing] = useState(false);
    const [localPlanText, setLocalPlanText] = useState('');
    const [plannerAgents, setPlannerAgents] = useState<string | null>(null);
    const [plannerAgentStatus, setPlannerAgentStatus] = useState<Record<string, "start" | "done" | "error">>({});
    const [agentStreams, setAgentStreams] = useState<Record<string, string>>({});
    const [agentDrafts, setAgentDrafts] = useState<Record<string, string>>({});
    const [intentLabels, setIntentLabels] = useState<string[]>([]);
    const [agentOrder, setAgentOrder] = useState<string[]>([]);
    const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
    const agentStreamBufferRef = useRef<Record<string, string>>({});
    const agentStreamFlushRef = useRef<number | null>(null);
    const isPlanningRef = useRef(false);
    const lastAutoPlanKeyRef = useRef<string | null>(null);
    const stripEventStream = (text: string) => {
        const marker = "EVENT_STREAM:";
        const idx = text.indexOf(marker);
        return idx === -1 ? text : text.slice(0, idx).trim();
    };
    const extractPlannerAgents = (text: string) => {
        if (!text) return null;
        const marker = "EVENT_STREAM:";
        const idx = text.indexOf(marker);
        if (idx === -1) return null;
        const payload = text.slice(idx + marker.length);
        const lines = payload.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('{')) continue;
            try {
                const evt = JSON.parse(trimmed);
                if (evt?.type === 'planner_agents' && typeof evt.content === 'string') {
                    return evt.content;
                }
                if (evt?.type === 'planner_agent_status' && evt.agent && evt.status) {
                    setPlannerAgentStatus((prev) => ({ ...prev, [evt.agent]: evt.status }));
                }
            } catch {
                // ignore malformed lines
            }
        }
        return null;
    };
    const flushAgentStreams = () => {
        const pending = agentStreamBufferRef.current;
        agentStreamBufferRef.current = {};
        agentStreamFlushRef.current = null;
        const keys = Object.keys(pending);
        if (keys.length === 0) return;
        setAgentStreams((prev) => {
            const next = { ...prev };
            keys.forEach((key) => {
                next[key] = `${next[key] || ""}${pending[key]}`;
            });
            return next;
        });
    };
    const bufferAgentToken = (agent: string, token: string) => {
        if (!agent || !token) return;
        agentStreamBufferRef.current[agent] = `${agentStreamBufferRef.current[agent] || ""}${token}`;
        if (agentStreamFlushRef.current === null) {
            agentStreamFlushRef.current = window.setTimeout(flushAgentStreams, 60);
        }
    };
    const handlePlannerEvent = (evt: any) => {
        if (!evt?.type) return;
        if (evt.type === 'planner_agents' && typeof evt.content === 'string') {
            setPlannerAgents(evt.content);
            return;
        }
        if (evt.type === 'planner_agent_status' && evt.agent && evt.status) {
            setPlannerAgentStatus((prev) => ({ ...prev, [evt.agent]: evt.status }));
            if (evt.status === 'start') {
                setAgentOrder((prev) => (prev.includes(evt.agent) ? prev : [...prev, evt.agent]));
                setSelectedAgent((prev) => prev || evt.agent);
            }
            return;
        }
        if (evt.type === 'planner_agent_token' && evt.agent && evt.token) {
            bufferAgentToken(evt.agent, evt.token);
            return;
        }
        if (evt.type === 'planner_agent_draft' && evt.agent) {
            const content = evt.content || "";
            setAgentDrafts((prev) => ({ ...prev, [evt.agent]: content }));
            if (!selectedAgent) setSelectedAgent(evt.agent);
            if (evt.agent === "Final Plan Agent" && content && !isEditing) {
                setLocalPlanText(content);
                const allowedTypes = new Set(["kpi", "line", "area", "bar", "pie", "donut", "table", "cohort", "funnel", "map", "scatter", "markdown"]);
                (disabledWidgetTypes || []).forEach((t) => allowedTypes.delete(t));
                import('@/utils/plan-parser').then(({ extractDashboardTitle, parseNaturalLanguagePlan }) => {
                    const widgets = parseNaturalLanguagePlan(content).filter((w: any) => allowedTypes.has(w?.type));
                    const title = extractDashboardTitle(content) || "AI Analytics Dashboard";
                    setAiPlan({
                        title,
                        rawPlan: content,
                        widgets,
                        plannerAgents: plannerAgents || undefined,
                        schemaTimestamp,
                        query
                    });
                }).catch(() => {
                    // ignore parse errors for drafts
                });
            }
            return;
        }
        if (evt.type === 'planner_intents') {
            setIntentLabels(Array.isArray(evt.intents) ? evt.intents : []);
        }
    };
    const buildFilteredPlanText = (title: string, widgets: any[]) => {
        const lines: string[] = [];
        lines.push(`DASHBOARD TITLE: ${title || "AI Analytics Dashboard"}`);
        lines.push("PURPOSE: Auto-generated plan based on enabled widget types.");
        lines.push("");
        lines.push("FILTERS TO INCLUDE:");
        lines.push("1) None");
        lines.push("");
        widgets.forEach((w: any, idx: number) => {
            const widgetTitle = String(w?.title || `Widget ${idx + 1}`).trim();
            const widgetType = String(w?.type || "chart").trim();
            const goal = String(w?.goal || "Visualization").trim();
            lines.push(`WIDGET ${idx + 1}: ${widgetType} - ${widgetTitle}`);
            lines.push(`Shows: ${goal}`);
            lines.push("Why: Enabled widget type per settings.");
            lines.push("Uses: Not specified.");
            lines.push("Filters applied: None.");
            lines.push("Notes: Filtered to enabled widget types.");
            lines.push("");
        });
        return lines.join("\n").trim();
    };

    const handlePlan = async (source: 'auto' | 'manual' | React.MouseEvent<HTMLElement> = 'manual') => {
        if (typeof source !== 'string') {
            source = 'manual';
        }
        if (!query || !schemaData) return;
        if (isPlanningRef.current) return;
        isPlanningRef.current = true;
        setProcessing(true);
        setError(null);
        setLocalPlanText(''); // Clear old plan to show new stream start
        setPlannerAgents(null);
        setPlannerAgentStatus({});
        setAgentStreams({});
        setAgentDrafts({});
        setIntentLabels([]);
        setAgentOrder([]);
        setSelectedAgent(null);
        agentStreamBufferRef.current = {};
        if (agentStreamFlushRef.current !== null) {
            window.clearTimeout(agentStreamFlushRef.current);
            agentStreamFlushRef.current = null;
        }

        try {
            // Use streaming API for real-time feedback
            const response = await fetch('/api/plan/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query,
                    schema: {
                        ...schemaData,
                        disabledWidgetTypes
                    }
                })
            });

            if (!response.ok) throw new Error('Planner connection failed. Please check if the LLM server is running.');

            const reader = response.body?.getReader();
            const decoder = new TextDecoder();
            let fullText = '';
            let buffer = '';

            if (reader) {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || ''; // Keep the last (potentially incomplete) line

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (trimmed.startsWith('data: ')) {
                            try {
                                const data = JSON.parse(trimmed.substring(6));
                                if ((data?.kind === 'chunk' || (!data?.kind && data.chunk)) && data.chunk) {
                                    fullText += data.chunk;
                                    setLocalPlanText(stripEventStream(fullText));
                                } else if ((data?.kind === 'event' && data.event) || data?.event) {
                                    const evt = data.event || data;
                                    handlePlannerEvent(evt);
                                }
                            } catch (e) {
                                // Ignore partials
                            }
                        }
                    }
                }
            }

            // Once streaming is done, finalize the plan structure (widgets, title, etc) client-side
            const { extractDashboardTitle, parseNaturalLanguagePlan } = await import('@/utils/plan-parser');
            const cleanedPlanText = stripEventStream(fullText);
            const agentInfo = extractPlannerAgents(fullText);
            if (agentInfo) setPlannerAgents(agentInfo);
            const allowedTypes = new Set(["kpi", "line", "area", "bar", "pie", "donut", "table", "cohort", "funnel", "map", "scatter", "markdown"]);
            (disabledWidgetTypes || []).forEach((t) => allowedTypes.delete(t));
            const parsedWidgets = parseNaturalLanguagePlan(cleanedPlanText).filter((w: any) => allowedTypes.has(w?.type));
            const title = extractDashboardTitle(cleanedPlanText) || "AI Analytics Dashboard";
            const normalizedPlanText = (disabledWidgetTypes || []).length > 0
                ? buildFilteredPlanText(title, parsedWidgets)
                : cleanedPlanText;
            const finalizedData = {
                title,
                rawPlan: normalizedPlanText,
                widgets: parsedWidgets,
                plannerAgents: extractPlannerAgents(fullText),
                schemaTimestamp,
                query
            };
            setAiPlan(finalizedData);
            if (source === 'auto') {
                lastAutoPlanKeyRef.current = `${query}::${schemaTimestamp || ''}`;
            }

            // Clear stale flag for this step if successful
            if (staleStep === 2) setStaleStep(null);
        } catch (err: any) {
            console.error("Streaming error:", err);
            setError(err.message);
        } finally {
            isPlanningRef.current = false;
            setProcessing(false);
        }
    };

    useEffect(() => {
        if (userPlan?.rawPlan) {
            setLocalPlanText(userPlan.rawPlan);
            setPlannerAgents(userPlan?.plannerAgents || extractPlannerAgents(userPlan.rawPlan));
            return;
        }
        if (aiPlan?.rawPlan) {
            setLocalPlanText(aiPlan.rawPlan);
            setPlannerAgents(aiPlan?.plannerAgents || extractPlannerAgents(aiPlan.rawPlan));
        }
    }, [aiPlan, userPlan]);

    useEffect(() => {
        if (!schemaTimestamp) return;
        const aiSchemaTs = (aiPlan as any)?.schemaTimestamp;
        const userSchemaTs = (userPlan as any)?.schemaTimestamp;
        if ((aiSchemaTs && aiSchemaTs !== schemaTimestamp) || (userSchemaTs && userSchemaTs !== schemaTimestamp)) {
            setLocalPlanText('');
            setAgentStreams({});
            setAgentDrafts({});
            setPlannerAgents(null);
            setPlannerAgentStatus({});
            setSelectedAgent(null);
            setAgentOrder([]);
            setAiPlan(null as any);
            setUserPlan(null as any);
        }
    }, [schemaTimestamp, aiPlan, userPlan, setAiPlan, setUserPlan]);

    useEffect(() => {
        if (!query || !schemaTimestamp) return;
        if (aiPlan || userPlan) {
            const key = `${query}::${schemaTimestamp || ''}::${(disabledWidgetTypes || []).join(',')}`;
            lastAutoPlanKeyRef.current = key;
        }
    }, [aiPlan, userPlan, query, schemaTimestamp, disabledWidgetTypes]);

    useEffect(() => {
        if (!query || !schemaData) return;
        if (isPlanningRef.current || isProcessing) return;
        const key = `${query}::${schemaTimestamp || ''}::${(disabledWidgetTypes || []).join(',')}`;
        const isStale = staleStep === 2;
        if (!aiPlan && !userPlan && isStale) {
            if (lastAutoPlanKeyRef.current === key) return;
            handlePlan('auto');
            return;
        }
        if (!aiPlan && !userPlan && !isStale) {
            if (lastAutoPlanKeyRef.current === key && !isStale) return;
            handlePlan('auto');
        }
    }, [query, schemaData, schemaTimestamp, disabledWidgetTypes, staleStep, aiPlan, isProcessing]);

    const handleSave = async () => {
        if (!aiPlan) return;
        const { extractDashboardTitle, parseNaturalLanguagePlan } = await import('@/utils/plan-parser');
        const allowedTypes = new Set(["kpi", "line", "area", "bar", "pie", "donut", "table", "cohort", "funnel", "map", "scatter", "markdown"]);
        (disabledWidgetTypes || []).forEach((t) => allowedTypes.delete(t));
        setUserPlan({
            ...aiPlan,
            title: extractDashboardTitle(stripEventStream(localPlanText)) || aiPlan.title,
            rawPlan: stripEventStream(localPlanText),
            widgets: parseNaturalLanguagePlan(stripEventStream(localPlanText)).filter((w: any) => allowedTypes.has(w?.type)),
            plannerAgents: aiPlan?.plannerAgents || plannerAgents,
            schemaTimestamp,
            query
        });
        setIsEditing(false);
    };


    const handleReset = () => {
        if (aiPlan) {
            setLocalPlanText(aiPlan.rawPlan);
            setUserPlan(aiPlan);
            setIsEditing(false);
        }
    };

    if (isProcessing && !aiPlan && !localPlanText) {
        return (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 16 }}>
                <Spin size="large" />
                <Text type="secondary">Analyzing intent and architecting dashboard...</Text>
            </div>
        );
    }

    const currentPlan = userPlan || aiPlan;
    const runningAgents = Object.values(plannerAgentStatus).filter((status) => status === "start").length;
    const showPlan = currentPlan || localPlanText;
    const baseWidgets = aiPlan?.widgets || currentPlan?.widgets || [];
    const allowedWidgetTypes = new Set(["kpi", "line", "area", "bar", "pie", "donut", "table", "cohort", "funnel", "map", "scatter", "markdown"]);
    (disabledWidgetTypes || []).forEach((t) => allowedWidgetTypes.delete(t));
    const parsedWidgetsFromPlan = (() => {
        if (!localPlanText) return null;
        try {
            const { parseNaturalLanguagePlan } = require('@/utils/plan-parser');
            return parseNaturalLanguagePlan(localPlanText);
        } catch {
            return null;
        }
    })();
    const filteredBaseWidgets = parsedWidgetsFromPlan && parsedWidgetsFromPlan.length > 0
        ? parsedWidgetsFromPlan
        : baseWidgets;
    const enabledWidgetIds = new Set((currentPlan?.widgets || []).filter((w: any) => allowedWidgetTypes.has(w?.type)).map((w: any) => w.id));
    const filterCandidates = schemaData?.filterCandidates;
    const nonEmptyTables = (() => {
        const counts = schemaData?.tableCounts;
        if (!counts) return schemaData?.tables || [];
        return Object.entries(counts)
            .filter(([, count]) => Number(count) > 0)
            .map(([table]) => table);
    })();
    const enabledFilters = (() => {
        const items: Array<{ label: string; type: string; defaultValue?: string }> = [];
        const primaryDate = filterCandidates?.primaryDate;
        if (primaryDate?.table && primaryDate?.column) {
            items.push({
                label: `${primaryDate.table}.${primaryDate.column}`,
                type: 'date-range',
                defaultValue: 'this_month'
            });
        }
        (filterCandidates?.categoricalColumns || []).slice(0, 4).forEach((col: any) => {
            if (!col?.table || !col?.column) return;
            items.push({
                label: `${col.table}.${col.column}`,
                type: 'multi-select'
            });
        });
        return items;
    })();

    const scenarioCoverage = (() => {
        const match = localPlanText.match(/SCENARIO COVERAGE:\s*([\s\S]*?)(?:\nWIDGET\s+\d+:|$)/i);
        if (!match?.[1]) return [];
        return match[1]
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);
    })();

    const toggleWidget = (widgetId: string, nextEnabled: boolean) => {
        const sourcePlan = userPlan || aiPlan;
        if (!sourcePlan) return;
        const currentWidgets = (currentPlan?.widgets || []).filter((w: any) => allowedWidgetTypes.has(w?.type));
        let nextWidgets = currentWidgets;

        if (!nextEnabled) {
            nextWidgets = currentWidgets.filter((w: any) => w.id !== widgetId);
        } else {
            const toAdd = filteredBaseWidgets.find((w: any) => w.id === widgetId);
            if (!toAdd) return;
            const merged = [...currentWidgets, toAdd];
            const order = filteredBaseWidgets.map((w: any) => w.id);
            merged.sort((a: any, b: any) => order.indexOf(a.id) - order.indexOf(b.id));
            nextWidgets = merged;
        }

        setUserPlan({
            ...sourcePlan,
            widgets: nextWidgets
        });
        setStaleStep(3);
    };

    return (
        <div style={{ padding: '24px', height: '100%', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, padding: '16px 20px', borderRadius: 16, border: '1px solid #242a36', background: '#0f1218' }}>
                <div>
                    <Title level={2} style={{ margin: 0 }}>
                        <BulbOutlined style={{ marginRight: 12 }} />
                        Dashboard Blueprint
                    </Title>
                    <Space size={8} align="center">
                        <Text type="secondary">Review the plan, adjust KPIs, then continue</Text>
                        <Tag color="blue">Step 2 of 5</Tag>
                        {isProcessing && <Tag color="geekblue">Streaming...</Tag>}
                        {isProcessing && runningAgents > 0 && (
                            <Tag color="blue">Agents running: {runningAgents}</Tag>
                        )}
                        {plannerAgents && <Tag color="purple">Planner Agents: {plannerAgents}</Tag>}
                        {intentLabels.length > 0 && (
                            <Tag color="cyan">Intent: {intentLabels.join(", ")}</Tag>
                        )}
                    </Space>
                    <div style={{ display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
                        {query && <Tag color="blue">Prompt: {query}</Tag>}
                        {schemaData?.tables && <Tag color="geekblue">Tables: {nonEmptyTables.length}</Tag>}
                        {schemaTimestamp && <Tag color="default">Schema: {new Date(schemaTimestamp).toLocaleString()}</Tag>}
                    </div>
                </div>
                <Space>
                    <Button
                        icon={<ReloadOutlined />}
                        onClick={() => handlePlan('manual')}
                        loading={isProcessing}
                        disabled={!query}
                    >
                        {isProcessing ? 'Generating...' : 'Rerun Planner'}
                    </Button>
                    <Button
                        type="primary"
                        icon={<ArrowRightOutlined />}
                        onClick={() => setStep(3)}
                        disabled={!currentPlan || isProcessing || !query}
                    >
                        Continue
                    </Button>
                </Space>
            </div>

            {
                error && (
                    <Alert
                        title={<span style={{ color: '#fff' }}>Planning Error</span>}
                        description={<span style={{ color: 'rgba(255, 255, 255, 0.7)' }}>{error}</span>}
                        type="error"
                        showIcon
                        style={{ marginBottom: 24, background: 'rgba(245, 34, 45, 0.1)', border: '1px solid rgba(245, 34, 45, 0.3)' }}
                    />
                )
            }

            {
                !query && (
                    <Card style={{ background: '#0f1218', border: '1px solid #242a36', padding: '40px 0', textAlign: 'center', marginBottom: 24 }}>
                        <BulbOutlined style={{ fontSize: 48, color: '#135bec', marginBottom: 24 }} />
                        <Title level={3}>Waiting for a prompt</Title>
                        <Paragraph type="secondary">
                            Enter a query in the chat board or discovery notes to help the AI understand what kind of dashboard you want to build.
                        </Paragraph>
                    </Card>
                )
            }

            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 350px', gap: 24 }}>
                {/* Main Plan Area */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                    {(isProcessing || Object.keys(agentStreams).length > 0 || Object.keys(agentDrafts).length > 0 || Object.keys(plannerAgentStatus).length > 0) && (
                        <Card title="Agent Streams" size="small">
                            {Array.from(new Set([
                                ...agentOrder,
                                ...Object.keys(plannerAgentStatus || {}),
                                ...Object.keys(agentStreams || {}),
                                ...Object.keys(agentDrafts || {})
                            ])).length === 0 ? (
                                <Text type="secondary">Waiting for agent streams...</Text>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                        {Array.from(new Set([
                                            ...agentOrder,
                                            ...Object.keys(plannerAgentStatus || {}),
                                            ...Object.keys(agentStreams || {}),
                                            ...Object.keys(agentDrafts || {})
                                        ])).map((agent) => (
                                            <Button
                                                key={agent}
                                                size="small"
                                                type={selectedAgent === agent ? "primary" : "default"}
                                                onClick={() => setSelectedAgent(agent)}
                                            >
                                                {agent}
                                            </Button>
                                        ))}
                                    </div>
                                    {selectedAgent && (
                                        <div style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.08)', paddingBottom: 12 }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                                                <Text strong>{selectedAgent}</Text>
                                                {plannerAgentStatus?.[selectedAgent] && (
                                                    <Tag color={plannerAgentStatus[selectedAgent] === 'done' ? 'green' : plannerAgentStatus[selectedAgent] === 'error' ? 'red' : 'blue'}>
                                                        {plannerAgentStatus[selectedAgent] === 'start' ? 'running' : plannerAgentStatus[selectedAgent]}
                                                    </Tag>
                                                )}
                                            </div>
                                            <Text type="secondary">Raw token stream</Text>
                                            <TextArea
                                                value={agentStreams?.[selectedAgent] || ""}
                                                autoSize={{ minRows: 3, maxRows: 8 }}
                                                style={{ fontFamily: 'var(--font-mono)', fontSize: 12, marginTop: 6 }}
                                                readOnly
                                            />
                                            {agentDrafts?.[selectedAgent] && (
                                                <div style={{ marginTop: 10 }}>
                                                    <Text type="secondary">Pre-compile draft</Text>
                                                    <TextArea
                                                        value={agentDrafts[selectedAgent]}
                                                        autoSize={{ minRows: 3, maxRows: 10 }}
                                                        style={{ fontFamily: 'var(--font-mono)', fontSize: 12, marginTop: 6 }}
                                                        readOnly
                                                    />
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            )}
                        </Card>
                    )}
                    {showPlan && (
                        <Card
                            title={
                                <Space>
                                    <span>Strategic Narrative</span>
                                    {userPlan && userPlan.rawPlan !== aiPlan?.rawPlan && <Tag color="orange">Edited</Tag>}
                                </Space>
                            }
                            extra={
                                <Space>
                                    {isEditing ? (
                                        <>
                                            <Button size="small" icon={<RollbackOutlined />} onClick={handleReset}>Reset</Button>
                                            <Button size="small" type="primary" icon={<SaveOutlined />} onClick={handleSave}>Save</Button>
                                        </>
                                    ) : (
                                        <Button size="small" icon={<EditOutlined />} onClick={() => setIsEditing(true)}>Edit Plan</Button>
                                    )}
                                </Space>
                            }
                        >
                            {isEditing ? (
                                <TextArea
                                    value={localPlanText}
                                    onChange={(e) => setLocalPlanText(e.target.value)}
                                    autoSize={{ minRows: 15, maxRows: 30 }}
                                    style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}
                                />
                            ) : (
                                <Paragraph style={{ whiteSpace: 'pre-wrap', fontSize: 15, lineHeight: 1.6 }}>
                                    {localPlanText}
                                </Paragraph>
                            )}
                        </Card>
                    )}
                </div>

                {/* Sidebar: Structured Widgets Preview */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                    {Object.keys(plannerAgentStatus).length > 0 && (
                        <Card title="Planner Agents" size="small">
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                {Object.entries(plannerAgentStatus).map(([agent, status]) => (
                                    <div key={agent} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                                        <Text>{agent}</Text>
                                        <Tag color={status === 'done' ? 'green' : status === 'error' ? 'red' : 'blue'}>
                                            {status === 'start' ? 'running' : status}
                                        </Tag>
                                    </div>
                                ))}
                            </div>
                        </Card>
                    )}
                    {showPlan && (
                        <>
                            <Card title="Widgets Overview" size="small">
                                <div style={{ display: 'flex', flexDirection: 'column' }}>
                                    {filteredBaseWidgets.map((widget: any, index: number) => (
                                        <div key={index} style={{
                                            borderBottom: index < filteredBaseWidgets.length - 1 ? '1px solid rgba(255, 255, 255, 0.08)' : 'none',
                                            padding: '12px 0'
                                        }}>
                                            <div style={{ width: '100%' }}>
                                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                                                    <Text strong>{widget.title}</Text>
                                                    <Space size={8}>
                                                        <Tag color="cyan">{widget.type}</Tag>
                                                        <Switch
                                                            size="small"
                                                            checked={enabledWidgetIds.has(widget.id)}
                                                            onChange={(checked) => toggleWidget(widget.id, checked)}
                                                            disabled={!allowedWidgetTypes.has(widget?.type)}
                                                        />
                                                    </Space>
                                                </div>
                                                <Text type="secondary" style={{ fontSize: 12 }}>
                                                    {widget.goal}
                                                </Text>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </Card>

                            {scenarioCoverage.length > 0 && (
                                <Card title="Scenario Coverage" size="small">
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                        {scenarioCoverage.map((line, idx) => (
                                            <Text key={`${line}-${idx}`} type="secondary" style={{ fontSize: 12 }}>
                                                {line}
                                            </Text>
                                        ))}
                                    </div>
                                </Card>
                            )}

                            <Card title="Enabled Filters" size="small">
                                {enabledFilters.length > 0 ? (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                        {enabledFilters.map((filter, idx) => (
                                            <div key={`${filter.label}-${idx}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                                                <Text>{filter.label}</Text>
                                                <Space size={4}>
                                                    <Tag color="blue">{filter.type}</Tag>
                                                    {filter.defaultValue && <Tag color="geekblue">{filter.defaultValue}</Tag>}
                                                </Space>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <Text type="secondary">No filters enabled in schema discovery.</Text>
                                )}
                            </Card>

                            <Alert
                                title="Plan dependency"
                                description="Modifying the text plan above will be used as context for the SQL generation step."
                                type="info"
                                showIcon
                            />
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};
