import { bbPm } from "../infrastructure/api-client";
import type { ToolDefinition } from "../tools/catalog";
import { toolsByName } from "../tools/catalog";

export const reportQueryTool: ToolDefinition<any, any> = {
    name: "report.query",
    description:
      "[READ/v2] Query DB. CHỈ tool này được dùng cho mọi câu hỏi info / số liệu " +
      "/ báo cáo trong READ mode.\n\n" +
      "INPUT 2 cách:\n" +
      "(A) Raw SQL: truyền `sql` = SELECT statement. Schema column là snake_case " +
      "(project_id, assignee_id, deadline, updated_at, company_id, etc). Bảng " +
      "chính: projects, tasks, users, customers, task_blockers, agent_memory, " +
      "agent_follow_ups, agent_audit_log, milestones. PHẢI có WHERE company_id filter " +
      "(server reject nếu thiếu). Server tự inject LIMIT 200, statement_timeout 5s.\n" +
      "(B) Natural-language: truyền `question` (+ optional `entity`/`filters`) — " +
      "tool router sẽ dispatch sang query backend phù hợp. Dùng (B) cho câu " +
      "đơn giản; dùng (A) cho query phức tạp (JOIN, GROUP BY, custom filter).",
    parameters: {
      type: "object",
      properties: {
        sql: { type: "string", description: "Raw SELECT SQL (option A — preferred khi câu hỏi phức tạp)." },
        question: { type: "string", description: "Câu hỏi natural-language (option B — fallback)." },
        entity: {
          type: "string",
          enum: ["tasks", "projects", "users", "follow_ups", "memory", "digest", "weekly_report", "hygiene"],
          description: "Hint loại data — chỉ áp dụng option B.",
        },
        filters: {
          type: "object",
          description: "Optional structured filter cho option B — vd { projectId, assigneeId, status, daysBack, daysSinceUpdate, days, keyword, limit }.",
        },
      },
      required: [],
    },
    handler: async (args: { sql?: string; question?: string; entity?: string; filters?: any; _callerUserId?: number }) => {
      // Option A: raw SQL via backend
      if (args.sql) {
        try {
          const res = await bbPm.reportQueryRaw(args.sql);
          return res.data;
        } catch (err: any) {
          return { error: String(err?.message ?? err).slice(0, 600) };
        }
      }

      // Option B (Phase 1.2): NL → SQL via inner LLM. Try first, fall back
      // sang keyword router nếu translator fail.
      if (args.question && process.env.BB_PM_NL_TO_SQL !== "0") {
        try {
          const { translateQuestionToSql, repairQuestionSql } = await import("./nl-to-sql/translator");
          const schemaRes = await bbPm.fetchSchemaDoc();
          // Caller scope từ ai gọi tool — Phase 1.2 MVP dùng companyId=1 placeholder
          // (eval/cli context). Production: orchestrator inject caller into ctx.
          const callerCompanyId = Number(process.env.BB_PM_CALLER_COMPANY_ID || 1);
          let t = await translateQuestionToSql(
            args.question,
            schemaRes.data.schema,
            callerCompanyId,
            args._callerUserId,
          );
          try {
            const res = await bbPm.reportQueryRaw(t.sql);
            console.log("[bb-pm-tools] nl-to-sql", JSON.stringify({
              retrievalSource: t.metadata?.retrievalSource,
              retrievedContextIds: t.metadata?.retrievedContextIds,
              tablesUsed: t.metadata?.tablesUsed,
              validationErrors: t.metadata?.validationErrors,
              repairCount: t.metadata?.repairCount ?? 0,
              timingsMs: t.metadata?.timingsMs,
              outcome: "ok",
            }));
            return { ...res.data, _translated: true, _explanation: t.explanation, _translation: t.metadata };
          } catch (firstErr: any) {
            t = await repairQuestionSql(
              args.question,
              t.sql,
              String(firstErr?.message ?? firstErr).slice(0, 400),
              schemaRes.data.schema,
              callerCompanyId,
              args._callerUserId,
              t,
            );
            const res = await bbPm.reportQueryRaw(t.sql);
            console.log("[bb-pm-tools] nl-to-sql", JSON.stringify({
              retrievalSource: t.metadata?.retrievalSource,
              retrievedContextIds: t.metadata?.retrievedContextIds,
              tablesUsed: t.metadata?.tablesUsed,
              validationErrors: t.metadata?.validationErrors,
              repairCount: t.metadata?.repairCount ?? 1,
              outcome: "repaired",
            }));
            return { ...res.data, _translated: true, _explanation: t.explanation, _translation: t.metadata };
          }
        } catch (err: any) {
          // Translator hoặc SQL run fail — fall through tới keyword router
          console.warn("[bb-pm-tools] NL→SQL failed, fallback router:", String(err?.message ?? err).slice(0, 200));
        }
      }

      // Option C: keyword router fallback (Phase 5 light — sẽ retire)
      const q = (args.question ?? "").toLowerCase();
      const f = args.filters ?? {};
      const hint = args.entity;

      const route = (toolName: string, toolArgs: any) => {
        const t = toolsByName.get(toolName);
        if (!t) return { error: `Backing tool ${toolName} unavailable` };
        return t.handler(toolArgs);
      };

      // Explicit entity hint takes priority
      if (hint === "digest") return route("generate_daily_digest", {});
      if (hint === "weekly_report") return route("generate_weekly_report", { days: f.days ?? 7, projectId: f.projectId });
      if (hint === "hygiene") return route("check_data_hygiene", { projectId: f.projectId, staleDays: f.staleDays });
      if (hint === "memory") return route("recall_memory", { q: f.keyword ?? args.question, projectId: f.projectId, taskId: f.taskId, daysBack: f.daysBack, limit: f.limit });
      if (hint === "follow_ups") return route("list_pending_follow_ups", { userId: f.userId, taskId: f.taskId, daysBack: f.daysBack ?? 14, limit: f.limit ?? 50 });
      if (hint === "users") return route("list_users_with_workload", { department: f.department, role: f.role, limit: f.limit });
      if (hint === "projects") return route("search_projects", { keyword: f.keyword ?? args.question ?? "", limit: f.limit ?? 50 });
      if (hint === "tasks") {
        if (f.status === "BLOCKED") return route("list_blocked_tasks", { projectId: f.projectId, limit: f.limit });
        if (f.daysSinceUpdate || /lâu|stale|chưa update/.test(q)) return route("list_stale_tasks", { projectId: f.projectId, daysSinceUpdate: f.daysSinceUpdate ?? 7, limit: f.limit });
        if (f.overdue || /quá hạn|overdue|trễ/.test(q)) return route("list_overdue_tasks", { projectId: f.projectId, days: f.days ?? 0, limit: f.limit });
        return route("search_tasks", { keyword: f.keyword ?? args.question ?? "", limit: f.limit ?? 50 });
      }

      // Keyword routing (no entity hint)
      if (/quá hạn|overdue|trễ deadline|trễ hạn/.test(q)) return route("list_overdue_tasks", { projectId: f.projectId, days: f.days ?? 0, limit: f.limit ?? 50 });
      if (/lâu chưa update|stale|bỏ quên/.test(q)) return route("list_stale_tasks", { projectId: f.projectId, daysSinceUpdate: f.daysSinceUpdate ?? 7, limit: f.limit ?? 50 });
      if (/thiếu owner|thiếu deadline|hygiene|missing/.test(q)) return route("check_data_hygiene", { projectId: f.projectId, staleDays: f.staleDays ?? 14 });
      if (/digest|tổng hợp|báo cáo (sáng|hôm nay|today)|tổng quan/.test(q)) return route("generate_daily_digest", {});
      if (/weekly|báo cáo tuần|tuần qua|tuần này/.test(q)) return route("generate_weekly_report", { days: f.days ?? 7, projectId: f.projectId });
      if (/blocked|đang bị block|kẹt/.test(q) && f.projectId) return route("list_blocked_tasks", { projectId: f.projectId, limit: f.limit ?? 50 });
      if (/workload|rảnh|bận|ai đang|ai có/.test(q)) return route("list_users_with_workload", { department: f.department, role: f.role, limit: f.limit ?? 30 });
      if (/follow.?up|chưa reply|chưa trả lời|chưa phản hồi/.test(q)) return route("list_pending_follow_ups", { daysBack: f.daysBack ?? 14, limit: f.limit ?? 50 });
      if (/lần trước|hôm qua|trước đó|nhớ|memory|kế thừa|tiếp tục/.test(q)) return route("recall_memory", { q: f.keyword ?? args.question, daysBack: f.daysBack ?? 30, limit: f.limit ?? 5 });
      if (/dự án|project/.test(q) && /list|liệt kê|active|đang/.test(q)) return route("search_projects", { keyword: f.keyword ?? "", limit: f.limit ?? 50 });
      if (/task #?\d+|task id/.test(q) || f.taskId) {
        // Specific task lookup
        return route("search_tasks", { keyword: f.keyword ?? args.question ?? "", limit: f.limit ?? 10 });
      }

      // Fallback — task search
      return route("search_tasks", { keyword: f.keyword ?? args.question ?? "", limit: f.limit ?? 50 });
    },
  }
