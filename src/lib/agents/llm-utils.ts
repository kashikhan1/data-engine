type ModelFactory = () => any;

function normalizeModelError(err: any): Error {
    const code = err?.code || err?.cause?.code || err?.cause?.errors?.[0]?.code;
    const message = String(err?.message || "");
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
    messages: any[],
    maxRetries = 3,
    delay = 2000
) {
    let lastError: any;
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await getModel().invoke(messages, { timeout: 900000 });
        } catch (err: any) {
            lastError = err;
            const errorMsg = String(err?.message || "");
            if (errorMsg.includes("429") || errorMsg.toLowerCase().includes("too many requests") || err?.status === 429) {
                await new Promise((resolve) => setTimeout(resolve, delay));
                delay *= 2;
            } else {
                throw normalizeModelError(err);
            }
        }
    }
    throw normalizeModelError(lastError);
}

export function extractChunkText(chunk: any): string {
    const content = chunk?.content ?? chunk?.message?.content ?? chunk?.text ?? "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content.map((part: any) => part?.text || "").join("");
    }
    return "";
}

export async function streamModelWithRetry(
    getModel: ModelFactory,
    messages: any[],
    onToken?: (token: string) => void,
    maxRetries = 3,
    delay = 2000
) {
    let lastError: any;
    for (let i = 0; i < maxRetries; i++) {
        try {
            const model: any = getModel();
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
        } catch (err: any) {
            lastError = err;
            const errorMsg = String(err?.message || "");
            if (errorMsg.includes("429") || errorMsg.toLowerCase().includes("too many requests") || err?.status === 429) {
                await new Promise((resolve) => setTimeout(resolve, delay));
                delay *= 2;
            } else {
                throw normalizeModelError(err);
            }
        }
    }
    throw normalizeModelError(lastError);
}

export function extractJSON(text: string): any {
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
