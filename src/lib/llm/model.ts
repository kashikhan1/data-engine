import { ChatOllama } from "@langchain/ollama";
import { ChatOpenAI } from "@langchain/openai";

type ChatModel = ChatOllama | ChatOpenAI;

type CreateChatModelOptions = {
    logPrefix?: string;
    ollamaFallbackModel?: string;
    openAIFallbackModel?: string;
    timeoutMs?: number;
    temperature?: number;
    maxTokens?: number;
};

const readEnv = (key: string): string | undefined => {
    const direct = process.env[key];
    if (direct) return direct;
    return process.env[`NEXT_PUBLIC_${key}`];
};

export function createDefaultChatModel(options: CreateChatModelOptions = {}): ChatModel {
    const openAIApiKey = readEnv("OPENAI_API_KEY");
    const openAIModel = readEnv("OPENAI_MODEL") || options.openAIFallbackModel || "gpt-4o-mini";

    const ollamaBaseUrl = readEnv("OLLAMA_BASE_URL");
    const ollamaApiKey = readEnv("OLLAMA_API_KEY");
    const ollamaModel = readEnv("OLLAMA_MODEL") || options.ollamaFallbackModel || "llama3.2";

    const useOllama = Boolean(ollamaBaseUrl) || Boolean(ollamaApiKey) || !openAIApiKey;
    const logPrefix = options.logPrefix || "[LLM]";

    if (useOllama) {
        const base = ollamaBaseUrl || "http://localhost:11434";
        if (typeof window === "undefined") {
            console.log(`${logPrefix} Using Ollama endpoint: ${ollamaModel} @ ${base}`);
        }
        return new ChatOllama({
            model: ollamaModel,
            baseUrl: base,
            temperature: options.temperature ?? 0,
            numCtx: 32768,
            headers: ollamaApiKey ? { Authorization: `Bearer ${ollamaApiKey}` } : undefined,
        });
    }

    if (typeof window === "undefined") {
        console.log(`${logPrefix} Using OpenAI: ${openAIModel}`);
    }
    return new ChatOpenAI({
        modelName: openAIModel,
        model: openAIModel,
        temperature: options.temperature ?? 0,
        openAIApiKey,
        timeout: options.timeoutMs ?? 900000,
        maxTokens: options.maxTokens,
    });
}
