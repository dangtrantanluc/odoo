// Sprint 8 Phase #5 — Response formatter layer.
//
// Đứng giữa orchestrator và channel-out. Nhận rawReply (LLM/tool output có thể
// còn lộ tên bảng, userId, JSON, error stack) → biến thành reply chat-ready.
//
// Strategy (3 tầng, thứ tự quan trọng):
//   1. Template match: keyword match → render template tiếng Việt thân thiện.
//      LUÔN check trước skip — vì raw text "0 task" có thể sạch nhưng template
//      "Mình chưa thấy task nào... Bạn muốn liệt kê task đang giao không?" UX
//      tốt hơn (gợi action tiếp theo).
//   2. Skip fast path: raw đã sạch + ngắn + không match template → trả thẳng
//      (không gọi LLM, tiết kiệm latency).
//   3. LLM rewrite (Qwen): fallback cho free-form text có leak/verbose. Tight
//      prompt + max_tokens 300 + timeout 30s. Fail/timeout → trả raw (degrade).
//
// Đặt KHÔNG dùng Gemini để tránh phụ thuộc API key/quota production. Qwen tốn
// thêm 10-30s/turn nhưng OK với chat UX user đã quen độ trễ.
//
// Skip formatter cho source: cli, eval (dev/golden cần raw text).

import { chat, ChatMessage } from "./llm";
import { renderTemplate } from "./template";
import type { AgentContext } from "./types";

const FORMATTER_ENABLED = (process.env.BB_PM_FORMATTER_ENABLED ?? "true").toLowerCase() === "true";
// 2026-05-07 — Khi switch sang OpenRouter (GPT-4o/Gemini) output đã đủ sạch,
// tầng LLM rewrite có thể hallucinate (Gemini-2.5-flash từng bịa "đã tạo tài
// khoản"). Set false để skip Tier 3, vẫn giữ Tier 1 (template) + leak strip +
// redact (rẻ, không gọi LLM).
const FORMATTER_LLM_REWRITE = (process.env.BB_PM_FORMATTER_LLM_REWRITE ?? "true").toLowerCase() === "true";
const FORMATTER_TIMEOUT_MS = Number(process.env.BB_PM_FORMATTER_TIMEOUT_MS ?? 30_000);
const FORMATTER_MAX_TOKENS = Number(process.env.BB_PM_FORMATTER_MAX_TOKENS ?? 300);

// ─── Templates ─────────────────────────────────────────────────────────
//
// Mỗi template là static text Vietnamese hoặc Mustache-style với {{var}}.
// Dùng renderTemplate (đã có ở src/template.ts) để substitute.
//
// Khi thêm template mới: nhớ thêm key vào TemplateKey type + classifier
// keyword vào CLASSIFIER_RULES.
// ──────────────────────────────────────────────────────────────────────

export type TemplateKey =
  | "missingSalary"
  | "taskCost"
  | "noTask"
  | "taskAssigned"
  | "digestSent"
  | "dataMissing"
  | "permissionDenied"
  | "toolError"
  | "endSession";

// User message patterns thực sự là acknowledgement (đóng phiên hợp lệ).
// Phải MATCH thì mới được apply endSession template. "hi", "tôi đang làm gì",
// và các câu hỏi thật KHÔNG match — bảo vệ khỏi Qwen over-eager emit
// [END_SESSION] cho mọi tin ngắn.
//
// Mirror fast-path end_session regex để consistent.
// Vietnamese 'a' family: a/á/à/ả/ã/ạ — char class phải đầy đủ ("cảm" với 'ả').
const USER_IS_ACK_RE = /^\s*(ok\s*(c[aáàảãạ]m\s*[oơ]n|b[aạ]n)?|c[aáàảãạ]m\s*[oơ]n|thanks?|thank\s*you|tks|hi[eể]u\s*r[oồ]i|r[oõ]|t[aạ]m\s*bi[eệ]t|bye|ch[aà]o\s*(b[aạ]n|nh[eé])?|v[aậ]y\s*th[oô]i|đư[ơợ]c\s*r[oồ]i|n[oó]\s*đ[uú]ng|👍|👌|❤️|🙏)\s*[!.,]*\s*$/iu;

export const templates: Record<TemplateKey, string> = {
  missingSalary: `Mình chưa đủ dữ liệu để tính chi phí task của bạn.

Thiếu:
- Mức lương/giờ (rate)
- Số giờ ước tính

Bạn muốn cập nhật ngay không?`,

  taskCost: `Chi phí ước tính task: {{cost}}.

Cách tính: {{hours}} giờ × {{rate}}/giờ.`,

  noTask: `Mình chưa thấy task nào của bạn.

Bạn muốn mình liệt kê task đang được giao không?`,

  taskAssigned: `✓ Đã giao task "{{taskName}}" cho {{assignee}}.`,

  digestSent: `✓ Digest đã gửi vào {{target}}. {{summary}}`,

  dataMissing: `Mình thiếu thông tin để trả lời chính xác.

Cần thêm: {{missing}}.

Bạn cung cấp giúp nhé?`,

  permissionDenied: `Bạn cần quyền {{requiredRole}} cho thao tác này.

Hiện bạn là {{currentRole}}. Liên hệ admin để nâng quyền.`,

  toolError: `Mình gặp lỗi khi xử lý: {{friendly}}.

Bạn thử lại sau ít phút, hoặc báo dev nếu lặp lại.`,

  // PHẢI giữ marker [END_SESSION] để watcher detect → skip send + cooldown 5min.
  // Nếu strip marker, watcher gửi "OK bạn 👍" thật + không cooldown → loop spam.
  endSession: `OK bạn 👍 [END_SESSION]`,
};

// ─── Classifier ────────────────────────────────────────────────────────
//
// Pattern match raw reply để chọn template. KHÔNG perfect — chỉ cover case
// rõ ràng. Miss → fallback LLM rewrite.
//
// Mỗi rule: regex test trên raw text (lowercase). Match đầu tiên thắng.
// ──────────────────────────────────────────────────────────────────────

type ClassifierRule = {
  key: TemplateKey;
  test: (rawLower: string) => boolean;
  // Optional: extract vars từ raw text. Null = template không cần var,
  // hoặc var sẽ default empty string.
  extractVars?: (raw: string) => Record<string, string> | null;
};

const CLASSIFIER_RULES: ClassifierRule[] = [
  // Salary / rate missing — agent thường nói "không có rate", "chưa cấu hình lương"
  {
    key: "missingSalary",
    test: (s) => /không có (rate|lương)|chưa (có|cấu hình|set) (rate|lương)|hourly.{0,5}rate.{0,15}(null|none|empty)/i.test(s),
  },
  // No task assigned to user.
  //
  // 2026-05-07 — Thắt regex sau khi gặp false positive: Lực có 9 task nhưng
  // raw "0 task quá hạn hôm nay" cũng match → bị promote thành noTask template
  // ("Mình chưa thấy task nào của bạn") gây hiểu nhầm.
  //
  // Rule mới 2 lớp:
  // 1. Skip nếu raw có time/filter qualifier (hôm nay, deadline, quá hạn,
  //    overdue, stale, tuần này...) — đây là zero-result của filter, không
  //    phải user thật sự không có task.
  // 2. Phải match dạng phát biểu sạch "không/chưa có task nào (của bạn)?" ở
  //    cuối câu, hoặc "0 task" đứng một mình. Nếu đi kèm filter context →
  //    không match.
  {
    key: "noTask",
    test: (s) => {
      const QUALIFIER_RE =
        /\b(hôm nay|hôm qua|chiều nay|sáng nay|tối nay|today|deadline|quá hạn|overdue|stale|tuần (này|trước|sau)|gần đây|recent|priority|urgent|high|low|blocker|status\s*=|todo|in[_\s-]?progress|done)\b/i;
      if (QUALIFIER_RE.test(s)) return false;
      return /(không|chưa) (có|tìm thấy) task nào (của (bạn|anh|chị|em))?\s*[.!?]?$|^0 task\s*[.!?]?$|task của bạn.{0,15}(rỗng|empty|trống)/im.test(s);
    },
  },
  // Permission denied
  {
    key: "permissionDenied",
    test: (s) => /(không có|thiếu) quyền|(member|viewer).{0,30}(không thể|không được)|forbidden|unauthorized|permission denied/i.test(s),
    extractVars: (raw) => {
      const required = raw.match(/cần.{0,5}(MANAGER|ADMIN|MEMBER)/i)?.[1] ?? "MANAGER";
      const current = raw.match(/(?:là|hiện).{0,5}(MEMBER|VIEWER|MANAGER|ADMIN)/i)?.[1] ?? "MEMBER";
      return { requiredRole: required.toUpperCase(), currentRole: current.toUpperCase() };
    },
  },
  // End session marker
  {
    key: "endSession",
    test: (s) => s.includes("[end_session]"),
  },
  // Tool / backend error leaked through
  {
    key: "toolError",
    test: (s) => /^error:|exception:|stack trace|traceback|\[error\]|prisma.{0,5}error|sql.{0,5}error|econnrefused/i.test(s),
    extractVars: () => ({ friendly: "lỗi tạm thời từ hệ thống" }),
  },
];

export function classifyTemplate(raw: string): { key: TemplateKey; vars: Record<string, string> } | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  for (const rule of CLASSIFIER_RULES) {
    if (rule.test(lower)) {
      const vars = rule.extractVars ? rule.extractVars(raw) ?? {} : {};
      return { key: rule.key, vars };
    }
  }
  return null;
}

// ─── Skip fast path ────────────────────────────────────────────────────
//
// Nếu raw đã sạch (ngắn, không markdown, không leak DB term, không JSON) →
// skip formatter để khỏi double LLM latency. Đa số reply từ system prompt
// hiện tại đã pass criteria này.
// ──────────────────────────────────────────────────────────────────────

const DB_LEAK_TOKENS = [
  "user_id", "userid", "company_id", "companyid", "task_id", "taskid",
  "project_id", "projectid", "assignee_id", "assigneeid",
  "select ", "from users", "from tasks", "from projects",
  "prisma.", "where ", "raw json", "stack", "traceback",
  "@gapo.local",
];

// 2026-05-07 — Tool-call hallucination detector. Qwen self-host đôi khi không
// emit OpenAI structured tool_calls mà chèn JSON dạng ```json {"tool":...}```
// vào content → orchestrator coi là final reply. Pattern cover cả raw JSON
// (no fence) và "tool":"name" / "arguments":{} signature. Nếu match → format
// luôn rewrite (LLM hoặc fallback ngắn) thay vì để leak.
const TOOL_CALL_LEAK_RE =
  /```\s*(?:json)?\s*[\s\S]*?(?:"tool"|"name"|"function"|"arguments")\s*:[\s\S]*?```|"tool"\s*:\s*"[a-z_.]+"|"arguments"\s*:\s*\{/i;

export function hasToolCallLeak(raw: string): boolean {
  return TOOL_CALL_LEAK_RE.test(raw);
}

// 2026-05-07 — Internal-identity redactor cho final reply. Bot không nên
// rao userId số + email synth (`<name>.<cid>@gapo.local`) cho người dùng.
// Replace pattern đặt giữa formatter pipeline (sau template, trước trả về).
//
// Coverage:
// - "userId: 24" / "userid 24" / "user_id=24"
// - "email: foo@gapo.local" / "(...@gapo.local)"
// - " (userId: 24, email: ...)" — toàn parenthetical block.
export function redactInternalIds(raw: string): string {
  if (!raw) return raw;
  return raw
    .replace(/\s*\([^)]*\b(?:userId|user_id|email)\b[^)]*\)/gi, "")
    .replace(/\s*[,;]?\s*\b(?:userId|user_id|user id)\b\s*[:=]?\s*\d+/gi, "")
    .replace(/\b(?:bb-?pm\s+)?email\b\s*[:=]?\s*[\w.-]+@gapo\.local/gi, "")
    .replace(/[\w.-]+@gapo\.local/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

export function shouldSkipFormatter(raw: string): boolean {
  if (!raw) return true;
  const trimmed = raw.trim();
  // Quá dài → có khả năng cần rewrite
  if (trimmed.length > 350) return false;
  const lower = trimmed.toLowerCase();
  // Có markdown markers chưa strip → cần formatter (mặc dù strip layer cũng xử
  // lý được, formatter giúp restructure câu)
  if (/\*\*|__|```|^#{1,6}\s/m.test(trimmed)) return false;
  // Có JSON-like
  if (/^[\[{]/.test(trimmed) || /\}\s*$/.test(trimmed)) return false;
  // Có DB-leak tokens
  for (const tok of DB_LEAK_TOKENS) {
    if (lower.includes(tok)) return false;
  }
  return true;
}

// ─── LLM rewriter ──────────────────────────────────────────────────────

const RESPONSE_FORMATTER_PROMPT = `Bạn là PM Assistant trong chat nội bộ công ty BlueBolt.

Nhiệm vụ: viết lại câu trả lời cho người dùng cuối — ngắn gọn, tự nhiên, chat-style.

Luật BẮT BUỘC:
- KHÔNG nhắc tên bảng database (users, tasks, projects, ...), field kỹ thuật (user_id, company_id, raw JSON, prisma error).
- KHÔNG giải thích lỗi backend / stack trace cho user.
- KHÔNG dùng giọng máy móc / report dài. Viết như đồng nghiệp chat Slack.
- Tối đa 5 dòng. Câu hỏi đơn giản → 1-2 dòng đủ.
- Không markdown (**bold**, ## heading). Plain text.
- Nếu thiếu dữ liệu: nói RÕ thiếu cái gì bằng ngôn ngữ user hiểu (không nói "userId null").
- Luôn có bước tiếp theo cụ thể nếu user cần action.
- Giọng lịch sự, thân thiện, chuyên nghiệp. Tiếng Việt.
- Giữ nguyên fact/số liệu trong raw — KHÔNG bịa thêm.

Output: CHỈ trả về message cuối cùng để gửi user. Không preamble, không giải thích.`;

async function llmRewrite(raw: string): Promise<string | null> {
  const messages: ChatMessage[] = [
    { role: "system", content: RESPONSE_FORMATTER_PROMPT },
    { role: "user", content: `Raw response cần viết lại:\n\n${raw}` },
  ];
  // Race với timeout — nếu Qwen quá chậm, bypass formatter.
  const llmPromise = chat(messages, undefined, { max_tokens: FORMATTER_MAX_TOKENS, temperature: 0.3 });
  const timeoutPromise = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), FORMATTER_TIMEOUT_MS),
  );
  try {
    const result = await Promise.race([llmPromise, timeoutPromise]);
    if (!result) {
      console.warn(`[formatter] LLM rewrite timeout after ${FORMATTER_TIMEOUT_MS}ms — falling back to raw`);
      return null;
    }
    const text = result.content?.trim() ?? "";
    if (!text) {
      console.warn("[formatter] LLM returned empty — falling back to raw");
      return null;
    }
    return text;
  } catch (err: any) {
    console.warn(`[formatter] LLM rewrite failed: ${err?.message ?? err} — falling back to raw`);
    return null;
  }
}

// ─── Public API ────────────────────────────────────────────────────────

export async function formatResponse(
  raw: string,
  ctx: AgentContext,
  userMessage?: string,
): Promise<string> {
  if (!FORMATTER_ENABLED) return raw;
  if (!raw) return raw;

  // Skip cho dev/eval source — golden test cần raw, CLI cần raw để debug.
  if (ctx.source === "cli" || ctx.source === "eval") return raw;

  // Special-case: nếu raw có marker [END_SESSION] nhưng user message KHÔNG
  // phải acknowledgement → Qwen sai, strip marker và xử lý như reply thường.
  // Nếu user thật sự ack → giữ marker (template endSession sẽ preserve).
  let workingRaw = raw;
  if (/\[end_session\]/i.test(raw)) {
    const userIsAck = userMessage ? USER_IS_ACK_RE.test(userMessage) : false;
    if (!userIsAck) {
      workingRaw = raw.replace(/\s*\[end_session\]\s*/gi, " ").trim();
      console.log(
        `[formatter] strip wrong [END_SESSION] — userMessage="${(userMessage ?? "").slice(0, 40)}" not an ack`,
      );
    }
  }

  // 2026-05-07 — Tool-call hallucination guard. Qwen đôi khi nhét JSON tool
  // call vào content thay vì OpenAI tool_calls field → orchestrator coi là
  // final → user thấy ```json {"tool":"search_tasks",...}```.
  // Strip fenced JSON + tool signature TRƯỚC mọi tier, sau đó nếu phần text
  // còn lại < 8 chars → trả friendly fallback thay vì phần thừa rời rạc.
  if (hasToolCallLeak(workingRaw)) {
    const stripped = workingRaw
      .replace(/```\s*(?:json)?\s*[\s\S]*?```/g, "")
      .replace(/"tool"\s*:\s*"[^"]+"\s*,?/gi, "")
      .replace(/"arguments"\s*:\s*\{[\s\S]*?\}\s*,?/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    console.warn(
      `[formatter] tool-call leak detected (Qwen content-mode) — stripped "${workingRaw.slice(0, 80)}…" → "${stripped.slice(0, 80)}…"`,
    );
    workingRaw = stripped.length > 8
      ? stripped
      : "Mình đang tra cứu giúp bạn, đợi mình thử lại nhé.";
  }

  // Tier 1: template match (LUÔN check trước skip — UX template tốt hơn raw)
  const matched = classifyTemplate(workingRaw);
  if (matched) {
    const tmpl = templates[matched.key];
    const rendered = renderTemplate(tmpl, matched.vars);
    console.log(`[formatter] template=${matched.key} skipped LLM`);
    return redactInternalIds(rendered);
  }

  // Tier 2: skip if already clean (chỉ khi không match template nào)
  if (shouldSkipFormatter(workingRaw)) {
    return redactInternalIds(workingRaw);
  }

  // Tier 3: LLM rewrite (cùng provider với main LLM). Có thể tắt qua
  // BB_PM_FORMATTER_LLM_REWRITE=false khi dùng provider có output sạch
  // (GPT-4o/Gemini) — Tier 3 từng hallucinate khi rewrite.
  if (!FORMATTER_LLM_REWRITE) {
    return redactInternalIds(workingRaw);
  }

  const t0 = Date.now();
  const rewritten = await llmRewrite(workingRaw);
  const dur = Date.now() - t0;
  if (rewritten) {
    console.log(`[formatter] LLM rewrite ok dur=${dur}ms ${workingRaw.length}→${rewritten.length} chars`);
    return redactInternalIds(rewritten);
  }
  console.log(`[formatter] LLM rewrite skipped/failed dur=${dur}ms — using raw`);
  return redactInternalIds(workingRaw);
}
