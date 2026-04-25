import { chat, ChatMessage } from "./llm";
import { bbPm } from "./api-client";
import type { AgentContext } from "./types";

// ---------------------------------------------------------------------------
// Memory helpers — recall at start of run, summarize + store at end.
// Best-effort: never block the main reply on memory failures.
// ---------------------------------------------------------------------------

const MEMORY_RECALL_LIMIT = 3;
const MEMORY_RECALL_DAYS = 30;

/**
 * Fetch up to N recent summaries for the system prompt. Priority order:
 *   1. Same conversationId (stable thread) — always relevant regardless of wording.
 *   2. Keyword overlap with current user text.
 * Returns a pre-formatted block, or "" if nothing useful found.
 */
export async function recallMemoryContext(
  userText: string,
  ctx: AgentContext,
): Promise<string> {
  try {
    const collected = new Map<number, any>();

    // 1. Same-conversation history — the cheapest, most reliable context.
    if (ctx.conversationId) {
      const byConv = await bbPm.searchMemory({
        conversationId: ctx.conversationId,
        limit: MEMORY_RECALL_LIMIT,
        daysBack: MEMORY_RECALL_DAYS,
      });
      for (const m of byConv.data) collected.set(m.id, m);
    }

    // 2. Keyword search — only top up if we still have room.
    if (collected.size < MEMORY_RECALL_LIMIT) {
      const q = pickRecallKeyword(userText);
      if (q) {
        const byKw = await bbPm.searchMemory({
          q,
          limit: MEMORY_RECALL_LIMIT - collected.size,
          daysBack: MEMORY_RECALL_DAYS,
        });
        for (const m of byKw.data) collected.set(m.id, m);
      }
    }

    if (collected.size === 0) return "";

    const ordered = Array.from(collected.values())
      .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
      .slice(0, MEMORY_RECALL_LIMIT);

    const lines = ordered.map((m, i) => {
      const when = new Date(m.createdAt).toISOString().slice(0, 16).replace("T", " ");
      return `[${i + 1}] (${when}) ${m.summary}`;
    });
    return [
      "BỐI CẢNH TRƯỚC ĐÓ (memory recall — dùng khi user hỏi kế thừa context):",
      ...lines,
    ].join("\n");
  } catch (err: any) {
    console.warn("[bb-pm-tools] memory recall failed:", err?.message || err);
    return "";
  }
}

/**
 * Ask the LLM to summarize an agent run in ≤2 sentences, then persist it.
 * Fire-and-forget — caller does not await.
 */
export async function summarizeAndStore(args: {
  userText: string;
  replyText: string;
  toolsUsed: string[];
  projectIds: number[];
  taskIds: number[];
  ctx: AgentContext;
}): Promise<void> {
  // Skip trivial exchanges: no tools called AND reply < 80 chars.
  if (args.toolsUsed.length === 0 && args.replyText.trim().length < 80) return;

  try {
    const summary = await llmSummarize(args.userText, args.replyText, args.toolsUsed);
    if (!summary) return;
    await bbPm.postMemory({
      conversationId: args.ctx.conversationId ?? args.ctx.correlationId,
      source: (args.ctx.source as any) ?? "chat",
      userText: truncate(args.userText, 2000),
      replyText: truncate(args.replyText, 4000),
      summary: truncate(summary, 1000),
      toolsUsed: args.toolsUsed,
      projectIds: args.projectIds,
      taskIds: args.taskIds,
      correlationId: args.ctx.correlationId,
    });
  } catch (err: any) {
    console.warn("[bb-pm-tools] memory store failed:", err?.message || err);
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function pickRecallKeyword(userText: string): string {
  // Strip `[GAPO_USER: ...]` prefix added by channel adapter, trim, cap length.
  const cleaned = userText.replace(/\[GAPO_USER:\s*[^\]]+\]/i, "").trim();
  return cleaned.slice(0, 200);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}

async function llmSummarize(
  userText: string,
  replyText: string,
  toolsUsed: string[],
): Promise<string | null> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "Bạn là bộ phận ghi nhớ của PM Agent. Nhiệm vụ: tóm tắt 1 lượt hội thoại " +
        "trong TỐI ĐA 2 câu tiếng Việt, ≤ 300 ký tự. Bao gồm: chủ đề chính, " +
        "kết quả/tool đã dùng, task/project ID nếu có. KHÔNG lặp lại toàn văn, " +
        "KHÔNG thêm giải thích.",
    },
    {
      role: "user",
      content:
        `Tools đã dùng: ${toolsUsed.length ? toolsUsed.join(", ") : "(không)"}\n\n` +
        `User hỏi: ${truncate(userText, 800)}\n\n` +
        `Agent trả lời: ${truncate(replyText, 1200)}\n\n` +
        "Tóm tắt (≤ 2 câu):",
    },
  ];
  try {
    const resp = await chat(messages);
    return resp.content?.trim() || null;
  } catch (err: any) {
    console.warn("[bb-pm-tools] summarize chat failed:", err?.message || err);
    return null;
  }
}
