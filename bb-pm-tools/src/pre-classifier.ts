// Sprint 8 Day 3 — Pre-classifier fast path.
// Bypass full ReAct LLM loop cho common queries pattern-match được.
// Save 50s+/turn cho ~25-40% queries (END_SESSION, "task của tôi", etc).
//
// Wire ở đầu runAgent: if tryFastPath() returns non-null → execute trực tiếp,
// skip LLM entirely. Fall through nếu pattern không match.

import type { AgentContext } from "./types";
import { toolsByName } from "./tools";

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

// F1 fix (2026-05-07): khi pattern cần callerUserId nhưng resolve fail
// (Gapo cid không trong bb-pm channel_identity), trả friendly error THAY VÌ
// silent return null. Lý do: return null → fall through full LLM → Qwen
// xử lý 60-180s rồi trả câu mơ hồ. Friendly error fix UX + free up slot.
const NO_CALLER_REPLY =
  "Mình chưa nhận diện được bạn trong hệ thống PM. Có thể bạn chưa được map vào DB. " +
  "Liên hệ admin để được add user, hoặc gõ từ tài khoản đã có sẵn.";

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

const SLASH_HELP_TEXT = `Slash commands (gõ "/<cmd>" để chạy ngay, không qua LLM):

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

const SLASH_COMMANDS: Record<string, (args: string, ctx: AgentContext) => FastPathResult | null> = {
  help: () => ({ pattern: "slash:help", directReply: SLASH_HELP_TEXT }),

  digest: () => ({
    pattern: "slash:digest",
    toolName: "generate_daily_digest",
    toolArgs: {},
    formatReply: (r) => formatDigest(r),
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
        `task\\s+(nào\\s+)?(c[uủ]a\\s+${SELF_PRONOUN_RE_STR}\\s+)?(h[oô]m\\s*nay|chi[eề]u\\s*nay|s[aá]ng\\s*nay|t[oô]i\\s*nay|tu[aầ]n\\s*n[aà]y|s[aắ]p\\s*t[oớ]i|s[aắ]p\\s*deadline)(\\s+c[uủ]a\\s+${SELF_PRONOUN_RE_STR})?(\\s+l[aà]\\s+(g[iì]|sao|j))?` +
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

  // 6. List automations
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

  // 7. My role / permissions — pure direct reply từ ctx (không cần tool)
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

  // 8. List projects — "có project nào", "list project", "dự án đang chạy"
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

  // 9. Blocked tasks — "task nào bị block", "blocker", "task đang block"
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

  // 10. Stale tasks — "task lâu chưa update", "task stale"
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
  const cleaned = text.replace(/\[GAPO_USER:\s*[^\]]+\]/i, "").trim();
  if (!cleaned) return null;

  // Slash command path
  const slashMatch = cleaned.match(SLASH_RE);
  if (slashMatch) {
    const cmd = slashMatch[1].toLowerCase();
    const args = (slashMatch[2] ?? "").trim();
    const handler = SLASH_COMMANDS[cmd];
    if (handler) {
      const result = handler(args, ctx);
      if (result) return result;
    }
    // Unknown slash → not a fast-path; fall through to natural patterns.
    // Avoid silent confusion when user types "/foo" by NOT short-circuiting.
  }

  for (const p of PATTERNS) {
    const m = cleaned.match(p.re);
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
    if (selfRefRe.test(cleaned)) {
      return { pattern: "self_question:no_caller", directReply: NO_CALLER_REPLY };
    }
  }
  return null;
}

// ── Format helpers ────────────────────────────────────────────────────────

function formatTaskList(rows: any[], title: string): string {
  if (!rows?.length) return `${title}: không có ✅`;
  const lines = [`**${title}** (${rows.length}):`];
  for (const t of rows.slice(0, 10)) {
    const proj = t.project ?? t.project_name ?? "?";
    const deadline = t.deadline ? ` — hạn ${String(t.deadline).slice(0, 10)}` : "";
    const priority = t.priority && t.priority !== "MEDIUM" ? ` [${t.priority}]` : "";
    lines.push(`• ${t.name} (${proj})${priority}${deadline} — ${t.status}`);
  }
  if (rows.length > 10) lines.push(`_... và ${rows.length - 10} task khác_`);
  return lines.join("\n");
}

function formatOverdueList(tasks: any[], total: number): string {
  if (!tasks?.length) return "Không có task quá hạn ✅";
  const lines = [`**${total} task quá hạn**:`];
  // Group by project
  const byProj = new Map<string, any[]>();
  for (const t of tasks) {
    const p = t.project ?? "(không xác định)";
    if (!byProj.has(p)) byProj.set(p, []);
    byProj.get(p)!.push(t);
  }
  for (const [proj, list] of byProj) {
    lines.push(`\n**${proj}:**`);
    for (const t of list.slice(0, 5)) {
      const days = t.daysOverdue != null ? ` — trễ ${t.daysOverdue} ngày` : "";
      const assignee = t.assignee ? ` (${t.assignee})` : " (chưa gán)";
      lines.push(`• ${t.name}${days}${assignee}`);
    }
    if (list.length > 5) lines.push(`  _+${list.length - 5} task nữa_`);
  }
  return lines.join("\n");
}

function formatDigest(d: any): string {
  if (!d) return "Không có data digest.";
  const t = d.totals ?? {};
  const lines = [
    `📊 **Digest hôm nay (${new Date().toLocaleDateString("vi-VN")})**`,
    "",
    `• Dự án active: **${t.activeProjects ?? "?"}**`,
    `• Task mở: **${t.openTasks ?? "?"}** | Quá hạn: **${t.overdueTasks ?? "?"}** | Stale: **${t.staleTasks ?? "?"}** | Chưa gán: **${t.unassignedTasks ?? "?"}**`,
  ];
  const projects = (d.projects ?? []).slice(0, 5);
  if (projects.length) {
    lines.push("", "**Dự án:**");
    for (const p of projects) {
      const pct = p.completionPct != null ? ` (${Math.round(p.completionPct)}%)` : "";
      lines.push(`• ${p.name}: ${p.doneTaskCount}/${p.taskCount}${pct}`);
    }
  }
  return lines.join("\n");
}

function formatWeekly(r: any): string {
  if (!r) return "Không có data weekly report.";
  const t = r.totals ?? {};
  const w = r.window ?? {};
  return [
    `📆 **Báo cáo tuần (${(w.start ?? "").slice(0, 10)} → ${(w.end ?? "").slice(0, 10)})**`,
    "",
    `• Task hoàn thành: **${t.tasksDone ?? 0}** | Task mới: ${t.newTasks ?? 0} | Blocker mới: ${t.newBlockers ?? 0}`,
    `• Hours approved: **${(t.hoursApproved ?? 0).toFixed?.(1) ?? "?"}h** | Cost: ${t.costApproved ?? "?"}`,
  ].join("\n");
}

function formatAutomations(list: any[], total: number): string {
  if (!list?.length) return "Không có automation nào đang chạy.";
  const lines = [`**${total} automation đang chạy**:`];
  for (const a of list) {
    const lr = a.lastRunStatus
      ? ` | last: ${a.lastRunStatus}${a.lastRunAt ? " " + String(a.lastRunAt).slice(0, 16).replace("T", " ") : ""}`
      : "";
    const target = a.target ? ` | target: ${a.target}` : "";
    const fails = a.consecutiveFails ? ` | fails: ${a.consecutiveFails}` : "";
    const err = a.lastRunError ? ` | lỗi: ${String(a.lastRunError).slice(0, 140)}` : "";
    lines.push(`• #${a.id} **${a.name}** — \`${a.schedule}\` → ${a.workflow}${target}${lr}${fails}${err}`);
  }
  return lines.join("\n");
}

// Pattern 7: my_role
function formatRole(user: any): string {
  if (!user) return "Mình chưa nhận diện được bạn trong hệ thống.";
  const role = user.role ?? "MEMBER";
  // Capabilities theo role — concise inline format (đúng style mới).
  const caps: Record<string, string> = {
    ADMIN: "cấu hình project · duyệt task · quản lý user · xem audit",
    MANAGER: "duyệt task · phân công · quản lý project mình sở hữu",
    MEMBER: "cập nhật task của mình · báo blocker · đọc digest",
    VIEWER: "xem dashboard · đọc digest (read-only)",
  };
  const cap = caps[role] ?? caps.MEMBER;
  return `${role}. ${cap}.`;
}

// Pattern 8: list_projects
function formatProjectList(rows: any[], total?: number): string {
  if (!rows?.length) return "Không có dự án nào đang hoạt động.";
  const t = total ?? rows.length;
  const lines = [`**${t} dự án active**:`];
  for (const p of rows.slice(0, 15)) {
    const status = p.status && p.status !== "ACTIVE" ? ` [${p.status}]` : "";
    const owner = p.owner ?? p.ownerName ?? p.owner_name;
    const ownerStr = owner ? ` · @${owner}` : "";
    const deadline = p.endDate || p.end_date;
    const dl = deadline ? ` · hạn ${String(deadline).slice(0, 10)}` : "";
    lines.push(`• #${p.id ?? "?"} ${p.name ?? "(không tên)"}${status}${ownerStr}${dl}`);
  }
  if (rows.length > 15) lines.push(`_... và ${rows.length - 15} dự án khác_`);
  return lines.join("\n");
}

// Pattern 9: blocked_tasks
function formatBlockedList(tasks: any[], total?: number): string {
  if (!tasks?.length) return "Không có task nào bị block ✅";
  const t = total ?? tasks.length;
  const lines = [`**${t} task đang block**:`];
  for (const task of tasks.slice(0, 15)) {
    const sev = task.severity ? ` [${task.severity}]` : "";
    const proj = task.project ?? task.projectName ?? task.project_name;
    const projStr = proj ? ` (${proj})` : "";
    const reason = task.reason ?? task.blockerReason ?? task.blocker_reason;
    const reasonStr = reason ? ` — ${String(reason).slice(0, 60)}` : "";
    lines.push(`• ${task.name ?? "?"}${projStr}${sev}${reasonStr}`);
  }
  if (tasks.length > 15) lines.push(`_... và ${tasks.length - 15} task khác_`);
  return lines.join("\n");
}

// Pattern 10: stale_tasks
function formatStaleList(tasks: any[], total?: number): string {
  if (!tasks?.length) return "Không có task nào stale ✅";
  const t = total ?? tasks.length;
  const lines = [`**${t} task lâu chưa update**:`];
  for (const task of tasks.slice(0, 15)) {
    const days = task.daysSinceUpdate ?? task.days_since_update;
    const daysStr = days != null ? ` — ${days}d không update` : "";
    const proj = task.project ?? task.projectName ?? task.project_name;
    const projStr = proj ? ` (${proj})` : "";
    const assignee = task.assignee ?? task.assigneeName;
    const aStr = assignee ? ` · @${assignee}` : "";
    lines.push(`• ${task.name ?? "?"}${projStr}${aStr}${daysStr}`);
  }
  if (tasks.length > 15) lines.push(`_... và ${tasks.length - 15} task khác_`);
  return lines.join("\n");
}

// ── Fast path executor ────────────────────────────────────────────────────
/**
 * Execute fast path result. Returns string reply hoặc throws nếu tool fail.
 */
// F3 fix (2026-05-07) — Circuit breaker per pattern.
// Nếu 1 pattern fail ≥ 3 lần trong 60s → disable 5 phút → fall through LLM.
// Tránh case backend bug làm fast-path liên tục throw → cascade log spam.
// Reset window 60s rolling.
const CB_FAIL_THRESHOLD = Number(process.env.FASTPATH_CB_THRESHOLD ?? 3);
const CB_WINDOW_MS = Number(process.env.FASTPATH_CB_WINDOW_MS ?? 60_000);
const CB_DISABLE_MS = Number(process.env.FASTPATH_CB_DISABLE_MS ?? 5 * 60_000);
const cbFails = new Map<string, number[]>(); // pattern → array of fail timestamps
const cbDisabled = new Map<string, number>(); // pattern → disable-until timestamp

function isCircuitOpen(pattern: string): boolean {
  const until = cbDisabled.get(pattern);
  if (!until) return false;
  if (Date.now() > until) {
    cbDisabled.delete(pattern);
    cbFails.delete(pattern);
    return false;
  }
  return true;
}

function recordFail(pattern: string): void {
  const now = Date.now();
  const arr = (cbFails.get(pattern) ?? []).filter((t) => now - t < CB_WINDOW_MS);
  arr.push(now);
  cbFails.set(pattern, arr);
  if (arr.length >= CB_FAIL_THRESHOLD) {
    cbDisabled.set(pattern, now + CB_DISABLE_MS);
    console.warn(
      `[fast-path] CIRCUIT OPEN pattern=${pattern} fails=${arr.length}/${CB_WINDOW_MS / 1000}s — disable ${CB_DISABLE_MS / 1000}s`,
    );
  }
}

export async function executeFastPath(
  fp: FastPathResult,
  ctx: AgentContext,
): Promise<string> {
  // Direct reply (cheapest path — no tool, no DB, no logging needed)
  if (fp.directReply !== undefined) return fp.directReply;

  if (!fp.toolName) throw new Error("FastPath missing toolName + directReply");

  // Circuit breaker check — nếu pattern đang disabled, throw để fall through LLM
  if (isCircuitOpen(fp.pattern)) {
    throw new Error(`fast-path circuit open: ${fp.pattern}`);
  }

  const tool = toolsByName.get(fp.toolName);
  if (!tool) throw new Error(`FastPath backing tool ${fp.toolName} not found`);

  const t0 = Date.now();
  let result: any;
  try {
    result = await tool.handler(fp.toolArgs ?? {});
  } catch (err: any) {
    const dur = Date.now() - t0;
    recordFail(fp.pattern);
    console.warn(
      `[fast-path] FAIL pattern=${fp.pattern} tool=${fp.toolName} dur=${dur}ms err="${(err?.message ?? err).slice(0, 120)}"`,
    );
    throw err;
  }

  // Success log — include row count khi available (giúp distinguish "no data"
  // vs "data missing" debug). "No data" KHÔNG count fail (case bình thường).
  const dur = Date.now() - t0;
  const rowCount = result?.rows?.length ?? result?.tasks?.length ?? result?.projects?.length ?? null;
  console.log(
    `[fast-path] OK pattern=${fp.pattern} tool=${fp.toolName} dur=${dur}ms rows=${rowCount ?? "?"}`,
  );

  if (!fp.formatReply) {
    return JSON.stringify(result).slice(0, 1000);
  }
  return fp.formatReply(result, ctx);
}

/** Test/debug helper — clear circuit breaker state (used by tests). */
export function _resetFastPathCircuit(): void {
  cbFails.clear();
  cbDisabled.clear();
}
