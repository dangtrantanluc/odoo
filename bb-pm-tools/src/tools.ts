import { bbPm } from "./api-client";
import { cooldown } from "./cooldown";
import {
  sendToGapo,
  sendDmViaBrowser,
  findGapoUserViaBrowser,
  findAndOpenDmViaBrowser,
} from "./channel-out";
import { extractMeetingFromTranscript } from "./meeting";

export type ToolDefinition<TArgs, TResult> = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: TArgs) => Promise<TResult>;
};

const requireString = (value: unknown, field: string) => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
};

export const tools: ToolDefinition<any, any>[] = [
  {
    name: "list_overdue_tasks",
    description:
      "List tasks whose deadline has passed and status is not DONE. " +
      "Use for queries like 'task nào quá hạn?', 'những việc nào trễ deadline?'.",
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "integer", description: "Optional project scope." },
        days: {
          type: "integer",
          description: "Overdue by at least N days. 0 = any overdue.",
          default: 0,
        },
        limit: { type: "integer", default: 50 },
      },
      required: [],
    },
    handler: async (args: { projectId?: number; days?: number; limit?: number }) => {
      const res = await bbPm.listOverdueTasks(args ?? {});
      return {
        total: res.meta.total,
        cutoff: res.meta.cutoff,
        tasks: res.data.map((t) => ({
          id: t.id,
          name: t.name,
          status: t.status,
          priority: t.priority,
          deadline: t.deadline,
          daysOverdue: t.daysOverdue,
          project: t.project?.name,
          projectCode: t.project?.code,
          assignee: t.assignee?.fullName ?? null,
        })),
      };
    },
  },

  {
    name: "list_stale_tasks",
    description:
      "List tasks not updated for N days (default 7), status not DONE. " +
      "Use for 'task nào lâu chưa update?', 'việc nào bị bỏ quên?'.",
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "integer" },
        daysSinceUpdate: { type: "integer", default: 7 },
        limit: { type: "integer", default: 50 },
      },
      required: [],
    },
    handler: async (args: { projectId?: number; daysSinceUpdate?: number; limit?: number }) => {
      const res = await bbPm.listStaleTasks(args ?? {});
      return {
        total: res.meta.total,
        cutoff: res.meta.cutoff,
        tasks: res.data.map((t) => ({
          id: t.id,
          name: t.name,
          status: t.status,
          updatedAt: t.updatedAt,
          daysSinceUpdate: t.daysSinceUpdate,
          project: t.project?.name,
          assignee: t.assignee?.fullName ?? null,
        })),
      };
    },
  },

  {
    name: "check_data_hygiene",
    description:
      "Audit open tasks for missing data: no owner, no deadline, or status not updated for >= staleDays. " +
      "Use for 'task nào thiếu owner?', 'kiểm tra dữ liệu', 'data hygiene'.",
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "integer" },
        staleDays: { type: "integer", default: 14 },
      },
      required: [],
    },
    handler: async (args: { projectId?: number; staleDays?: number }) => {
      const res = await bbPm.checkHygiene(args ?? {});
      const simplify = (t: {
        id: number;
        name: string;
        project: { name: string } | null;
        assignee: { fullName: string } | null;
        deadline: string | null;
      }) => ({
        id: t.id,
        name: t.name,
        project: t.project?.name,
        assignee: t.assignee?.fullName ?? null,
        deadline: t.deadline,
      });
      return {
        staleCutoff: res.meta.staleCutoff,
        counts: {
          missingOwner: res.data.missingOwner.length,
          missingDeadline: res.data.missingDeadline.length,
          staleStatus: res.data.staleStatus.length,
          total: res.meta.total,
        },
        samples: {
          missingOwner: res.data.missingOwner.slice(0, 10).map(simplify),
          missingDeadline: res.data.missingDeadline.slice(0, 10).map(simplify),
          staleStatus: res.data.staleStatus.slice(0, 10).map(simplify),
        },
      };
    },
  },

  {
    name: "generate_daily_digest",
    description:
      "Rollup across all active projects: task counts (open/overdue/stale/unassigned) + per-project progress. " +
      "Use for 'tổng kết hôm nay', 'báo cáo sáng', or when user asks for big-picture status.",
    parameters: { type: "object", properties: {}, required: [] },
    handler: async () => {
      const res = await bbPm.digest();
      return res.data;
    },
  },

  {
    name: "get_project_snapshot",
    description:
      "Get a snapshot of a project: meta + open tasks with assignee/deadline/status. " +
      "Use for 'tình hình dự án X', 'project X snapshot'.",
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "integer", description: "Project ID to snapshot." },
      },
      required: ["projectId"],
    },
    handler: async (args: { projectId: number }) => {
      const res = await bbPm.projectSnapshot(args.projectId);
      return res.data;
    },
  },

  {
    name: "list_blocked_tasks",
    description:
      "List tasks in BLOCKED status for a project. " +
      "Use for 'task nào đang bị block?', 'những việc nào đang bị tắc?'.",
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "integer", description: "Project ID to check." },
        limit: { type: "integer", default: 50 },
      },
      required: ["projectId"],
    },
    handler: async (args: { projectId: number; limit?: number }) => {
      const res = await bbPm.listBlockedTasks(args.projectId, args.limit ?? 50);
      return {
        total: res.meta.total,
        tasks: res.data.map((t) => ({
          id: t.id,
          name: t.name,
          status: t.status,
          project: t.project?.name,
          assignee: t.assignee?.fullName ?? null,
        })),
      };
    },
  },

  {
    name: "get_task_owner",
    description:
      "Get the assignee of a specific task. Use for 'task X do ai?', 'who is responsible for task X?'.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "integer", description: "Task ID to query." },
      },
      required: ["taskId"],
    },
    handler: async (args: { taskId: number }) => {
      const res = await bbPm.getTaskOwner(args.taskId);
      return {
        taskId: res.data.taskId,
        owner: res.data.owner
          ? { id: res.data.owner.id, name: res.data.owner.fullName }
          : null,
      };
    },
  },

  {
    name: "update_task_status",
    description:
      "Transition a task to a new status. Server enforces allowed transitions. " +
      "Use for 'đổi trạng thái task X thành Y', 'mark task X as done'.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "integer", description: "Task ID to update." },
        newStatus: {
          type: "string",
          enum: ["TODO", "IN_PROGRESS", "DONE", "BLOCKED"],
          description: "New task status.",
        },
      },
      required: ["taskId", "newStatus"],
    },
    handler: async (args: { taskId: number; newStatus: string }) => {
      const res = await bbPm.updateTaskStatus(args.taskId, args.newStatus);
      return { taskId: res.data.id, status: res.data.status };
    },
  },

  {
    name: "list_users_with_workload",
    description:
      "List active users + their open task count, ordered by workload ASC (least busy first). " +
      "Use to answer 'ai đang rảnh nhất / bận nhất', or before distributing tasks. " +
      "Filter by department (vd 'AI', 'BA', 'Software', 'UI/UX', 'Content-Media') and/or role.",
    parameters: {
      type: "object",
      properties: {
        department: { type: "string", description: "Filter by Gapo department exact match" },
        role: { type: "string", enum: ["ADMIN", "MANAGER", "MEMBER", "VIEWER"] },
        limit: { type: "integer", default: 30 },
      },
    },
    handler: async (args: { department?: string; role?: string; limit?: number }) => {
      const res = await bbPm.listUsersWithWorkload(args);
      return res.data;
    },
  },

  {
    name: "assign_task",
    description:
      "Change the assignee of an existing task. Use after user explicitly confirms " +
      "an assignment, OR after user approves a suggested distribution. NEVER assign " +
      "without confirmation. To re-assign multiple tasks, call this tool once per task.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "integer", description: "Task id from bb-pm DB" },
        assigneeId: { type: "integer", description: "bb-pm userId of new assignee" },
      },
      required: ["taskId", "assigneeId"],
    },
    handler: async (args: { taskId: number; assigneeId: number }) => {
      const res = await bbPm.updateTaskAssignee(args.taskId, args.assigneeId);
      return res.data;
    },
  },

  {
    name: "create_project",
    description:
      "Create a new project. Use when user asks 'tạo project mới' / 'làm dự án X'. " +
      "Always confirm with user (name, deadline, owner) BEFORE calling. After " +
      "create, decompose into tasks via create_action_item × N (5-7 tasks " +
      "covering design → impl → QA phases, assigned by department).",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Project display name." },
        code: { type: "string", description: "Short code (e.g. WR-2026, MA-V2). Optional, auto-generated if omitted." },
        priority: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "URGENT"] },
        startDate: { type: "string", description: "ISO YYYY-MM-DD. Default = today." },
        endDate: { type: "string", description: "ISO YYYY-MM-DD. Project deadline." },
        description: { type: "string", description: "1-2 sentences describing scope." },
        ownerId: { type: "integer", description: "bb-pm userId of project owner. Default = caller." },
        estimatedTotalHours: { type: "number", description: "Optional total effort estimate." },
      },
      required: ["name", "ownerId"],
    },
    handler: async (args: any) => {
      const name = requireString(args.name, "name");
      const today = new Date().toISOString().slice(0, 10);
      const res = await bbPm.createProject({
        name,
        code: args.code,
        priority: args.priority ?? "MEDIUM",
        startDate: args.startDate ?? today,
        endDate: args.endDate,
        description: args.description,
        ownerId: args.ownerId,
        estimatedTotalHours: args.estimatedTotalHours,
      });
      return res.data;
    },
  },

  {
    name: "create_action_item",
    description:
      "Create a new task under a specific project. " +
      "Use for 'tạo task mới trong dự án X', 'create action item in project X'.",
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "integer", description: "Project ID to create the task in." },
        name: { type: "string", description: "Name of the new task." },
        assigneeId: {
          type: "integer",
          description: "User ID to assign the task to.",
          nullable: true,
        },
        deadline: {
          type: "string",
          format: "date-time",
          description: "Deadline for the task (ISO format).",
          nullable: true,
        },
      },
      required: ["projectId", "name"],
    },
    handler: async (args: {
      projectId: number;
      name: string;
      assigneeId?: number;
      deadline?: string;
    }) => {
      const res = await bbPm.createActionItem(args);
      return { taskId: res.data.id };
    },
  },

  // ── find / search ─────────────────────────────────
  {
    name: "find_project",
    description: "Find project by name (top 10 matches). Use for 'tìm dự án X', 'find project X'.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name of the project to find." },
      },
      required: ["name"],
    },
    handler: async (args: { name: string }) => {
      const name = requireString(args.name, "name");
      const res = await bbPm.findProject(name);
      return res.data.map((p) => ({ id: p.id, name: p.name, code: p.code }));
    },
  },

  {
    name: "find_task",
    description: "Find task by name (top 10 matches). Use for 'tìm task X', 'find task X'.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name of the task to find." },
      },
      required: ["name"],
    },
    handler: async (args: { name: string }) => {
      const name = requireString(args.name, "name");
      const res = await bbPm.findTask(name);
      return res.data.map((t) => ({
        id: t.id,
        name: t.name,
        status: t.status,
        project: t.project?.name,
        assignee: t.assignee?.fullName ?? null,
      }));
    },
  },

  {
    name: "find_user",
    description:
      "Find a user in the bb-pm internal database (employees with bb-pm accounts). " +
      "Use for 'tìm người dùng X' / 'find user X' to look up tasks, assignees. " +
      "Returns 0 results means the person isn't onboarded into bb-pm — for " +
      "looking up Gapo Work members instead, use find_gapo_user.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name or email substring to search." },
      },
      required: ["name"],
    },
    handler: async (args: { name: string }) => {
      const name = requireString(args.name, "name");
      const res = await bbPm.findUser(name);
      return res.data;
    },
  },

  {
    name: "find_gapo_user",
    description:
      "Search the Gapo Work organization for a user by name (Vietnamese supported). " +
      "Use when the user references someone NOT in bb-pm DB (e.g. 'tìm Lực trên Gapo'). " +
      "Returns matched display names only — to actually message someone use " +
      "send_dm_to_gapo_user which finds + opens DM + sends in one step.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Name or substring to search Gapo org." },
      },
      required: ["query"],
    },
    handler: async (args: { query: string }) => {
      const q = requireString(args.query, "query");
      return await findGapoUserViaBrowser(q);
    },
  },

  {
    name: "send_dm_to_gapo_user",
    description:
      "Find a Gapo Work user by name and send them a DM. Atomic operation: " +
      "(1) search org for the name, (2) click DM icon to open conversation, " +
      "(3) type + send message. Use when user says 'nhắn cho X', 'gửi tin cho X' " +
      "where X is a Gapo member. Returns conversationId on success so caller " +
      "can reuse it. Throttled to 30 DMs/hour anti-spam.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Recipient name to search on Gapo." },
        text: { type: "string", description: "Message text in Vietnamese, ≤2000 chars." },
      },
      required: ["query", "text"],
    },
    handler: async (args: { query: string; text: string }) => {
      const q = requireString(args.query, "query");
      const text = requireString(args.text, "text");

      const found = await findAndOpenDmViaBrowser(q);
      if ("error" in found) return { sent: false, reason: "error", message: found.error };
      if ("found" in found && found.found === false) {
        return { sent: false, reason: "user_not_found", query: q };
      }
      const { conversationId, name } = found as { conversationId: string; name: string };

      const sendResult = await sendDmViaBrowser(conversationId, text);
      if (!sendResult.sent) {
        return { sent: false, reason: sendResult.reason, conversationId, name };
      }
      return {
        sent: true,
        conversationId,
        name,
        messageId: sendResult.messageId,
      };
    },
  },

  {
    name: "search_tasks",
    description:
      "Search tasks by keyword (task name) AND/OR filter by assigneeId / projectId / status. " +
      "Cho câu 'task của <X>': call find_user(name=X) trước → lấy userId → gọi search_tasks(assigneeId=userId). " +
      "KHÔNG dùng keyword cho tên người vì keyword chỉ search task NAME.",
    parameters: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "Optional. Keyword to search in task NAME (NOT assignee name)." },
        assigneeId: { type: "integer", description: "Optional. Filter tasks assigned to this bb-pm userId." },
        projectId: { type: "integer", description: "Optional. Filter tasks in this projectId." },
        status: {
          type: "string",
          description: "Optional. Status filter: TODO | IN_PROGRESS | REVIEW | DONE | CANCELLED.",
        },
        limit: { type: "integer", default: 50 },
      },
      required: [],
    },
    handler: async (args: {
      keyword?: string;
      assigneeId?: number;
      projectId?: number;
      status?: string;
      limit?: number;
    }) => {
      if (!args.keyword && !args.assigneeId && !args.projectId && !args.status) {
        throw new Error(
          "search_tasks: cần ít nhất 1 filter (keyword | assigneeId | projectId | status)",
        );
      }
      const res = await bbPm.searchTasks({
        keyword: args.keyword,
        assigneeId: args.assigneeId,
        projectId: args.projectId,
        status: args.status,
        limit: args.limit ?? 50,
      });
      return res.data.map((t) => ({
        id: t.id,
        name: t.name,
        status: t.status,
        project: t.project?.name,
        assignee: t.assignee?.fullName ?? null,
      }));
    },
  },

  {
    name: "search_projects",
    description:
      "Search projects by keyword. Use for 'tìm kiếm dự án với từ khóa X', 'search projects with keyword X'.",
    parameters: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "Keyword to search in project names." },
        limit: { type: "integer", default: 50 },
      },
      required: ["keyword"],
    },
    handler: async (args: { keyword: string; limit?: number }) => {
      const keyword = requireString(args.keyword, "keyword");
      const res = await bbPm.searchProjects(keyword, args.limit ?? 50);
      return res.data.map((p) => ({ id: p.id, name: p.name, code: p.code }));
    },
  },

  // ── Sprint 3: Follow-up ───────────────────────────
  {
    name: "send_follow_up",
    description:
      "Send a short Vietnamese follow-up message to the task assignee via Gapo. " +
      "Looks up the user's Gapo thread from bb-pm, enforces a 24h cooldown per " +
      "(user, task) pair so the same person is not pinged twice in a day. " +
      "Use when you decide a task needs a progress/ETA/blocker check-in. " +
      "If the user has no Gapo mapping, returns { skipped: 'no_gapo_thread' }.",
    parameters: {
      type: "object",
      properties: {
        userId: { type: "integer", description: "Target assignee id in bb-pm." },
        taskId: { type: "integer", description: "Task id the message is about." },
        question: {
          type: "string",
          description:
        "Vietnamese, <=200 chars, polite. Must reference the task name " +
        "so the recipient has context. Do not include visible #id/task id in the message. Examples: 'Chào A, task Dashboard " +
            "KPI cards đang tới hạn 2026-04-15, mình cập nhật tiến độ được chứ?'",
        },
      },
      required: ["userId", "taskId", "question"],
    },
    handler: async (args: { userId: number; taskId: number; question: string }) => {
      const question = requireString(args.question, "question");
      const key = `followup:${args.userId}:${args.taskId}`;
      if (await cooldown.isCoolingDown(key)) {
        return {
          skipped: "cooldown",
          remainingSec: await cooldown.remainingSec(key),
        };
      }

      // Try the bot API path first: look up an existing Gapo thread for
      // the user, post via gapo-work /send.
      let threadId: string | null = null;
      let externalId: string | null = null;
      try {
        const res = await bbPm.getGapoThread(args.userId);
        threadId = res.data.gapoThreadId;
        externalId = res.data.gapoUserId;
      } catch (err: any) {
        if (!/404/.test(err?.message || "")) throw err;
        // No Gapo thread → fall through to browser fallback.
      }

      let deliveredVia: "gapo-bot" | "browser" | "none" = "none";

      if (threadId) {
        await sendToGapo(threadId, question);
        deliveredVia = "gapo-bot";
      } else {
        // Browser fallback (Sprint 3.5). Needs an externalId — without
        // one, even browser can't address the recipient. Skip cleanly.
        if (!externalId) {
          return { skipped: "no_gapo_thread" };
        }
        const fallback = await sendDmViaBrowser(externalId, question);
        if (!fallback.sent) {
          return {
            skipped: "no_gapo_thread",
            fallback: { reason: fallback.reason, message: fallback.message },
          };
        }
        deliveredVia = "browser";
        threadId = fallback.messageId; // best-effort handle for record
      }

      await cooldown.mark(key);
      let followUpId: number | undefined;
      try {
        const rec = await bbPm.recordFollowUp({
          taskId: args.taskId,
          userId: args.userId,
          channel: "gapo",
          threadId: threadId ?? undefined,
          question,
        });
        followUpId = rec.data.id;
      } catch (err: any) {
        // Don't fail the send if record fails — the message went out.
        console.warn("[bb-pm-tools] recordFollowUp failed:", err?.message || err);
      }
      return {
        sent: true,
        threadId,
        deliveredVia,
        followUpId,
        cooldownSec: await cooldown.remainingSec(key),
      };
    },
  },

  // ── Sprint 6.2: Follow-up tracking ────────────────
  {
    name: "list_pending_follow_ups",
    description:
      "Liệt kê các follow-up agent đã gửi nhưng người được hỏi CHƯA reply. " +
      "Dùng cho 'ai chưa reply?', 'những lượt ping nào đang treo?', 'check follow-up trạng thái'. " +
      "Trả ra list kèm task, người, câu hỏi, đã chờ bao lâu.",
    parameters: {
      type: "object",
      properties: {
        userId: { type: "integer", description: "Lọc theo 1 user." },
        taskId: { type: "integer", description: "Lọc theo 1 task." },
        daysBack: { type: "integer", default: 14, description: "Window lùi về (ngày)." },
        limit: { type: "integer", default: 50 },
      },
      required: [],
    },
    handler: async (args: { userId?: number; taskId?: number; daysBack?: number; limit?: number }) => {
      const res = await bbPm.listFollowUps({
        userId: args.userId,
        taskId: args.taskId,
        status: "PENDING",
        daysBack: args.daysBack ?? 14,
        limit: args.limit ?? 50,
      });
      const now = Date.now();
      return {
        total: res.meta.total,
        cutoff: res.meta.cutoff,
        followUps: res.data.map((f) => {
          const askedAt = new Date(f.askedAt).getTime();
          const ageHours = Math.round((now - askedAt) / 3_600_000);
          return {
            id: f.id,
            askedAt: f.askedAt,
            ageHours,
            channel: f.channel,
            user: { id: f.user.id, name: f.user.fullName },
            task: {
              id: f.task.id,
              name: f.task.name,
              project: f.task.project?.name ?? null,
            },
            question: f.question.slice(0, 200),
          };
        }),
      };
    },
  },

  {
    name: "mark_follow_up_replied",
    description:
      "Đánh dấu một follow-up là đã được trả lời. GỌI khi user nói 'X đã reply' " +
      "hoặc khi parser nhận diện reply từ thread. Cũng có thể dùng để CANCELLED " +
      "(huỷ vì lý do khác — vd task đã đóng) hoặc EXPIRED (quá hạn không reply).",
    parameters: {
      type: "object",
      properties: {
        followUpId: { type: "integer", description: "ID lấy từ list_pending_follow_ups." },
        status: {
          type: "string",
          enum: ["REPLIED", "CANCELLED", "EXPIRED"],
          default: "REPLIED",
        },
        replyText: {
          type: "string",
          description: "Tóm tắt nội dung reply (nếu có) — tối đa 4000 ký tự.",
        },
      },
      required: ["followUpId"],
    },
    handler: async (args: { followUpId: number; status?: "REPLIED" | "CANCELLED" | "EXPIRED"; replyText?: string }) => {
      const res = await bbPm.patchFollowUp(args.followUpId, {
        status: args.status ?? "REPLIED",
        replyText: args.replyText,
      });
      return res.data;
    },
  },

  // ── Sprint 4: Weekly report ───────────────────────
  {
    name: "generate_weekly_report",
    description:
      "Rollup 7 ngày (mặc định): tasks done, new blockers, backlog hours approved, " +
      "upcoming deadlines, completion % per project. Dùng cho 'báo cáo tuần', " +
      "'weekly report', 'tình hình tuần qua', hoặc câu hỏi CEO về xu hướng.",
    parameters: {
      type: "object",
      properties: {
        days: {
          type: "integer",
          description: "Window size. Default 7. Max 90.",
          default: 7,
        },
        projectId: {
          type: "integer",
          description: "Optional — limit to 1 project.",
        },
      },
      required: [],
    },
    handler: async (args: { days?: number; projectId?: number }) => {
      const res = await bbPm.weeklyReport(args ?? {});
      return res.data;
    },
  },

  // ── Sprint 4: Memory recall ───────────────────────
  {
    name: "recall_memory",
    description:
      "Tìm lại tóm tắt hội thoại trước đó liên quan đến câu hỏi hiện tại. " +
      "GỌI KHI: (a) CEO/manager hỏi một câu có vẻ kế thừa context trước đó " +
      "('lần trước bảo sao rồi?', 'vụ dashboard update tiếp đi'), (b) khi cần " +
      "nhớ ai đã được ping, ai đã báo blocker gì. KHÔNG gọi cho câu quan sát " +
      "thuần (overdue, digest) — dữ liệu tươi từ bb-pm API đã đủ.",
    parameters: {
      type: "object",
      properties: {
        q: {
          type: "string",
          description: "Keyword hoặc cụm mô tả chủ đề cần recall (VN hoặc EN).",
        },
        projectId: { type: "integer", description: "Scope theo project." },
        taskId: { type: "integer", description: "Scope theo task." },
        daysBack: { type: "integer", default: 30, description: "Window lùi về." },
        limit: { type: "integer", default: 5, description: "Số bản ghi tối đa (≤ 50)." },
      },
      required: [],
    },
    handler: async (args: {
      q?: string;
      projectId?: number;
      taskId?: number;
      daysBack?: number;
      limit?: number;
    }) => {
      const res = await bbPm.searchMemory(args ?? {});
      return {
        total: res.meta.total,
        cutoff: res.meta.cutoff,
        memories: res.data.map((m) => ({
          id: m.id,
          when: m.createdAt,
          source: m.source,
          conversationId: m.conversationId,
          userText: m.userText.slice(0, 300),
          summary: m.summary,
          toolsUsed: m.toolsUsed,
          projectIds: m.projectIds,
          taskIds: m.taskIds,
        })),
      };
    },
  },

  // ── Sprint 5: Meeting Assistant ───────────────────
  {
    name: "ingest_meeting",
    description:
      "Nhận transcript hội họp → dùng LLM extract ra summary, decisions, participants, " +
      "action items → lưu Meeting vào DB với items ở trạng thái DRAFT (chờ PM approve). " +
      "GỌI KHI: user dán transcript dài, hoặc yêu cầu 'tóm tắt họp / trích action items'. " +
      "KHÔNG tự approve — agent chỉ tạo DRAFT để PM review. Trả ra meetingId + số items.",
    parameters: {
      type: "object",
      properties: {
        transcript: {
          type: "string",
          description:
            "Transcript text của cuộc họp (≤ 200_000 ký tự). Có thể là notes thô, không cần format sẵn.",
        },
        projectId: {
          type: "integer",
          description:
            "Project scope nếu biết — items sẽ tạo task trong project này khi approve.",
        },
        title: { type: "string", description: "Optional: tiêu đề meeting." },
      },
      required: ["transcript"],
    },
    handler: async (args: { transcript: string; projectId?: number; title?: string }) => {
      const transcript = requireString(args.transcript, "transcript");
      if (transcript.length < 30) {
        return { error: "Transcript quá ngắn để trích xuất có ý nghĩa." };
      }
      const extracted = await extractMeetingFromTranscript(transcript);
      const res = await bbPm.createMeeting({
        title: args.title ?? extracted.title,
        transcript,
        summary: extracted.summary || undefined,
        decisions: extracted.decisions,
        participants: extracted.participants,
        projectId: args.projectId,
        items: extracted.actionItems.map((it) => ({
          title: it.title,
          description: it.description,
          ownerName: it.ownerName,
          dueDate: it.dueDate,
          priority: it.priority,
        })),
      });
      return {
        meetingId: res.data.id,
        summary: res.data.summary,
        decisions: res.data.decisions,
        participants: res.data.participants,
        items: res.data.items.map((it) => ({
          id: it.id,
          title: it.title,
          ownerName: it.ownerName,
          ownerUserId: it.ownerUserId,
          ownerResolved: it.ownerUserId !== null,
          dueDate: it.dueDate,
          priority: it.priority,
          status: it.status,
        })),
        note: "Items đang ở trạng thái DRAFT. User cần approve (tool approve_meeting_items) trước khi tạo task thật.",
      };
    },
  },

  {
    name: "approve_meeting_items",
    description:
      "Approve các action items từ một Meeting đã ingest → tạo Task trong project tương ứng. " +
      "GỌI KHI user đã review DRAFT items và đồng ý tạo task. Yêu cầu meetingId + " +
      "danh sách itemIds. Nếu meeting chưa có projectId, truyền defaultProjectId.",
    parameters: {
      type: "object",
      properties: {
        meetingId: { type: "integer" },
        itemIds: {
          type: "array",
          items: { type: "integer" },
          description: "ID của action items muốn approve (lấy từ ingest_meeting result).",
        },
        defaultProjectId: {
          type: "integer",
          description: "Project để tạo task nếu meeting chưa có projectId.",
        },
      },
      required: ["meetingId", "itemIds"],
    },
    handler: async (args: {
      meetingId: number;
      itemIds: number[];
      defaultProjectId?: number;
    }) => {
      if (!Array.isArray(args.itemIds) || args.itemIds.length === 0) {
        return { error: "itemIds phải là mảng không rỗng." };
      }
      const res = await bbPm.approveMeetingItems(args.meetingId, {
        itemIds: args.itemIds,
        defaultProjectId: args.defaultProjectId,
      });
      return res.data;
    },
  },

  // ── Sprint 3: Blocker ─────────────────────────────
  {
    name: "post_blocker",
    description:
      "Record a blocker against a task: appends the description to task.issues " +
      "with a severity tag and creates a structured TaskBlocker row. Use when " +
      "the user says 'kẹt/stuck/block/chặn/không làm được vì ...'. " +
      "Severity: LOW (can wait), MED (default, slows work), HIGH (escalate).",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "integer" },
        description: {
          type: "string",
          description: "Vietnamese, <= 2000 chars. What is blocked, why, what's needed.",
        },
        severity: {
          type: "string",
          enum: ["LOW", "MED", "HIGH"],
          default: "MED",
        },
      },
      required: ["taskId", "description"],
    },
    handler: async (args: { taskId: number; description: string; severity?: "LOW" | "MED" | "HIGH" }) => {
      const description = requireString(args.description, "description");
      const res = await bbPm.postBlocker(args.taskId, {
        description,
        severity: args.severity ?? "MED",
      });
      return res.data;
    },
  },

  // ═══════════════════════════════════════════════════════════════════════
  // V2 NAMESPACE ALIASES (Phase 3.1) — `<domain>.<verb>` per spec v2.
  // Hiện song song với tool cũ. Khi prompt v2 active (BB_PM_PROMPT_VERSION=v2),
  // LLM sẽ ưu tiên gọi các tool này. Backward compat giữ.
  // ═══════════════════════════════════════════════════════════════════════

  // ── ACTION: task.* ────────────────────────────────
  {
    name: "task.create",
    description:
      "[ACTION/v2] Tạo task mới trong project. Generic tool — KHÔNG bịa biến thể " +
      "specific như assign_task_to_user. Confirm với user trước khi tạo nếu " +
      "thông tin không đủ rõ.",
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "integer", description: "Project ID." },
        name: { type: "string", description: "Tên task." },
        description: { type: "string", description: "Mô tả chi tiết, optional." },
        assigneeId: { type: "integer", description: "User ID assignee, optional." },
        deadline: { type: "string", description: "Deadline YYYY-MM-DD, optional." },
        priority: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "URGENT"] },
        estimatedHours: { type: "number" },
      },
      required: ["projectId", "name"],
    },
    handler: async (args: any) => {
      const name = requireString(args.name, "name");
      const res = await bbPm.createActionItem({
        projectId: args.projectId,
        name,
        assigneeId: args.assigneeId,
        deadline: args.deadline,
      });
      return { taskId: res.data.id, name };
    },
  },

  {
    name: "task.update",
    description:
      "[ACTION/v2] Cập nhật task — generic patch. Args: taskId + patch object. " +
      "Patch có thể chứa: status (TODO/IN_PROGRESS/REVIEW/DONE/BLOCKED), " +
      "assigneeId, deadline (YYYY-MM-DD), priority, description, name. " +
      "status thay đổi sẽ đi qua transition validation. Single tool thay cho " +
      "cả update_task_status + assign_task. SAFETY: confirm với user TRƯỚC khi " +
      "update nếu user chỉ report (vd 'tôi đã done X') chứ không lệnh trực tiếp.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "integer" },
        patch: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["TODO", "IN_PROGRESS", "REVIEW", "DONE", "BLOCKED"] },
            assigneeId: { type: "integer" },
            deadline: { type: "string", description: "YYYY-MM-DD" },
            priority: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "URGENT"] },
            description: { type: "string" },
            name: { type: "string" },
          },
        },
      },
      required: ["taskId", "patch"],
    },
    handler: async (args: { taskId: number; patch: any }) => {
      const { status, ...rest } = args.patch ?? {};
      let result: any = {};
      // Status đi qua /transition để server validate. Field khác đi PATCH.
      if (status) {
        const r = await bbPm.updateTaskStatus(args.taskId, status);
        result.status = r.data.status;
      }
      if (Object.keys(rest).length) {
        const r = await bbPm.patchTask(args.taskId, rest);
        result = { ...result, ...r.data };
      }
      return { taskId: args.taskId, ...result };
    },
  },

  {
    name: "task.report_blocker",
    description:
      "[ACTION/v2] Ghi nhận blocker cho task. Severity: LOW (chờ được), MED " +
      "(default — chậm tiến độ), HIGH (cần escalate). Dùng khi user nói 'kẹt/" +
      "stuck/block/chặn/không làm được vì ...'.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "integer" },
        description: { type: "string", description: "Tiếng Việt, ≤ 2000 ký tự." },
        severity: { type: "string", enum: ["LOW", "MED", "HIGH"], default: "MED" },
      },
      required: ["taskId", "description"],
    },
    handler: async (args: { taskId: number; description: string; severity?: "LOW" | "MED" | "HIGH" }) => {
      const description = requireString(args.description, "description");
      const res = await bbPm.postBlocker(args.taskId, {
        description,
        severity: args.severity ?? "MED",
      });
      return res.data;
    },
  },

  // ── BULK ACTION: tasks.bulk_update — Sprint 8 Day 2 ──────────────
  {
    name: "tasks.bulk_update",
    description:
      "[ACTION/v2/BULK] Update nhiều task cùng lúc — 1 LLM call → N parallel " +
      "PATCH. Dùng khi PM muốn sửa > 3 task (vd 'set 5 task này priority HIGH'). " +
      "MAX 50 updates/call. Mỗi update = { taskId, patch: { status?, assigneeId?, " +
      "deadline?, priority?, description? } }. status đi qua /transition để " +
      "validate; field khác PATCH thẳng. SAFETY: confirm với user TRƯỚC, mô tả " +
      "rõ N task IDs sẽ thay đổi gì.",
    parameters: {
      type: "object",
      properties: {
        updates: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              taskId: { type: "integer" },
              patch: {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["TODO", "IN_PROGRESS", "REVIEW", "DONE", "BLOCKED"] },
                  assigneeId: { type: "integer" },
                  deadline: { type: "string", description: "YYYY-MM-DD" },
                  priority: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "URGENT"] },
                  description: { type: "string" },
                  name: { type: "string" },
                },
              },
            },
            required: ["taskId", "patch"],
          },
        },
      },
      required: ["updates"],
    },
    handler: async (args: { updates: Array<{ taskId: number; patch: any }> }) => {
      if (!Array.isArray(args.updates) || args.updates.length === 0) {
        return { error: "updates phải là mảng không rỗng." };
      }
      if (args.updates.length > 50) {
        return { error: "Max 50 updates/call. Split thành batches." };
      }
      const taskUpdate = toolsByName.get("task.update");
      if (!taskUpdate) return { error: "task.update tool unavailable" };
      const t0 = Date.now();
      const results = await Promise.allSettled(
        args.updates.map((u) => taskUpdate.handler(u)),
      );
      const ok = results.filter((r) => r.status === "fulfilled" && !(r.value as any)?.error).length;
      const failed = results.length - ok;
      return {
        total: results.length,
        ok,
        failed,
        durationMs: Date.now() - t0,
        details: results.map((r, i) => {
          const taskId = args.updates[i].taskId;
          if (r.status === "rejected") {
            return { taskId, ok: false, error: String(r.reason?.message ?? r.reason).slice(0, 200) };
          }
          const v = r.value as any;
          if (v?.error) return { taskId, ok: false, error: String(v.error).slice(0, 200) };
          return { taskId, ok: true };
        }),
      };
    },
  },

  // ── BULK ACTION: messages.broadcast — Sprint 8 Day 2 ──────────────
  {
    name: "messages.broadcast",
    description:
      "[ACTION/v2/BULK] Gửi tin nhắn cùng template cho N recipients đồng thời. " +
      "1 LLM call → N parallel send (Gapo bot path 200ms each, browser path " +
      "10s + throttle 30/h). Dùng khi PM 'nhắc tất cả overdue', 'thông báo " +
      "deadline', 'reminder weekly'. MAX 30 recipients/call (anti-spam guard). " +
      "Template hỗ trợ {{var}} placeholders fill từ recipient.params.\n" +
      "SAFETY: BẮT BUỘC confirm với user TRƯỚC. Mô tả: 'sẽ gửi N tin cho " +
      "[tên list], sample message: ...'. Nếu user OK → gọi tool; nếu cần " +
      "preview → dùng options.dryRun=true để return plan mà không gửi.",
    parameters: {
      type: "object",
      properties: {
        recipients: {
          type: "array",
          maxItems: 30,
          items: {
            type: "object",
            properties: {
              to: {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["task_assignee", "bb_user", "gapo_query"] },
                  taskId: { type: "integer" },
                  userId: { type: "integer" },
                  query: { type: "string" },
                },
                required: ["kind"],
              },
              params: {
                type: "object",
                description: "Variables để fill template, vd { name: 'Lực', taskName: 'WS-3' }",
              },
            },
            required: ["to"],
          },
        },
        template: {
          type: "string",
          description:
            "Template VN với {{var}} placeholders, vd 'Chào {{name}}, " +
            "task {{taskName}} đang quá hạn {{daysOverdue}} ngày, update giúp mình nhé?'",
        },
        options: {
          type: "object",
          properties: {
            isFollowUp: { type: "boolean", description: "Áp dụng cooldown 24h + log agent_follow_ups" },
            dryRun: { type: "boolean", description: "Return plan, không gửi thực" },
          },
        },
      },
      required: ["recipients", "template"],
    },
    handler: async (args: {
      recipients: Array<{ to: any; params?: Record<string, any> }>;
      template: string;
      options?: { isFollowUp?: boolean; dryRun?: boolean };
    }) => {
      const { renderTemplate } = await import("./template");
      const template = requireString(args.template, "template");
      if (!Array.isArray(args.recipients) || args.recipients.length === 0) {
        return { error: "recipients phải là mảng không rỗng." };
      }
      if (args.recipients.length > 30) {
        return { error: "Max 30 recipients/call. Split thành batches." };
      }

      // dryRun: trả ra plan để LLM/user verify trước khi send thật
      if (args.options?.dryRun) {
        return {
          dryRun: true,
          total: args.recipients.length,
          plan: args.recipients.map((r) => ({
            to: r.to,
            text: renderTemplate(template, r.params ?? {}),
          })),
        };
      }

      const sender = toolsByName.get("message.send");
      if (!sender) return { error: "message.send tool unavailable" };

      const t0 = Date.now();
      const results = await Promise.allSettled(
        args.recipients.map(async (r) => {
          const text = renderTemplate(template, r.params ?? {});
          return await sender.handler({ to: r.to, text, options: { isFollowUp: args.options?.isFollowUp } });
        }),
      );
      const sent = results.filter(
        (r) => r.status === "fulfilled" && (r.value as any)?.sent === true,
      ).length;
      const failed = results.length - sent;
      return {
        total: results.length,
        sent,
        failed,
        durationMs: Date.now() - t0,
        details: results.map((r, i) => {
          const recipient = args.recipients[i].to;
          if (r.status === "rejected") {
            return { recipient, sent: false, error: String(r.reason?.message ?? r.reason).slice(0, 200) };
          }
          const v = r.value as any;
          if (v?.sent === true) {
            return { recipient, sent: true, threadId: v.threadId, conversationId: v.conversationId };
          }
          return {
            recipient,
            sent: false,
            reason: v?.reason ?? v?.error ?? "unknown",
          };
        }),
      };
    },
  },

  // ── ACTION: project.* ─────────────────────────────
  {
    name: "project.create",
    description:
      "[ACTION/v2] Tạo project mới. Confirm với user (name + deadline + owner) " +
      "TRƯỚC khi gọi. Sau khi tạo, decompose thành 3-7 task qua task.create.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        code: { type: "string" },
        priority: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "URGENT"] },
        startDate: { type: "string", description: "YYYY-MM-DD." },
        endDate: { type: "string", description: "YYYY-MM-DD project deadline." },
        description: { type: "string" },
        ownerId: { type: "integer", description: "Default = caller." },
        estimatedTotalHours: { type: "number" },
      },
      required: ["name", "ownerId"],
    },
    handler: async (args: any) => {
      const name = requireString(args.name, "name");
      const today = new Date().toISOString().slice(0, 10);
      const res = await bbPm.createProject({
        name,
        code: args.code,
        priority: args.priority ?? "MEDIUM",
        startDate: args.startDate ?? today,
        endDate: args.endDate,
        description: args.description,
        ownerId: args.ownerId,
        estimatedTotalHours: args.estimatedTotalHours,
      });
      return res.data;
    },
  },

  {
    name: "project.update",
    description:
      "[ACTION/v2] Cập nhật project — generic patch. Args: projectId + patch. " +
      "Patch fields: name, priority, endDate, ownerId, description, " +
      "estimatedTotalHours, code, startDate.",
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "integer" },
        patch: {
          type: "object",
          properties: {
            name: { type: "string" },
            code: { type: "string" },
            priority: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "URGENT"] },
            startDate: { type: "string" },
            endDate: { type: "string" },
            description: { type: "string" },
            ownerId: { type: "integer" },
            estimatedTotalHours: { type: "number" },
          },
        },
      },
      required: ["projectId", "patch"],
    },
    handler: async (args: { projectId: number; patch: any }) => {
      const res = await bbPm.patchProject(args.projectId, args.patch ?? {});
      return res.data;
    },
  },

  // ── ACTION: message.* ─────────────────────────────
  {
    name: "message.send",
    description:
      "[ACTION/v2] Gửi tin nhắn tới recipient — polymorphic. " +
      "to.kind='task_assignee': nhắc assignee về task (cooldown 24h, log follow_up). " +
      "to.kind='bb_user': nhắn DM tới bb-pm user (đã có trong DB). " +
      "to.kind='gapo_query': tìm + nhắn user qua tên trên Gapo (browser-driven, throttle 30/h). " +
      "SAFETY: LUÔN confirm trước khi send (mô tả 'sẽ gửi cho ai, nội dung gì' rồi đợi user OK).",
    parameters: {
      type: "object",
      properties: {
        to: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["task_assignee", "bb_user", "gapo_query"] },
            taskId: { type: "integer", description: "Khi kind=task_assignee." },
            userId: { type: "integer", description: "Khi kind=bb_user — bb-pm userId." },
            query: { type: "string", description: "Khi kind=gapo_query — tên search Gapo." },
          },
          required: ["kind"],
        },
        text: { type: "string", description: "Nội dung tin tiếng Việt, ≤ 2000 ký tự." },
        options: {
          type: "object",
          properties: {
            isFollowUp: { type: "boolean", description: "Chỉ áp dụng task_assignee — log vào agent_follow_ups + cooldown." },
          },
        },
      },
      required: ["to", "text"],
    },
    handler: async (args: { to: any; text: string; options?: any }) => {
      const text = requireString(args.text, "text");
      const kind = args.to?.kind;

      if (kind === "task_assignee") {
        if (!args.to.taskId) return { error: "to.taskId required for task_assignee" };
        // Resolve assignee qua /tasks/:id
        const ownerRes = await bbPm.getTaskOwner(args.to.taskId);
        const assigneeId = ownerRes.data.owner?.id;
        if (!assigneeId) return { error: "Task không có assignee", taskId: args.to.taskId };

        // Delegate sang send_follow_up logic — gọi handler trực tiếp qua toolsByName
        const followUp = toolsByName.get("send_follow_up");
        if (!followUp) return { error: "send_follow_up tool unavailable" };
        return await followUp.handler({ userId: assigneeId, taskId: args.to.taskId, question: text });
      }

      if (kind === "bb_user") {
        if (!args.to.userId) return { error: "to.userId required for bb_user" };
        // Look up gapo thread, send via gapo bot path
        const fu = toolsByName.get("send_follow_up");
        if (!fu) return { error: "send_follow_up tool unavailable" };
        // Use a synthetic taskId? send_follow_up requires taskId for cooldown.
        // For free-form bb_user message, route through browser DM directly.
        return { error: "bb_user kind not supported — use kind=gapo_query với name của user, hoặc task_assignee với taskId" };
      }

      if (kind === "gapo_query") {
        if (!args.to.query) return { error: "to.query required for gapo_query" };
        const dm = toolsByName.get("send_dm_to_gapo_user");
        if (!dm) return { error: "send_dm_to_gapo_user tool unavailable" };
        return await dm.handler({ query: args.to.query, text });
      }

      return { error: `Unknown to.kind: ${kind}` };
    },
  },

  // ── ACTION: follow_up.* ───────────────────────────
  {
    name: "follow_up.update",
    description:
      "[ACTION/v2] Đánh dấu follow-up REPLIED / CANCELLED / EXPIRED. Dùng khi " +
      "user nói 'X đã reply rồi' hoặc khi cần đóng follow-up.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "integer", description: "Follow-up ID." },
        status: { type: "string", enum: ["REPLIED", "CANCELLED", "EXPIRED"], default: "REPLIED" },
        replyText: { type: "string", description: "Tóm tắt reply, optional." },
      },
      required: ["id"],
    },
    handler: async (args: { id: number; status?: "REPLIED" | "CANCELLED" | "EXPIRED"; replyText?: string }) => {
      const res = await bbPm.patchFollowUp(args.id, {
        status: args.status ?? "REPLIED",
        replyText: args.replyText,
      });
      return res.data;
    },
  },

  // ── ACTION: gapo.* ────────────────────────────────
  {
    name: "gapo.find_user",
    description:
      "[ACTION/v2] Tìm user trên Gapo Work org bằng tên (VN supported). " +
      "Browser-driven (không qua DB). Trả ra danh sách matched names. " +
      "Để gửi DM thẳng, dùng message.send với to.kind='gapo_query'.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    handler: async (args: { query: string }) => {
      const q = requireString(args.query, "query");
      return await findGapoUserViaBrowser(q);
    },
  },

  // ── READ: report.query — Phase 1 SQL gateway + Phase 5 keyword router ─
  // Hai cách dùng:
  //   1. Truyền `sql` (raw SELECT) → backend SQL gateway validate + execute.
  //      Phải scope: WHERE <alias>.company_id = $callerCompanyId.
  //   2. Truyền `question` (NL) → keyword router fallback delegate sang
  //      query tool cũ. Sẽ retire khi Phase 1.1 NL→SQL translator ready.
  {
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
    handler: async (args: { sql?: string; question?: string; entity?: string; filters?: any }) => {
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
          const { translateQuestionToSql } = await import("./nl-to-sql");
          const schemaRes = await bbPm.fetchSchemaDoc();
          // Caller scope từ ai gọi tool — Phase 1.2 MVP dùng companyId=1 placeholder
          // (eval/cli context). Production: orchestrator inject caller into ctx.
          // Thực tế server tự reject nếu SQL không có WHERE company_id, nên
          // an toàn dù placeholder sai — LLM sẽ học từ error.
          const callerCompanyId = Number(process.env.BB_PM_CALLER_COMPANY_ID || 1);
          const t = await translateQuestionToSql(
            args.question,
            schemaRes.data.schema,
            callerCompanyId,
          );
          const res = await bbPm.reportQueryRaw(t.sql);
          return { ...res.data, _translated: true, _explanation: t.explanation };
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
  },

  // ── AUTOMATION (Phase 4 — real impl) ──────────────────────────────
  {
    name: "automation.create",
    description:
      "[AUTOMATION/v2] Đăng ký workflow recurring. Persist vào DB; cron " +
      "registration ở next gateway boot (Phase 4 MVP — Phase 4.1 sẽ hot-register). " +
      "Workflow names khả dụng: daily_digest, weekly_report, hygiene_check, role_based_digest. " +
      "Schedule: cron expression (vd '0 9 * * *' = 9h sáng mỗi ngày). " +
      "Target: Gapo cid (vd 'collab:7001341214635140096' hoặc 'dm:<cid>'). " +
      "Limit: max 50 active per company.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Tên hiển thị (vd 'Daily digest cho group Bluebolt')." },
        schedule: { type: "string", description: "Cron expression (5 fields)." },
        workflow: { type: "string", enum: ["daily_digest", "weekly_report", "hygiene_check", "role_based_digest"] },
        inputs: { type: "object", description: "Workflow-specific args, optional." },
        target: { type: "string", description: "Gapo cid để push output." },
      },
      required: ["name", "schedule", "workflow"],
    },
    handler: async (args: { name: string; schedule: string; workflow: string; inputs?: any; target?: string }) => {
      try {
        const res = await bbPm.createAutomation({
          name: args.name,
          schedule: args.schedule,
          workflow: args.workflow,
          inputs: args.inputs ?? {},
          target: args.target,
        });
        return {
          ok: true,
          automation: res.data,
          note: "Persisted. Cron tick sẽ active sau khi gateway restart (Phase 4 MVP).",
        };
      } catch (err: any) {
        return { error: String(err?.message ?? err).slice(0, 600) };
      }
    },
  },

  {
    name: "automation.list",
    description:
      "[AUTOMATION/v2] List active automations của caller's company. " +
      "Trả ra id, name, workflow, schedule, target, lastRun status.",
    parameters: {
      type: "object",
      properties: {
        active: { type: "boolean", description: "Filter active only (default true)." },
      },
    },
    handler: async (args: { active?: boolean }) => {
      try {
        const res = await bbPm.listAutomations({ active: args.active ?? true });
        return {
          total: res.meta.total,
          automations: res.data.map((a) => ({
            id: a.id,
            name: a.name,
            workflow: a.workflow,
            schedule: a.schedule,
            target: a.target,
            active: a.active,
            lastRunAt: a.lastRunAt,
            lastRunStatus: a.lastRunStatus,
            lastRunError: a.lastRunError,
            consecutiveFails: a.consecutiveFails,
          })),
        };
      } catch (err: any) {
        return { error: String(err?.message ?? err).slice(0, 600) };
      }
    },
  },

  {
    name: "automation.delete",
    description:
      "[AUTOMATION/v2] Tắt automation (soft-delete: set active=false). " +
      "Sau gateway restart, cron sẽ không register lại. Confirm với user " +
      "trước khi gọi.",
    parameters: {
      type: "object",
      properties: { id: { type: "integer" } },
      required: ["id"],
    },
    handler: async (args: { id: number }) => {
      try {
        await bbPm.deleteAutomation(args.id);
        return { ok: true, id: args.id, note: "Disabled. Active=false." };
      } catch (err: any) {
        return { error: String(err?.message ?? err).slice(0, 600) };
      }
    },
  },

  {
    name: "workflow.run",
    description:
      "[AUTOMATION/v2] Chạy workflow ngay (one-shot). Khả dụng: daily_digest, " +
      "weekly_report, hygiene_check, role_based_digest. Inputs tùy workflow. Target = Gapo cid để push " +
      "output (bắt buộc nếu workflow gửi message). Confirm trước khi chạy nếu " +
      "workflow gửi message ra channel.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", enum: ["daily_digest", "weekly_report", "hygiene_check", "role_based_digest"] },
        inputs: { type: "object", description: "Workflow-specific args." },
        target: { type: "string", description: "Gapo cid để push (vd 'collab:7001...')." },
      },
      required: ["name"],
    },
    handler: async (args: { name: string; inputs?: any; target?: string }) => {
      const { runWorkflow } = await import("./workflows/registry");
      const result = await runWorkflow(args.name, args.inputs ?? {}, {
        source: "manual",
        target: args.target,
      });
      return result;
    },
  },
];

export const toolsByName = new Map(tools.map((t) => [t.name, t]));

// Tools chỉ enable trong v2 prompt (SQL-aware mode). v1 prompt (default) loại bỏ
// để Qwen không retry hell viết SQL sai cú pháp ($callerUserId, broken NL→SQL).
// Reasoning: v1 đã có tool cụ thể (overdue/stale/digest/find/...) cover hầu hết
// case. report.query cần SQL skill mà Qwen self-host yếu — defer đến khi ready
// chuyển Gemini hoặc Qwen-bigger.
const V2_ONLY_TOOLS = new Set(["report.query"]);

// Phase 6 — deprecated legacy tools (Sprint 7+ namespaced canonical thay thế).
// HANDLER vẫn giữ trong toolsByName để fast-path / workflows / internal callers
// dùng được, NHƯNG ẨN khỏi LLM catalog để giảm tool noise + token cost +
// chọn nhầm tool. LLM dùng namespaced tương đương:
//
//   assign_task            → task.update({ taskId, patch: { assigneeId } })
//   update_task_status     → task.update({ taskId, patch: { status } })
//   post_blocker           → task.report_blocker (hoặc task.update)
//   create_action_item     → task.create
//   create_project         → project.create
//   get_task_owner         → find_task (kèm assignee in result)
//   send_follow_up         → message.send (template)
//   send_dm_to_gapo_user   → message.send
//   find_gapo_user         → gapo.find_user
//   mark_follow_up_replied → follow_up.update
//
// Bật lại bằng env BB_PM_EXPOSE_LEGACY_TOOLS=true (rollback path).
const DEPRECATED_LEGACY_TOOLS = new Set([
  "assign_task",
  "update_task_status",
  "post_blocker",
  "create_action_item",
  "create_project",
  "get_task_owner",
  "send_follow_up",
  "send_dm_to_gapo_user",
  "find_gapo_user",
  "mark_follow_up_replied",
]);

const EXPOSE_LEGACY = process.env.BB_PM_EXPOSE_LEGACY_TOOLS === "true";

/**
 * Build tool catalog cho LLM. `promptVersion` filter:
 *   - "v1" (default) → loại V2_ONLY_TOOLS + DEPRECATED_LEGACY_TOOLS.
 *   - "v2" → full catalog, bao gồm SQL gateway.
 *
 * Set BB_PM_EXPOSE_LEGACY_TOOLS=true để rollback (expose lại 10 legacy nếu prompt
 * v1 + Qwen depend vào legacy names, eval regression chưa fix).
 */
export function toolCatalog(promptVersion: "v1" | "v2" = "v1") {
  const filtered = tools.filter((t) => {
    if (promptVersion !== "v2" && V2_ONLY_TOOLS.has(t.name)) return false;
    if (!EXPOSE_LEGACY && DEPRECATED_LEGACY_TOOLS.has(t.name)) return false;
    return true;
  });
  return filtered.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}
