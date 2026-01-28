import { useCallback, useEffect, useRef, useState } from "react";
import { useRunStore } from "@/state/stores";
import type { RunEvent } from "@/types/dashboard";

interface UseRunStreamOptions {
    onComplete?: (success: boolean) => void;
    onError?: (error: string) => void;
    autoReconnect?: boolean;
    maxReconnectAttempts?: number;
}

interface UseRunStreamReturn {
    startStream: (runId: string) => void;
    stopStream: () => void;
    isConnected: boolean;
    reconnectAttempts: number;
}

/**
 * Hook for streaming run events via SSE
 */
export function useRunStream(options: UseRunStreamOptions = {}): UseRunStreamReturn {
    const {
        onComplete,
        onError,
        autoReconnect = true,
        maxReconnectAttempts = 3,
    } = options;

    const [isConnected, setIsConnected] = useState(false);
    const [reconnectAttempts, setReconnectAttempts] = useState(0);

    const eventSourceRef = useRef<EventSource | null>(null);
    const runIdRef = useRef<string | null>(null);

    const { startRun, handleEvent, endRun } = useRunStore();

    const stopStream = useCallback(() => {
        if (eventSourceRef.current) {
            eventSourceRef.current.close();
            eventSourceRef.current = null;
        }
        setIsConnected(false);
        runIdRef.current = null;
    }, []);

    const startStream = useCallback((runId: string) => {
        // Close existing connection
        stopStream();

        runIdRef.current = runId;
        startRun(runId);

        const url = `/api/runs/${runId}/stream`;
        const eventSource = new EventSource(url);
        eventSourceRef.current = eventSource;

        eventSource.onopen = () => {
            setIsConnected(true);
            setReconnectAttempts(0);
            console.log(`[SSE] Connected to run ${runId}`);
        };

        eventSource.onmessage = (event) => {
            try {
                const data: RunEvent = JSON.parse(event.data);
                handleEvent(data);

                // Handle completion
                if (data.type === "final") {
                    const success = data.envelope.status === "completed";
                    endRun(success);
                    stopStream();
                    onComplete?.(success);
                }

                if (data.type === "error") {
                    endRun(false, data.message);
                    stopStream();
                    onError?.(data.message);
                }
            } catch (error) {
                console.error("[SSE] Failed to parse event:", error);
            }
        };

        eventSource.onerror = (error) => {
            console.error("[SSE] Connection error:", error);
            setIsConnected(false);
            eventSource.close();

            // Attempt reconnection
            if (autoReconnect && reconnectAttempts < maxReconnectAttempts && runIdRef.current) {
                const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 10000);
                console.log(`[SSE] Reconnecting in ${delay}ms (attempt ${reconnectAttempts + 1})`);

                setTimeout(() => {
                    if (runIdRef.current) {
                        setReconnectAttempts(prev => prev + 1);
                        startStream(runIdRef.current);
                    }
                }, delay);
            } else if (reconnectAttempts >= maxReconnectAttempts) {
                const errorMsg = "Connection lost after max retries";
                endRun(false, errorMsg);
                onError?.(errorMsg);
            }
        };
    }, [startRun, handleEvent, endRun, stopStream, onComplete, onError, autoReconnect, maxReconnectAttempts, reconnectAttempts]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            stopStream();
        };
    }, [stopStream]);

    return {
        startStream,
        stopStream,
        isConnected,
        reconnectAttempts,
    };
}

/**
 * Hook for initiating a new run and streaming results
 */
export function useCreateRun() {
    const [isCreating, setIsCreating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const { startStream, stopStream, isConnected } = useRunStream();

    const createRun = useCallback(async (params: {
        originalQuery: string;
        dashboardId?: string;
        recipeId?: string;
        context?: Record<string, any>;
    }) => {
        setIsCreating(true);
        setError(null);

        try {
            const response = await fetch("/api/runs", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(params),
            });

            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.error || "Failed to create run");
            }

            const { runId } = await response.json();

            // Start streaming
            startStream(runId);

            return runId;
        } catch (err) {
            const message = err instanceof Error ? err.message : "Unknown error";
            setError(message);
            throw err;
        } finally {
            setIsCreating(false);
        }
    }, [startStream]);

    return {
        createRun,
        stopStream,
        isCreating,
        isConnected,
        error,
    };
}

/**
 * Hook for WebSocket-based streaming (alternative to SSE)
 */
export function useRunWebSocket(options: UseRunStreamOptions = {}) {
    const { onComplete, onError, autoReconnect = true, maxReconnectAttempts = 3 } = options;

    const [isConnected, setIsConnected] = useState(false);
    const [reconnectAttempts, setReconnectAttempts] = useState(0);

    const wsRef = useRef<WebSocket | null>(null);
    const runIdRef = useRef<string | null>(null);

    const { startRun, handleEvent, endRun } = useRunStore();

    const stopStream = useCallback(() => {
        if (wsRef.current) {
            wsRef.current.close();
            wsRef.current = null;
        }
        setIsConnected(false);
        runIdRef.current = null;
    }, []);

    const startStream = useCallback((runId: string) => {
        stopStream();

        runIdRef.current = runId;
        startRun(runId);

        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const url = `${protocol}//${window.location.host}/api/runs/${runId}/ws`;

        const ws = new WebSocket(url);
        wsRef.current = ws;

        ws.onopen = () => {
            setIsConnected(true);
            setReconnectAttempts(0);
            console.log(`[WS] Connected to run ${runId}`);
        };

        ws.onmessage = (event) => {
            try {
                const data: RunEvent = JSON.parse(event.data);
                handleEvent(data);

                if (data.type === "final") {
                    const success = data.envelope.status === "completed";
                    endRun(success);
                    stopStream();
                    onComplete?.(success);
                }

                if (data.type === "error") {
                    endRun(false, data.message);
                    stopStream();
                    onError?.(data.message);
                }
            } catch (error) {
                console.error("[WS] Failed to parse message:", error);
            }
        };

        ws.onerror = (error) => {
            console.error("[WS] Error:", error);
        };

        ws.onclose = (event) => {
            setIsConnected(false);

            if (!event.wasClean && autoReconnect && reconnectAttempts < maxReconnectAttempts && runIdRef.current) {
                const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 10000);
                setTimeout(() => {
                    if (runIdRef.current) {
                        setReconnectAttempts(prev => prev + 1);
                        startStream(runIdRef.current);
                    }
                }, delay);
            }
        };
    }, [startRun, handleEvent, endRun, stopStream, onComplete, onError, autoReconnect, maxReconnectAttempts, reconnectAttempts]);

    useEffect(() => {
        return () => {
            stopStream();
        };
    }, [stopStream]);

    return {
        startStream,
        stopStream,
        isConnected,
        reconnectAttempts,
    };
}
