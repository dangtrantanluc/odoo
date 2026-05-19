import fetch from "node-fetch";
import { config, LlmProviderName } from "../shared/config";

export type ChatMessage =
  | { role: "system" | "user" | "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string; name?: string };

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

export type ChatResponse = {
  content: string | null;
  tool_calls: ToolCall[];
  finish_reason: string;
  usage?: ChatUsage;
  latencyMs?: number;
  provider?: LlmProviderName;
  model?: string;
};

export type ChatOptions = {
  max_tokens?: number;
  temperature?: number;
  response_format?: { type: "json_object" | "text" };
  // Per-call provider override. Default = config.llm.activeProvider.
  provider?: LlmProviderName;
};

export type { LlmProviderName };

// Retry transient LLM / network failures. The Qwen vllm server we use
// sometimes returns 500 "EngineCore encountered an issue" then briefly
// refuses connections before auto-restarting. 2 retries with short backoff
// covers most flaps without blowing up tail latency.
const MAX_RETRIES = 2;
const BACKOFF_MS = 1500;

function isRetryableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Network-level: ECONNREFUSED, ECONNRESET, socket hang up, timeout
  if (/ECONNREFUSED|ECONNRESET|socket hang up|ETIMEDOUT|fetch failed/i.test(msg)) return true;
  // Upstream 5xx (EngineCore crashes, 502/503/504)
  if (/^LLM 5\d\d/.test(msg)) return true;
  return false;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function chat(
  messages: ChatMessage[],
  tools?: Array<{ type: "function"; function: { name: string; description: string; parameters: unknown } }>,
  options?: ChatOptions,
): Promise<ChatResponse> {
  const provider: LlmProviderName = options?.provider ?? config.llm.activeProvider;
  const cfg = config.llm[provider];
  if (!cfg) throw new Error(`Unknown LLM provider: ${provider}`);
  if (provider === "gemini" && !cfg.apiKey) {
    throw new Error("LLM provider 'gemini' missing GEMINI_API_KEY");
  }
  if (provider === "openrouter" && !cfg.apiKey) {
    throw new Error("LLM provider 'openrouter' missing OPENROUTER_API_KEY");
  }

  const url = `${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    max_tokens: options?.max_tokens ?? cfg.maxTokens,
    temperature: options?.temperature ?? cfg.temperature,
    // We parse the response as a single JSON object below. Asking OpenAI-compatible
    // servers for stream=true returns SSE chunks (`data: ...`), which is not
    // valid JSON for res.json().
    stream: false,
  };
  if (options?.response_format) body.response_format = options.response_format;
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  const payload = JSON.stringify(body);

  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const t0 = Date.now();
      const resp = await chatOnce(url, payload, cfg.apiKey);
      resp.latencyMs = Date.now() - t0;
      resp.provider = provider;
      resp.model = cfg.model;
      return resp;
    } catch (err: any) {
      lastErr = err;
      if (attempt === MAX_RETRIES || !isRetryableError(err)) throw err;
      const delay = BACKOFF_MS * (attempt + 1);
      console.warn(
        `[bb-pm-tools/llm:${provider}] transient failure (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${err?.message || err}. Retrying in ${delay}ms...`,
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function chatOnce(url: string, payload: string, apiKey: string): Promise<ChatResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: payload,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LLM ${res.status}: ${text}`);
  }

  const json = (await res.json()) as any;
  const choice = json?.choices?.[0];
  if (!choice) throw new Error("LLM returned no choices");

  return {
    content: choice.message?.content ?? null,
    tool_calls: choice.message?.tool_calls ?? [],
    finish_reason: choice.finish_reason ?? "stop",
    usage: json?.usage,
  };
}
