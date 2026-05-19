import { chat, ChatMessage } from "../infrastructure/llm-client";
import { bbPm } from "../infrastructure/api-client";
import type { AgentContext } from "../shared/types";

// ---------------------------------------------------------------------------
// Memory helpers — recall at start of run, summarize + store at end.
// Best-effort: never block the main reply on memory failures.
// ---------------------------------------------------------------------------

const MEMORY_RECALL_LIMIT = 3;
const MEMORY_RECALL_DAYS = 30;

// ─── Recent-turns in-memory cache (Sprint 8 follow-up) ──────────────────
//
// `summarizeAndStore` là fire-and-forget AFTER reply, nên DB chưa có summary
// của turn N khi user gõ turn N+1 ngay sau. Cache last 2 turn raw in-memory
// để recallMemoryContext có thể prepend vào prompt → user follow-up
// ("ai làm vậy?", "task đó deadline khi nào?") hiểu được context.
//
// In-memory only — restart gateway = clear. OK cho dev + single-instance prod.
// Multi-instance: cần Redis (defer until scale).

type RecentTurn = { userText: string; replyText: string; ts: number };
const RECENT_CAP_PER_CID = 2;
const RECENT_TTL_MS = 30 * 60 * 1000; // 30 min — sau đó user chuyển topic, context cũ noise hơn
const recentTurns = new Map<string, RecentTurn[]>();
const EXPLICIT_FOLLOW_UP_RE =
  /\b(lần trước|hôm qua|hồi nãy|vừa nãy|vụ đó|cái đó|điều đó|task đó|project đó|việc đó|như trên|ở trên|tiếp tục|tiếp theo|sao rồi|thế nào rồi|còn cái nào|quay lại|nhắc lại)\b/i;
const SHORT_REFERENCE_RE =
  /\b(đó|kia|này|ấy|vậy|thế|nữa|tiếp|rồi sao|ai làm|deadline khi nào|status sao|ở đâu)\b/i;

export function recordRecentTurn(
  conversationId: string | undefined,
  userText: string,
  replyText: string,
): void {
  if (!conversationId) return;
  const arr = recentTurns.get(conversationId) ?? [];
  arr.push({ userText, replyText, ts: Date.now() });
  // Cap + evict oldest
  while (arr.length > RECENT_CAP_PER_CID) arr.shift();
  recentTurns.set(conversationId, arr);
}

function getRecentTurnsBlock(conversationId: string | undefined): string {
  if (!conversationId) return "";
  const arr = recentTurns.get(conversationId);
  if (!arr || arr.length === 0) return "";
  // Filter stale
  const now = Date.now();
  const fresh = arr.filter((t) => now - t.ts < RECENT_TTL_MS);
  if (fresh.length === 0) {
    recentTurns.delete(conversationId);
    return "";
  }
  if (fresh.length !== arr.length) recentTurns.set(conversationId, fresh);

  const lines = fresh.map((t, i) => {
    const u = truncate(t.userText, 200);
    const r = truncate(t.replyText, 250);
    return `[Turn -${fresh.length - i}] User: ${u}\n              Bot: ${r}`;
  });
  return [
    "TURN GẦN ĐÂY (cùng conversation, để hiểu follow-up):",
    ...lines,
  ].join("\n");
}

function hasFreshRecentTurns(conversationId: string | undefined): boolean {
  if (!conversationId) return false;
  const arr = recentTurns.get(conversationId);
  if (!arr || arr.length === 0) return false;
  const now = Date.now();
  const fresh = arr.some((t) => now - t.ts < RECENT_TTL_MS);
  if (!fresh) recentTurns.delete(conversationId);
  return fresh;
}

export function shouldRecallMemoryContext(
  userText: string,
  ctx: AgentContext,
): boolean {
  const cleaned = userText.replace(/\[GAPO_USER:\s*[^\]]+\]/i, "").trim();
  if (!cleaned) return false;
  if (EXPLICIT_FOLLOW_UP_RE.test(cleaned)) return true;
  if (!hasFreshRecentTurns(ctx.conversationId)) return false;
  return cleaned.length <= 80 && SHORT_REFERENCE_RE.test(cleaned);
}

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

    // Prepend recent in-memory turns (catch follow-up ngay sau, DB summary
    // có thể chưa kịp ghi do summarizeAndStore async).
    const recentBlock = getRecentTurnsBlock(ctx.conversationId);

    if (collected.size === 0) return recentBlock;

    const ordered = Array.from(collected.values())
      .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
      .slice(0, MEMORY_RECALL_LIMIT);

    const lines = ordered.map((m, i) => {
      const when = new Date(m.createdAt).toISOString().slice(0, 16).replace("T", " ");
      return `[${i + 1}] (${when}) ${m.summary}`;
    });
    const dbBlock = [
      "BỐI CẢNH TRƯỚC ĐÓ (memory recall — dùng khi user hỏi kế thừa context):",
      ...lines,
    ].join("\n");
    return recentBlock ? `${recentBlock}\n\n${dbBlock}` : dbBlock;
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
      source: (args.ctx.source === "eval" ? "other" : args.ctx.source) ?? "chat",
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
