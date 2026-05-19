// Sprint 8 Day 3 — Pre-classifier fast path.
// Bypass full ReAct LLM loop cho common queries pattern-match được.
// Save 50s+/turn cho ~25-40% queries (END_SESSION, "task của tôi", etc).
//
// Wire ở đầu runAgent: if tryFastPath() returns non-null → execute trực tiếp,
// skip LLM entirely. Fall through nếu pattern không match.

import type { AgentContext } from "../../shared/types";
import { toolsByName } from "../../tools";
import { NO_CALLER_REPLY } from "./constants";
import {
  formatAutomations,
  formatBlockedList,
  formatDigest,
  formatOverdueList,
  formatPersonTasks,
  formatProjectDailyProgress,
  formatProjectList,
  formatProjectSnapshotLookup,
  formatPersonDailyProgress,
  formatRole,
  formatStaleList,
  formatTaskDeadlineLookup,
  formatTaskList,
  formatTaskOwnerLookup,
  formatTaskProgressLookup,
  formatTaskStatusLookup,
  formatWeekly,
  cleanTaskLookupQuery,
} from "./formatters";
import { executeFastPath, _resetFastPathCircuit } from "./executor";

export type FastPathResult = {
  /** Pattern name cho audit log. */
  pattern: string;
  /** Pre-formatted reply nếu không cần backing tool, hoặc undefined. */
  directReply?: string;
  /** Backing tool to invoke. undefined nếu directReply set. */
  toolName?: string;
  /** Args cho backing tool. */
  toolArgs?: any;
  /** Format tool result thành VN reply. */
  formatReply?: (toolResult: any, ctx: AgentContext) => string;
};

const FAST_PATH_DISABLED = process.env.BB_PM_FAST_PATH === "0";
const INTENT_MISS_LOG_ENABLED = process.env.BB_PM_FAST_PATH_MISS_LOG !== "0";

// F1 fix (2026-05-07): khi pattern cần callerUserId nhưng resolve fail
// (Gapo cid không trong bb-pm channel_identity), trả friendly error THAY VÌ
// silent return null. Lý do: return null → fall through full LLM → Qwen
// xử lý 60-180s rồi trả câu mơ hồ. Friendly error fix UX + free up slot.

// Vietnamese self-pronouns — đầy đủ list cho corporate chat.
// Regex source: tôi, mình, t, anh, em, chị, tớ, tao, cháu, con
//
// IMPORTANT (2026-05-07): JavaScript regex `\b` là ASCII-only kể cả với flag `/u`.
// "ị" (U+1ECB) không phải ASCII word char → `\bch[ịi]\b\s+...` không match
// "chị có ..." vì giữa "ị" và space đều là non-ASCII-word → no boundary.
// Workaround: dùng EXPLICIT lookahead `(?=\s|$|[?.,!:;])` thay `\b` sau pronoun.
// Trade-off: false-positive nếu pronoun nằm trong từ ghép (vd "tôimình") —
// tiếng Việt không có composite này → safe.
//
// Negative lookahead loại:
//   - 3rd-person markers ("anh ấy" = he, "em đó" = that one)
//   - Vocative particles ("anh ơi" = calling bot, "em nhé/ạ/nha" = address tag)
const SELF_PRONOUN = "(tôi|m[ìi]nh|t[aả]o|t[ớo]|t|anh|em|ch[ịi]|ch[aá]u|con)";
const NOT_3RD_OR_VOCATIVE = "(?!\\s+([aấ]y|đó|kia|này|nó|ơi|nhé|ạ|nha|vậy))";
const BOUNDARY_AFTER = "(?=\\s|$|[?.,!:;])";
const SELF_PRONOUN_RE_STR = `${SELF_PRONOUN}${BOUNDARY_AFTER}${NOT_3RD_OR_VOCATIVE}`;

// ─── Slash commands ──────────────────────────────────────────────────
// Power user shortcut: gõ "/help" → list commands, "/digest" → daily_digest, ...
// Bypass Qwen hoàn toàn. Pattern match TRƯỚC regex Vietnamese (cheap + reliable).
//
// Kiểu input: "/cmd" hoặc "/cmd args" (case-insensitive). Strip GAPO_USER prefix
// trước khi match (cùng logic như tryFastPath).
const SLASH_RE = /^\s*\/([a-z][a-z0-9_-]*)\s*(.*)$/i;

function currentTurnText(text: string): string {
  return text
    .split(/\n\s*---\s*Context\s*---\s*/i)[0]
    .replace(/\[GAPO_USER:\s*[^\]]+\]/i, "")
    .trim();
}

export function normalizeFastPathText(text: string): string {
  return text
    .replace(/\[GAPO_USER:\s*[^\]]+\]/i, "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[?!.,;:()"'`]/g, " ")
    .replace(/\b(vay|a|nha|nhe|di|voi|giup|gium|cho em|cho toi|cho minh|bot oi|anh oi|chi oi)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type IntentName =
  | "my_tasks_today"
  | "my_tasks_week"
  | "my_projects"
  | "overdue_tasks"
  | "blocked_tasks"
  | "stale_tasks"
  | "daily_digest"
  | "weekly_report"
  | "my_role"
  | "unknown";

export type IntentDetection = {
  intent: IntentName;
  confidence: number;
  matchedSlots: string[];
};

const SLOTS = {
  self: ["toi", "em", "minh", "anh", "chi", "t", "my"],
  task: ["task", "tasks", "viec", "cong viec", "nhiem vu", "deadline"],
  project: ["project", "du an"],
  today: ["hom nay", "today", "sang nay", "chieu nay", "toi nay"],
  week: ["tuan nay", "week", "7 ngay"],
  overdue: ["qua han", "tre han", "overdue", "tre deadline"],
  blocked: ["block", "blocked", "blocker", "bi chan", "vuong", "ket"],
  stale: ["stale", "lau chua update", "lau chua cap nhat", "bo quen"],
  digest: ["digest", "tong hop", "bao cao hom nay", "bao cao sang", "tong quan"],
  weekly: ["weekly", "bao cao tuan", "tuan qua"],
  role: ["role", "quyen", "vai tro", "toi la ai", "who am i"],
} as const;

function hasPhrase(q: string, phrase: string): boolean {
  if (phrase.includes(" ")) return q.includes(phrase);
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)${escaped}(?=\\s|$)`).test(q);
}

function hasAny(q: string, terms: readonly string[]): boolean {
  return terms.some((term) => hasPhrase(q, term));
}

function matchedSlotNames(slots: Record<string, boolean>): string[] {
  return Object.entries(slots)
    .filter(([, matched]) => matched)
    .map(([name]) => name);
}

export function detectIntentWithScore(q: string): IntentDetection {
  const slots = {
    self: hasAny(q, SLOTS.self),
    task: hasAny(q, SLOTS.task),
    project: hasAny(q, SLOTS.project),
    today: hasAny(q, SLOTS.today),
    week: hasAny(q, SLOTS.week),
    overdue: hasAny(q, SLOTS.overdue),
    blocked: hasAny(q, SLOTS.blocked),
    stale: hasAny(q, SLOTS.stale),
    digest: hasAny(q, SLOTS.digest),
    weekly: hasAny(q, SLOTS.weekly),
    role: hasAny(q, SLOTS.role),
  };
  const matchedSlots = matchedSlotNames(slots);

  if (slots.self && slots.task && slots.today) {
    return { intent: "my_tasks_today", confidence: 0.95, matchedSlots };
  }
  if (slots.self && slots.task && slots.week) {
    return { intent: "my_tasks_week", confidence: 0.9, matchedSlots };
  }
  if (slots.self && slots.project) {
    return { intent: "my_projects", confidence: 0.9, matchedSlots };
  }
  if (slots.task && slots.overdue) {
    return { intent: "overdue_tasks", confidence: 0.88, matchedSlots };
  }
  if (slots.task && slots.blocked) {
    return { intent: "blocked_tasks", confidence: 0.9, matchedSlots };
  }
  if (slots.task && slots.stale) {
    return { intent: "stale_tasks", confidence: 0.88, matchedSlots };
  }
  if (slots.digest) {
    return { intent: "daily_digest", confidence: 0.86, matchedSlots };
  }
  if (slots.weekly) {
    return { intent: "weekly_report", confidence: 0.86, matchedSlots };
  }
  if (slots.self && slots.role) {
    return { intent: "my_role", confidence: 0.9, matchedSlots };
  }

  return { intent: "unknown", confidence: 0, matchedSlots: [] };
}

// Những câu này có slot "self + project/task" nhưng bản chất là yêu cầu ghi dữ liệu,
// không phải câu hỏi read. Nếu để slot detector chạy trước, "toi muon tao project moi"
// bị hiểu thành my_projects chỉ vì có "toi" + "project".
function isActionLikeTurn(q: string): boolean {
  return /(^|\s)(tao|doi|giao|assign|danh dau|xoa|gui|sua|chuyen)(?=\s|$)/u.test(q) ||
    /^\s*update\b/u.test(q);
}

const SLASH_HELP_TEXT = `Slash commands (gõ "/<cmd>" để chạy ngay, không qua LLM):

- /worklog — cập nhật worklog hôm nay
- /checkin — alias của /worklog
- /project — chọn project cho phiên worklog
- /report — báo cáo hôm nay
- /blocker — hướng dẫn báo blocker
- /help — danh sách lệnh này
- /digest — daily digest (3 dự án, task open, overdue, stale, unassigned)
- /weekly — weekly report (7 ngày: done, blocker mới, hours)
- /mytasks — task được giao cho bạn
- /overdue — task quá hạn deadline
- /blocked — task đang bị block
- /stale — task lâu chưa update (>7d)
- /projects — dự án đang active
- /role — vai trò + quyền của bạn
- /automations — cron automations đang chạy

Câu hỏi tự nhiên cũng work bình thường (qua LLM, chậm hơn).`;

const GREETING_REPLY =
  "Chào bạn, mình là PM bot. Bạn có thể gõ /checkin để cập nhật worklog, /mytasks để xem task của bạn, hoặc hỏi tiến độ project/task.";

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const SLASH_COMMANDS: Record<string, (args: string, ctx: AgentContext) => FastPathResult | null> = {
  help: () => ({ pattern: "slash:help", directReply: SLASH_HELP_TEXT }),

  digest: () => ({
    pattern: "slash:digest",
    toolName: "generate_daily_digest",
    toolArgs: {},
    formatReply: (r) => formatDigest(r),
  }),

  report: () => ({
    pattern: "slash:report",
    toolName: "generate_daily_digest",
    toolArgs: {},
    formatReply: (r) => formatDigest(r),
  }),

  blocker: () => ({
    pattern: "slash:blocker",
    directReply:
      "Bạn gửi theo dạng: task nào đang bị vướng và vì sao. Ví dụ: \"task API login đang kẹt vì service timeout\".",
  }),

  weekly: () => ({
    pattern: "slash:weekly",
    toolName: "generate_weekly_report",
    toolArgs: { days: 7 },
    formatReply: (r) => formatWeekly(r),
  }),

  mytasks: (_args, ctx) => {
    if (!ctx.callerUserId) {
      return { pattern: "slash:mytasks:no_caller", directReply: NO_CALLER_REPLY };
    }
    return {
      pattern: "slash:mytasks",
      toolName: "search_tasks",
      toolArgs: { assigneeId: ctx.callerUserId, statusNotIn: ["DONE"], limit: 20 },
      formatReply: (r) => formatTaskList(r?.tasks ?? r?.rows ?? [], "Task của bạn"),
    };
  },

  overdue: () => ({
    pattern: "slash:overdue",
    toolName: "list_overdue_tasks",
    toolArgs: { days: 0, limit: 50 },
    formatReply: (r) => formatOverdueList(r?.tasks ?? [], r?.total ?? 0),
  }),

  // FIX 2026-05-07: list_blocked_tasks gọi /tasks?status=BLOCKED nhưng
  // TaskStatus enum chỉ có TODO/IN_PROGRESS/REVIEW/DONE — không có BLOCKED.
  // Concept "blocked" thực sự = task có TaskBlocker entries. Switch sang
  // report.query SQL via JOIN task_blockers.
  blocked: () => ({
    pattern: "slash:blocked",
    toolName: "report.query",
    toolArgs: {
      sql: `SELECT t.id, t.name, t.status, t.priority, p.name AS project,
                   COUNT(b.id) AS blocker_count, MAX(b.severity) AS max_severity
            FROM tasks t
            JOIN projects p ON p.id = t.project_id
            JOIN task_blockers b ON b.task_id = t.id
            WHERE p.company_id = 1 AND t.status != 'DONE'
            GROUP BY t.id, t.name, t.status, t.priority, p.name
            ORDER BY blocker_count DESC, t.priority DESC LIMIT 30`,
    },
    formatReply: (r) => formatBlockedList(r?.rows ?? [], r?.rowCount ?? 0),
  }),

  stale: () => ({
    pattern: "slash:stale",
    toolName: "list_stale_tasks",
    toolArgs: { daysSinceUpdate: 7, limit: 30 },
    formatReply: (r) => formatStaleList(r?.tasks ?? r?.rows ?? [], r?.total ?? 0),
  }),

  // FIX 2026-05-07: search_projects requires keyword (non-empty). Switch
  // sang report.query SQL để list ALL active projects without keyword filter.
  projects: () => ({
    pattern: "slash:projects",
    toolName: "report.query",
    toolArgs: {
      sql: `SELECT id, name, code, status, priority,
                   start_date, end_date, task_count, member_count
            FROM projects
            WHERE company_id = 1 AND status IN ('PLANNED','IN_PROGRESS','ON_HOLD')
            ORDER BY priority DESC, end_date ASC NULLS LAST LIMIT 20`,
    },
    formatReply: (r) => formatProjectList(r?.rows ?? [], r?.rowCount ?? 0),
  }),

  role: (_args, ctx) => {
    if (!ctx.callerUserId) {
      return { pattern: "slash:role:no_caller", directReply: NO_CALLER_REPLY };
    }
    return {
      pattern: "slash:role",
      toolName: "find_user",
      toolArgs: { id: ctx.callerUserId },
      formatReply: (r) => formatRole(r),
    };
  },

  automations: () => ({
    pattern: "slash:automations",
    toolName: "automation.list",
    toolArgs: { active: true },
    formatReply: (r) => formatAutomations(r?.automations ?? [], r?.total ?? 0),
  }),
};

// Pattern registry — strict regex để tránh false positive
const PATTERNS: Array<{
  name: string;
  re: RegExp;
  build: (m: RegExpMatchArray, ctx: AgentContext) => FastPathResult | null;
}> = [
  // 0. Greeting — avoid falling into DB keyword search for "hello", "hi", ...
  {
    name: "greeting",
    re: /^\s*(hi|hello|hey|ch[aà]o|xin\s+ch[aà]o|alo|h[eê]l+o|good\s+(morning|afternoon|evening))(\s+(b|b[aạ]n|bot|anh|ch[ịi]|em|admin))?\s*[!.,]*\s*$/iu,
    build: () => ({
      pattern: "greeting",
      directReply: GREETING_REPLY,
    }),
  },

  // 1. END_SESSION — user đóng phiên
  // Vietnamese diacritics: 'a' family bao gồm a/á/à/ả/ã/ạ — char class phải đầy đủ.
  {
    name: "end_session",
    re: /^\s*(ok\s*(c[aáàảãạ]m\s*[oơ]n|c[aáàảãạ]m\s*[oơ]n|b[aạ]n)?|c[aáàảãạ]m\s*[oơ]n|thanks?|thank\s*you|tks|hi[eể]u\s*r[oồ]i|r[oõ]|t[aạ]m\s*bi[eệ]t|bye|ch[aà]o\s*nh[eé]|v[aậ]y\s*th[oô]i|đư[ơợ]c\s*r[oồ]i|n[oó]\s*đ[uú]ng|👍|👌|❤️|🙏)\s*[!.,]*\s*$/iu,
    build: () => ({
      pattern: "end_session",
      directReply: "Không có gì 👍 [END_SESSION]",
    }),
  },

  // 2. My open tasks — chỉ work nếu caller resolved
  // Mở rộng (2026-05-07): bắt cả "tôi có task ...", "task hôm nay/chiều nay", v.v.
  // Vietnamese pronouns: tôi/mình/t/anh/em/chị/tớ/tao/cháu/con (negative lookahead
  // loại "anh ấy" = 3rd-person, "anh ơi" = vocative gọi bot).
  // Pattern cover:
  //   - "task của <pronoun>", "<pronoun> có task ...", "task hôm nay"
  //   - "my tasks", "những việc của tôi/mình"
  //   - Filter thời gian: hôm nay / chiều nay / sáng nay / tuần này / sắp tới
  {
    name: "my_tasks",
    re: new RegExp(
      `^\\s*(` +
        `task\\s+(của\\s+)?${SELF_PRONOUN_RE_STR}|` +
        `my\\s+tasks|` +
        `nh[uữ]ng\\s+vi[eệ]c\\s+c[uủ]a\\s+${SELF_PRONOUN_RE_STR}|` +
        `${SELF_PRONOUN_RE_STR}\\s+(có\\s+)?task(\\s+\\S+){0,5}|` +
        `task\\s+(nào\\s+)?(c[uủ]a\\s+${SELF_PRONOUN_RE_STR}\\s+)?(h[oô]m\\s*nay|chi[eề]u\\s*nay|s[aá]ng\\s*nay|t[oô]i\\s*nay|tu[aầ]n\\s*n[aà]y|s[aắ]p\\s*t[oớ]i|s[aắ]p\\s*deadline)(\\s+c[uủ]a\\s+${SELF_PRONOUN_RE_STR})?(\\s+l[aà]\\s+(g[iì]|sao|j)(\\s+v[aậ]y)?)?` +
      `)\\s*[\\?.k]?\\s*$`,
      "iu",
    ),
    build: (_m, ctx) => {
      if (!ctx.callerUserId) {
        return { pattern: "my_tasks:no_caller", directReply: NO_CALLER_REPLY };
      }
      return {
        pattern: "my_tasks",
        toolName: "report.query",
        toolArgs: {
          sql: `SELECT t.id, t.name, t.status, t.priority, t.deadline, p.name AS project FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.company_id = 1 AND t.assignee_id = ${ctx.callerUserId} AND t.status != 'DONE' ORDER BY t.priority DESC, t.deadline ASC LIMIT 20`,
        },
        formatReply: (r) => formatTaskList(r?.rows ?? [], "Task của bạn"),
      };
    },
  },

  // 3. Overdue tasks
  {
    name: "overdue",
    re: /^\s*(c[oó]\s+)?(task|vi[eệ]c)?\s*(n[aà]o\s+)?(đang\s+)?(qu[aá]\s*h[aạ]n|overdue|tr[eễ]\s*deadline|tr[eễ]\s*h[aạ]n)\s*[\?.]?\s*$/iu,
    build: () => ({
      pattern: "overdue",
      toolName: "list_overdue_tasks",
      toolArgs: { days: 0, limit: 50 },
      formatReply: (r) => formatOverdueList(r?.tasks ?? [], r?.total ?? 0),
    }),
  },

  // 4. Daily digest
  {
    name: "daily_digest",
    re: /^\s*(digest|t[oổ]ng\s*h[oợ]p|b[aá]o\s*c[aá]o\s+(s[aá]ng|h[oô]m\s*nay|today)|t[oổ]ng\s*quan(\s+h[oô]m\s*nay)?)\s*[\?.]?\s*$/iu,
    build: () => ({
      pattern: "daily_digest",
      toolName: "generate_daily_digest",
      toolArgs: {},
      formatReply: (r) => formatDigest(r),
    }),
  },

  // 5. Weekly report
  {
    name: "weekly_report",
    re: /^\s*(weekly\s*report|b[aá]o\s*c[aá]o\s*tu[aầ]n|tu[aầ]n\s*qua|tu[aầ]n\s*n[aà]y)\s*[\?.]?\s*$/iu,
    build: () => ({
      pattern: "weekly_report",
      toolName: "generate_weekly_report",
      toolArgs: { days: 7 },
      formatReply: (r) => formatWeekly(r),
    }),
  },

  // 6.1 Task owner lookup — "ai làm task X", "task X ai làm"
  {
    name: "task_owner_lookup",
    re: /^\s*ai\s+(đang\s+)?l[aà]m\s+task\s+(.+?)\s*[\?.]?\s*$|^\s*task\s+(.+?)\s+ai\s+l[aà]m\s*[\?.]?\s*$/iu,
    build: (m) => {
      const query = cleanTaskLookupQuery(m[2] ?? m[3] ?? "");
      if (!query) return null;
      return {
        pattern: "task_owner_lookup",
        toolName: "find_task",
        toolArgs: { name: query },
        formatReply: (r) => formatTaskOwnerLookup(r, query),
      };
    },
  },

  // 6.2 Task deadline lookup — "deadline task X", "task X deadline khi nào"
  {
    name: "task_deadline_lookup",
    re: /^\s*deadline\s+task\s+(.+?)\s*[\?.]?\s*$|^\s*task\s+(.+?)\s+deadline(\s+khi\s+n[aà]o)?\s*[\?.]?\s*$/iu,
    build: (m) => {
      const query = cleanTaskLookupQuery(m[1] ?? m[2] ?? "");
      if (!query) return null;
      return {
        pattern: "task_deadline_lookup",
        toolName: "find_task",
        toolArgs: { name: query },
        formatReply: (r) => formatTaskDeadlineLookup(r, query),
      };
    },
  },

  // 6.3 Task status lookup — "status task X", "task X đang status gì"
  {
    name: "task_status_lookup",
    re: /^\s*status\s+task\s+(.+?)\s*[\?.]?\s*$|^\s*task\s+(.+?)\s+(đang\s+)?(ở\s+)?status\s+(g[iì]|n[aà]o)\s*[\?.]?\s*$/iu,
    build: (m) => {
      const query = cleanTaskLookupQuery(m[1] ?? m[2] ?? "");
      if (!query) return null;
      return {
        pattern: "task_status_lookup",
        toolName: "find_task",
        toolArgs: { name: query },
        formatReply: (r) => formatTaskStatusLookup(r, query),
      };
    },
  },

  // 6.4 Task progress/detail lookup — "task X đang tới đâu", "task X sao rồi"
  {
    name: "task_progress_lookup",
    re: /^\s*task\s+(.+?)\s+(đang\s+)?(tới\s+đâu|đến\s+đâu|sao\s+rồi|thế\s+nào\s+rồi|ở\s+đâu)\s*[\?.]?\s*$/iu,
    build: (m) => {
      const query = cleanTaskLookupQuery(m[1] ?? "");
      if (!query) return null;
      return {
        pattern: "task_progress_lookup",
        toolName: "find_task",
        toolArgs: { name: query },
        formatReply: (r) => formatTaskProgressLookup(r, query),
      };
    },
  },

  // 6.5 Project snapshot — "tình hình dự án X", "project X snapshot"
  {
    name: "project_snapshot_lookup",
    re: /^\s*(t[ìi]nh\s+h[ìi]nh|snapshot|status)\s+(d[uự]\s*[áa]n|project)\s+(.+?)\s*[\?.]?\s*$|^\s*(d[uự]\s*[áa]n|project)\s+(.+?)\s+(đang\s+)?(sao\s+rồi|thế\s+nào|snapshot|status)\s*[\?.]?\s*$/iu,
    build: (m) => {
      const query = cleanTaskLookupQuery(m[3] ?? m[5] ?? "");
      if (!query) return null;
      return {
        pattern: "project_snapshot_lookup",
        toolName: "pm.get_project_snapshot_by_name",
        toolArgs: { name: query },
        formatReply: (r) => formatProjectSnapshotLookup(r, query),
      };
    },
  },

  // 6.6 Project worklog/check-in progress today — "tiến độ hiện tại của MTL"
  {
    name: "project_daily_progress",
    re: /^\s*(ti[eế]n\s*đ[oộ]|update|c[aậ]p\s*nh[aậ]t|t[ìi]nh\s*h[ìi]nh)\s+(h(?:i[eệ]n|ien)\s*t[aạ]i\s+)?(c[uủ]a|cua|cuar)\s+(.+?)(\s+(h[oô]m\s*nay|today))?\s*[\?.]?\s*$/iu,
    build: (m) => {
      if (!m[2]) return null;
      const query = cleanTaskLookupQuery(m[4] ?? "");
      if (!query) return null;
      const projectSql = sqlLiteral(`%${query}%`);
      return {
        pattern: "project_daily_progress",
        toolName: "report.query",
        toolArgs: {
          sql: `WITH target AS (
                  SELECT id, name
                  FROM projects
                  WHERE company_id = 1
                    AND status != 'ARCHIVED'
                    AND (name ILIKE ${projectSql} OR code ILIKE ${projectSql})
                  ORDER BY name
                  LIMIT 1
                )
                SELECT
                  target.id AS project_id,
                  target.name AS project_name,
                  COUNT(DISTINCT b.id) AS checkin_count,
                  COALESCE(SUM(b.hours), 0) AS total_hours,
                  COUNT(DISTINCT tb.id) AS blocker_count,
                  STRING_AGG(DISTINCT CONCAT('- ', u.full_name, ': ', b.description, ' (', b.hours, 'h)'), ', ') AS updates
                FROM target
                LEFT JOIN backlogs b
                  ON b.project_id = target.id
                 AND b.source = 'GAPO_CHECKIN'
                 AND b.work_date::date = CURRENT_DATE
                LEFT JOIN users u
                  ON u.id = b.user_id
                 AND u.company_id = 1
                LEFT JOIN task_blockers tb
                  ON tb.task_id = b.task_id
                 AND tb.resolved_at IS NULL
                GROUP BY target.id, target.name`,
        },
        formatReply: (r) => {
          if (r?.error) return "Mình chưa đọc được worklog của project lúc này, bạn thử lại sau nhé.";
          return formatProjectDailyProgress(r?.rows ?? [], query);
        },
      };
    },
  },

  // 7. List automations
  {
    name: "list_automations",
    re: /^\s*(list\s+automation(s)?|automation(s)?\s+(đang\s+)?(ch[aạ]y|active)|cron(\s+job)?\s+(đang\s+)?(ch[aạ]y|active|đâu|ở\s+đâu|h[oô]m\s*nay|gửi\s+riêng|g[uử]i\s+ri[eê]ng)|h[oô]m\s*nay\s+cron(\s+job)?\s+đâu|l[ịi]ch\s+(cron|automation|gửi\s+riêng|g[uử]i\s+ri[eê]ng))\s*[\?.]?\s*$/iu,
    build: () => ({
      pattern: "list_automations",
      toolName: "automation.list",
      toolArgs: { active: true },
      formatReply: (r) => formatAutomations(r?.automations ?? [], r?.total ?? 0),
    }),
  },

  // 7b. Tasks of a named person — bypass slow ReAct loop for common PM lookup.
  {
    name: "person_tasks",
    re: /^\s*(task|vi[eệ]c)\s+c[uủ]a\s+(.+?)(\s+l[aà]\s+g[iì])?\s*[\?.]?\s*$|^\s*(.+?)\s+c[oó]\s+(task|vi[eệ]c)\s+g[iì]\s*[\?.]?\s*$/iu,
    build: (m, ctx) => {
      const targetName = cleanTaskLookupQuery(m[2] ?? m[4] ?? "");
      if (!targetName) return null;
      if (!ctx.callerUserId) return { pattern: "person_tasks:no_caller", directReply: NO_CALLER_REPLY };
      return {
        pattern: "person_tasks",
        toolName: "person_tasks",
        toolArgs: { targetName, callerUserId: ctx.callerUserId },
        formatReply: (r) => formatPersonTasks(r, targetName),
      };
    },
  },

  // 7c. Daily progress of a named person — "tiến độ công việc của Trường hôm nay"
  {
    name: "person_daily_progress",
    re: /^\s*(ti[eế]n\s*đ[oộ]|update|c[aậ]p\s*nh[aậ]t|t[ìi]nh\s*h[ìi]nh)\s+(c[oô]ng\s*vi[eệ]c|worklog|task|vi[eệ]c)?\s*(c[uủ]a\s+)?(.+?)(\s+(h[oô]m\s*nay|today))?\s*(th[eế]\s*n[aà]o|ra\s+sao|sao\s+r[oồ]i|ch[uư]a)?\s*[\?.]?\s*$/iu,
    build: (m) => {
      const targetName = cleanTaskLookupQuery(m[4] ?? "");
      if (!targetName) return null;
      const nameSql = sqlLiteral(`%${targetName}%`);
      return {
        pattern: "person_daily_progress",
        toolName: "report.query",
        toolArgs: {
          sql: `WITH target AS (
                  SELECT id, full_name
                  FROM users
                  WHERE company_id = 1
                    AND active = true
                    AND full_name ILIKE ${nameSql}
                  ORDER BY full_name
                  LIMIT 1
                )
                SELECT
                  target.id,
                  target.full_name,
                  COUNT(DISTINCT b.id) AS checkin_count,
                  COALESCE(SUM(b.hours), 0) AS total_hours,
                  STRING_AGG(DISTINCT CONCAT('- ', b.description, ' (', b.hours, 'h)'), ', ') AS updates,
                  COUNT(DISTINCT t.id) FILTER (WHERE t.status != 'DONE') AS open_tasks
                FROM target
                LEFT JOIN backlogs b
                  ON b.user_id = target.id
                 AND b.source = 'GAPO_CHECKIN'
                 AND b.work_date::date = CURRENT_DATE
                LEFT JOIN tasks t
                  ON t.assignee_id = target.id
                 AND t.company_id = 1
                GROUP BY target.id, target.full_name`,
        },
        formatReply: (r) => {
          if (r?.error) return "Mình chưa đọc được dữ liệu tiến độ lúc này, bạn thử lại sau nhé.";
          return formatPersonDailyProgress(r?.rows ?? [], targetName);
        },
      };
    },
  },

  // 8. My role / permissions — pure direct reply từ ctx (không cần tool)
  // Match: "tôi có quyền gì", "role của tôi", "tôi là ai", "tôi có vai trò gì",
  //        "mình có quyền gì trong hệ thống này"
  {
    name: "my_role",
    // Mở rộng pronouns: tôi/mình/t/anh/em/chị/tớ/tao/cháu/con
    // Patterns:
    //   "<pronoun> có quyền gì [trong hệ thống này]?"
    //   "role/quyền/vai trò của <pronoun> [là gì]?"
    //   "<pronoun> là ai" / "who am i"
    re: new RegExp(
      `^\\s*${SELF_PRONOUN_RE_STR}\\s+(có\\s+)?(quy[eề]n|vai\\s*trò|role)\\s*(g[iì]|n[aà]o)?(\\s+(trong\\s+(h[eệ]\\s*th[oố]ng|n[aà]y|n[oớ]i\\s*đ[aâ]y)(\\s+n[aà]y)?|n[aà]y|n[oớ]i\\s*đ[aâ]y))?\\s*[\\?.]?\\s*$` +
        `|^\\s*(role|quy[eề]n|vai\\s*trò)\\s+c[uủ]a\\s+${SELF_PRONOUN_RE_STR}\\s*(l[aà]\\s*g[iì])?\\s*[\\?.]?\\s*$` +
        `|^\\s*${SELF_PRONOUN_RE_STR}\\s+l[aà]\\s+ai\\s*[\\?.]?\\s*$` +
        `|^\\s*who\\s+am\\s+i\\s*[\\?.]?\\s*$`,
      "iu",
    ),
    build: (_m, ctx) => {
      // Cần callerUserId resolved trước (do resolveCallerBlock đã chạy)
      if (!ctx.callerUserId) {
        return { pattern: "my_role:no_caller", directReply: NO_CALLER_REPLY };
      }
      return {
        pattern: "my_role",
        toolName: "find_user",
        toolArgs: { id: ctx.callerUserId },
        formatReply: (r) => formatRole(r),
      };
    },
  },

  // 9. List projects — "có project nào", "list project", "dự án đang chạy"
  // FIX 2026-05-07: search_projects requires keyword. Switch sang report.query.
  {
    name: "list_projects",
    re: /^\s*(c[oó]\s+)?(d[uự]\s*[áa]n|project)\s*(n[aà]o)?\s*(đang\s+)?(active|ho[aạ]t\s*đ[oộ]ng|ch[aạ]y|m[oở])?\s*[\?.]?\s*$|^\s*list\s+project(s)?\s*[\?.]?\s*$/iu,
    build: () => ({
      pattern: "list_projects",
      toolName: "report.query",
      toolArgs: {
        sql: `SELECT id, name, code, status, priority,
                     start_date, end_date, task_count, member_count
              FROM projects
              WHERE company_id = 1 AND status IN ('PLANNED','IN_PROGRESS','ON_HOLD')
              ORDER BY priority DESC, end_date ASC NULLS LAST LIMIT 20`,
      },
      formatReply: (r) => formatProjectList(r?.rows ?? [], r?.rowCount ?? 0),
    }),
  },

  // 10. Blocked tasks — "task nào bị block", "blocker", "task đang block"
  // FIX 2026-05-07: TaskStatus enum không có BLOCKED. Concept blocked = task
  // có row trong task_blockers. Switch sang report.query SQL JOIN.
  {
    name: "blocked_tasks",
    re: /^\s*(c[oó]\s+)?(task|vi[eệ]c)\s*(n[aà]o\s+)?(đang\s+)?(b[ịi]\s+)?block(ed|er)?\s*[\?.]?\s*$|^\s*blocker(s)?\s*(hi[eệ]n\s*t[aạ]i)?\s*[\?.]?\s*$/iu,
    build: () => ({
      pattern: "blocked_tasks",
      toolName: "report.query",
      toolArgs: {
        sql: `SELECT t.id, t.name, t.status, t.priority, p.name AS project,
                     COUNT(b.id) AS blocker_count, MAX(b.severity) AS max_severity
              FROM tasks t
              JOIN projects p ON p.id = t.project_id
              JOIN task_blockers b ON b.task_id = t.id
              WHERE p.company_id = 1 AND t.status != 'DONE'
              GROUP BY t.id, t.name, t.status, t.priority, p.name
              ORDER BY blocker_count DESC, t.priority DESC LIMIT 30`,
      },
      formatReply: (r) => formatBlockedList(r?.rows ?? [], r?.rowCount ?? 0),
    }),
  },

  // 11. Stale tasks — "task lâu chưa update", "task stale"
  {
    name: "stale_tasks",
    re: /^\s*(c[oó]\s+)?(task|vi[eệ]c)\s*(n[aà]o\s+)?(đang\s+|b[ịi]\s+)?(stale|l[aâ]u\s*(ch[uư]a)?\s*(c[aậ]p\s*nh[aậ]t|update))\s*[\?.]?\s*$/iu,
    build: () => ({
      pattern: "stale_tasks",
      toolName: "list_stale_tasks",
      toolArgs: { daysSinceUpdate: 7, limit: 30 },
      formatReply: (r) => formatStaleList(r?.tasks ?? r?.rows ?? [], r?.total ?? 0),
    }),
  },
];

function buildIntentFastPath(intent: IntentName, ctx: AgentContext): FastPathResult | null {
  switch (intent) {
    case "my_tasks_today":
      if (!ctx.callerUserId) {
        return { pattern: "intent:my_tasks_today:no_caller", directReply: NO_CALLER_REPLY };
      }
      return {
        pattern: "intent:my_tasks_today",
        toolName: "pm.get_my_tasks_today",
        toolArgs: { userId: ctx.callerUserId },
        formatReply: (r) => formatTaskList(r?.tasks ?? r?.rows ?? [], "Task của bạn hôm nay"),
      };

    case "my_tasks_week":
      if (!ctx.callerUserId) {
        return { pattern: "intent:my_tasks_week:no_caller", directReply: NO_CALLER_REPLY };
      }
      return {
        pattern: "intent:my_tasks_week",
        toolName: "pm.get_deadlines_this_week",
        toolArgs: { userId: ctx.callerUserId },
        formatReply: (r) => formatTaskList(r?.tasks ?? r?.rows ?? [], "Deadline của bạn tuần này"),
      };

    case "my_projects":
      if (!ctx.callerUserId) {
        return { pattern: "intent:my_projects:no_caller", directReply: NO_CALLER_REPLY };
      }
      return {
        pattern: "intent:my_projects",
        toolName: "pm.get_my_projects",
        toolArgs: { userId: ctx.callerUserId },
        formatReply: (r) => formatProjectList(r?.projects ?? r?.rows ?? [], r?.total ?? r?.rowCount),
      };

    case "overdue_tasks":
      return {
        pattern: "intent:overdue_tasks",
        toolName: "pm.get_overdue_tasks",
        toolArgs: { days: 0, limit: 50 },
        formatReply: (r) => formatOverdueList(r?.tasks ?? [], r?.total ?? 0),
      };

    case "blocked_tasks":
      return {
        pattern: "intent:blocked_tasks",
        toolName: "pm.get_blocked_tasks",
        toolArgs: { limit: 30 },
        formatReply: (r) => formatBlockedList(r?.tasks ?? r?.rows ?? [], r?.total ?? r?.rowCount),
      };

    case "stale_tasks":
      return {
        pattern: "intent:stale_tasks",
        toolName: "list_stale_tasks",
        toolArgs: { daysSinceUpdate: 7, limit: 30 },
        formatReply: (r) => formatStaleList(r?.tasks ?? r?.rows ?? [], r?.total ?? 0),
      };

    case "daily_digest":
      return {
        pattern: "intent:daily_digest",
        toolName: "generate_daily_digest",
        toolArgs: {},
        formatReply: (r) => formatDigest(r),
      };

    case "weekly_report":
      return {
        pattern: "intent:weekly_report",
        toolName: "generate_weekly_report",
        toolArgs: { days: 7 },
        formatReply: (r) => formatWeekly(r),
      };

    case "my_role":
      if (!ctx.callerUserId) {
        return { pattern: "intent:my_role:no_caller", directReply: NO_CALLER_REPLY };
      }
      return {
        pattern: "intent:my_role",
        toolName: "find_user",
        toolArgs: { id: ctx.callerUserId },
        formatReply: (r) => formatRole(r),
      };

    default:
      return null;
  }
}

/**
 * Try fast-path match. Returns null nếu không match → caller fall back full LLM.
 * Strip [GAPO_USER: xxx] prefix trước match.
 *
 * Order:
 *   1. Slash command "/cmd args" → SLASH_COMMANDS lookup
 *   2. Vietnamese regex patterns (END_SESSION, my_tasks, overdue, ...)
 */
export function tryFastPath(text: string, ctx: AgentContext): FastPathResult | null {
  if (FAST_PATH_DISABLED) return null;
  const rawCleaned = currentTurnText(text);
  const cleaned = normalizeFastPathText(rawCleaned);
  if (!cleaned) return null;

  // Slash command path. Gapo's command menu inserts bare text ("stale")
  // instead of slash text ("/stale"), so accept exact bare command names too.
  const slashMatch = rawCleaned.match(SLASH_RE);
  const bareMenuCmd = /^[a-z][a-z0-9_-]*$/i.test(rawCleaned) ? rawCleaned.toLowerCase() : null;
  if (slashMatch || (bareMenuCmd && SLASH_COMMANDS[bareMenuCmd])) {
    const cmd = slashMatch ? slashMatch[1].toLowerCase() : bareMenuCmd!;
    const args = slashMatch ? (slashMatch[2] ?? "").trim() : "";
    const handler = SLASH_COMMANDS[cmd];
    if (handler) {
      const result = handler(args, ctx);
      if (result) return result;
    }
    // Unknown slash → not a fast-path; fall through to natural patterns.
    // Avoid silent confusion when user types "/foo" by NOT short-circuiting.
  }

  if (!isActionLikeTurn(cleaned)) {
    const detected = detectIntentWithScore(cleaned);
    if (detected.confidence >= 0.8) {
      const routed = buildIntentFastPath(detected.intent, ctx);
      if (routed) return routed;
    }
  }

  for (const p of PATTERNS) {
    const m = rawCleaned.match(p.re);
    if (m) {
      const result = p.build(m, ctx);
      if (result) return result;
    }
  }

  // Safety net (2026-05-07): user hỏi về SELF (task/role/quyền + self-pronoun)
  // NHƯNG không match pattern cụ thể nào AND caller chưa resolve → trả friendly
  // error ngay. Tránh fall through LLM với caller=null → Qwen retry tools rỗng
  // → 5min hard timeout.
  // Pronouns full list: tôi/mình/t/anh/em/chị/tớ/tao/cháu/con + "my"
  // Negative lookahead loại 3rd-person/vocative ("anh ấy", "em đó", "anh ơi").
  if (!ctx.callerUserId) {
    const selfRefRe = new RegExp(
      `\\b${SELF_PRONOUN_RE_STR}.{0,30}(task|vi[eệ]c|quy[eề]n|role|vai\\s*tr[oò]|d[uự]\\s*[aá]n|project|deadline)|\\bmy\\b\\s+(task|role|project)`,
      "iu",
    );
    if (selfRefRe.test(rawCleaned)) {
      return { pattern: "self_question:no_caller", directReply: NO_CALLER_REPLY };
    }
  }
  if (INTENT_MISS_LOG_ENABLED) {
    console.log("[intent-miss]", {
      text: cleaned,
      callerUserId: ctx.callerUserId ?? null,
      correlationId: ctx.correlationId,
    });
  }
  return null;
}


export { executeFastPath, _resetFastPathCircuit } from "./executor";
