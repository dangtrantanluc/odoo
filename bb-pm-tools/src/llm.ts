import fetch from "node-fetch";
import { config } from "./config";

export type ChatMessage =
  | { role: "system" | "user" | "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string; name?: string };

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatResponse = {
  content: string | null;
  tool_calls: ToolCall[];
  finish_reason: string;
};

export type ChatOptions = {
  max_tokens?: number;
  temperature?: number;
  response_format?: { type: "json_object" | "text" };
};

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
  const url = `${config.llm.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const body: Record<string, unknown> = {
    model: config.llm.model,
    messages,
    max_tokens: options?.max_tokens ?? config.llm.maxTokens,
    temperature: options?.temperature ?? config.llm.temperature,
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
      return await chatOnce(url, payload);
    } catch (err: any) {
      lastErr = err;
      if (attempt === MAX_RETRIES || !isRetryableError(err)) throw err;
      const delay = BACKOFF_MS * (attempt + 1);
      console.warn(
        `[bb-pm-tools/llm] transient failure (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${err?.message || err}. Retrying in ${delay}ms...`,
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function chatOnce(url: string, payload: string): Promise<ChatResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.llm.apiKey}`,
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
  };
}
