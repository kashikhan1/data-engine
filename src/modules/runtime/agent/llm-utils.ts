/* eslint-disable @typescript-eslint/no-explicit-any */
// llm-utils.ts — Low-level LangChain model invocation utilities.
// The model factory and message arrays must remain `any`-typed because
// LangChain's model interface uses `invoke(messages: any[], options?: any)`
// and chunk content is typed as `string | MessageContentComplex[]` which
// requires runtime narrowing captured here with `any`.

// ModelFactory MUST be `any`-based; LangChain ChatModel.invoke accepts BaseLanguageModelInput
// which is not assignable from unknown[], so we use `any` here (covered by file-level disable).
type ModelFactory = () => any;

function getStatusCode(err: unknown): number | null {
    const e = err as Record<string, unknown> | null;
    const code = Number(
        (e as any)?.status_code ?? (e as any)?.status ?? (e as any)?.response?.status
    );
    return Number.isFinite(code) ? code : null;
}

export function isRateLimitError(err: unknown): boolean {
    const status = getStatusCode(err);
    const message = String((err as any)?.message || "").toLowerCase();
    return status === 429 || message.includes("too many requests") || message.includes("too many concurrent requests");
}

export function isPromptTooLongError(err: unknown): boolean {
    const status = getStatusCode(err);
    const message = String((err as any)?.message || err || "").toLowerCase();
    return (
        status === 400 &&
        (message.includes("prompt too long") ||
            message.includes("max context length") ||
            message.includes("context length") ||
            message.includes("maximum context"))
    );
}

function normalizeModelError(err: unknown): Error {
    const code = (err as any)?.code || (err as any)?.cause?.code || (err as any)?.cause?.errors?.[0]?.code;
    const message = String((err as any)?.message || "");
    const hasConnectionRefused = code === "ECONNREFUSED" || message.toLowerCase().includes("fetch failed");

    if (hasConnectionRefused) {
        return new Error(
            "LLM connection failed (ECONNREFUSED). Check your model endpoint (e.g. OLLAMA_BASE_URL, Ollama server availability) and try again."
        );
    }

    return err instanceof Error ? err : new Error(message || "Unknown LLM error");
}

export async function invokeModelWithRetry(
    getModel: ModelFactory,
    messages: unknown[],
    maxRetries = 3,
    delay = 2000
) {
    let lastError: unknown;
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await getModel().invoke(messages, { timeout: 900000 });
        } catch (err: unknown) {
            lastError = err;
            if (isRateLimitError(err)) {
                const jitter = Math.floor(Math.random() * 350);
                await new Promise((resolve) => setTimeout(resolve, delay + jitter));
                delay *= 2;
            } else {
                throw normalizeModelError(err);
            }
        }
    }
    throw normalizeModelError(lastError);
}

export function extractChunkText(chunk: unknown): string {
    const content = (chunk as any)?.content ?? (chunk as any)?.message?.content ?? (chunk as any)?.text ?? "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content.map((part: unknown) => (part as any)?.text || "").join("");
    }
    return "";
}

export async function streamModelWithRetry(
    getModel: ModelFactory,
    messages: unknown[],
    onToken?: (token: string) => void,
    maxRetries = 3,
    delay = 2000
) {
    let lastError: unknown;
    for (let i = 0; i < maxRetries; i++) {
        try {
            const model = getModel() as any;
            if (typeof model?.stream !== "function") {
                const response = await invokeModelWithRetry(getModel, messages, maxRetries, delay);
                const content = (response?.content as string) || "";
                if (content) onToken?.(content);
                return response;
            }
            const stream = await model.stream(messages, { timeout: 900000 });
            let content = "";
            for await (const chunk of stream) {
                const text = extractChunkText(chunk);
                if (text) {
                    content += text;
                    onToken?.(text);
                }
            }
            return { content };
        } catch (err: unknown) {
            lastError = err;
            if (isRateLimitError(err)) {
                const jitter = Math.floor(Math.random() * 350);
                await new Promise((resolve) => setTimeout(resolve, delay + jitter));
                delay *= 2;
            } else {
                throw normalizeModelError(err);
            }
        }
    }
    throw normalizeModelError(lastError);
}

export function extractJSON(text: string): unknown {
    try {
        let cleaned = String(text || "").replace(/```json\s*/gi, "").replace(/```\s*/g, "");
        const start = cleaned.indexOf("{");
        const end = cleaned.lastIndexOf("}");
        if (start !== -1 && end !== -1 && end > start) {
            cleaned = cleaned.substring(start, end + 1);
        }

        cleaned = cleaned.replace(/"([^"]*)"/g, (_match, group) => {
            return `"${String(group).replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
        });

        return JSON.parse(cleaned);
    } catch {
        const match = String(text || "").match(/\{[\s\S]*\}/);
        if (!match) return null;
        try {
            return JSON.parse(match[0]);
        } catch {
            return null;
        }
    }
}
