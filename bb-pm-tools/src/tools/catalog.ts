import { bbPm } from "../infrastructure/api-client";
import { cooldown } from "../cooldown";
import { sendToGapo } from "../infrastructure/channel-client";
import { reportQueryTool } from "../reporting/report-query-tool";

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

const requirePositiveInt = (value: unknown, field: string) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return n;
};

const clampLimit = (value: unknown, fallback: number, max: number) => {
  const n = Number(value ?? fallback);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return Math.min(n, max);
};

const SNAPSHOT_TASK_LIMIT = Number(process.env.PROJECT_SNAPSHOT_TASK_LIMIT ?? 15);

function priorityRank(priority: unknown): number {
  switch (String(priority ?? "").toUpperCase()) {
    case "URGENT":
      return 4;
    case "HIGH":
      return 3;
    case "MEDIUM":
      return 2;
    case "LOW":
      return 1;
    default:
      return 0;
  }
}

function compactProjectSnapshot(snapshot: any, limit = SNAPSHOT_TASK_LIMIT) {
  const tasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks : [];
  const openTasks = tasks.filter((t: any) => t?.status !== "DONE");
  const doneTasks = tasks.filter((t: any) => t?.status === "DONE");
  const overdueOpenTasks = openTasks.filter(
    (t: any) => t?.deadline && new Date(t.deadline).getTime() < Date.now(),
  );
  const byStatus: Record<string, number> = {};
  const byPriority: Record<string, number> = {};
  for (const task of tasks) {
    const status = String(task?.status ?? "UNKNOWN");
    const priority = String(task?.priority ?? "UNKNOWN");
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    byPriority[priority] = (byPriority[priority] ?? 0) + 1;
  }
  const selectedTasks = [...openTasks]
    .sort((a: any, b: any) => {
      const priorityDelta = priorityRank(b?.priority) - priorityRank(a?.priority);
      if (priorityDelta !== 0) return priorityDelta;
      const aDeadline = a?.deadline ? new Date(a.deadline).getTime() : Number.MAX_SAFE_INTEGER;
      const bDeadline = b?.deadline ? new Date(b.deadline).getTime() : Number.MAX_SAFE_INTEGER;
      return aDeadline - bDeadline;
    })
    .slice(0, Math.max(0, limit))
    .map((t: any) => ({
      id: t.id,
      name: t.name,
      status: t.status,
      priority: t.priority,
      deadline: t.deadline,
      assignee: t.assignee
        ? { id: t.assignee.id, fullName: t.assignee.fullName ?? t.assignee.name ?? null }
        : null,
    }));

  return {
    id: snapshot?.id,
    name: snapshot?.name,
    code: snapshot?.code,
    status: snapshot?.status,
    endDate: snapshot?.endDate,
    taskSummary: {
      total: tasks.length,
      open: openTasks.length,
      done: doneTasks.length,
      overdueOpen: overdueOpenTasks.length,
      byStatus,
      byPriority,
      returnedTasks: selectedTasks.length,
      omittedTasks: Math.max(0, openTasks.length - selectedTasks.length),
      taskSelection: "open tasks sorted by priority desc, deadline asc",
    },
    tasks: selectedTasks,
  };
}

export const tools: ToolDefinition<any, any>[] = [
  {
    name: "pm.get_my_tasks_today",
    description: "Get current user's open tasks due today.",
    parameters: {
      type: "object",
      properties: {
        userId: { type: "integer" },
        limit: { type: "integer", default: 20 },
      },
      required: ["userId"],
    },
    handler: async (args: { userId: number; limit?: number }) => {
      const userId = requirePositiveInt(args.userId, "userId");
      const limit = clampLimit(args.limit, 20, 50);
      const res = await bbPm.reportQueryRaw(
        `SELECT t.id, t.name, t.status, t.priority, t.deadline, p.name AS project
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
         WHERE p.company_id = 1
           AND t.assignee_id = ${userId}
           AND t.status != 'DONE'
           AND t.deadline::date = CURRENT_DATE
         ORDER BY t.priority DESC, t.deadline ASC
         LIMIT ${limit}`,
      );
      return { total: res.data.rowCount, tasks: res.data.rows };
    },
  },

  {
    name: "pm.get_deadlines_this_week",
    description: "Get current user's open tasks with deadlines in the next 7 days.",
    parameters: {
      type: "object",
      properties: {
        userId: { type: "integer" },
        limit: { type: "integer", default: 30 },
      },
      required: ["userId"],
    },
    handler: async (args: { userId: number; limit?: number }) => {
      const userId = requirePositiveInt(args.userId, "userId");
      const limit = clampLimit(args.limit, 30, 50);
      const res = await bbPm.reportQueryRaw(
        `SELECT t.id, t.name, t.status, t.priority, t.deadline, p.name AS project
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
         WHERE p.company_id = 1
           AND t.assignee_id = ${userId}
           AND t.status != 'DONE'
           AND t.deadline >= CURRENT_DATE
           AND t.deadline < CURRENT_DATE + INTERVAL '7 days'
         ORDER BY t.deadline ASC, t.priority DESC
         LIMIT ${limit}`,
      );
      return { total: res.data.rowCount, tasks: res.data.rows };
    },
  },

  {
    name: "pm.get_my_projects",
    description: "Get active projects where the current user owns or has assigned open work.",
    parameters: {
      type: "object",
      properties: {
        userId: { type: "integer" },
        limit: { type: "integer", default: 20 },
      },
      required: ["userId"],
    },
    handler: async (args: { userId: number; limit?: number }) => {
      const userId = requirePositiveInt(args.userId, "userId");
      const limit = clampLimit(args.limit, 20, 50);
      const res = await bbPm.reportQueryRaw(
        `SELECT DISTINCT p.id, p.name, p.code, p.status, p.priority, p.end_date, p.task_count, p.member_count
         FROM projects p
         LEFT JOIN tasks t ON t.project_id = p.id
         WHERE p.company_id = 1
           AND p.status IN ('PLANNED','IN_PROGRESS','ON_HOLD')
           AND (p.owner_id = ${userId} OR t.assignee_id = ${userId})
         ORDER BY p.priority DESC, p.end_date ASC NULLS LAST
         LIMIT ${limit}`,
      );
      return { total: res.data.rowCount, projects: res.data.rows };
    },
  },

  {
    name: "pm.get_project_snapshot_by_name",
    description: "Find a project by name and return a compact snapshot with open tasks.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    },
    handler: async (args: { name: string }) => {
      const name = requireString(args.name, "name");
      const matches = await bbPm.findProject(name);
      const rows = matches.data ?? [];
      if (!rows.length) {
        return { found: false, query: name, matches: [] };
      }

      const normalize = (value: string) =>
        value
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/đ/g, "d")
          .replace(/[^\w\s]/g, " ")
          .replace(/\s+/g, " ")
          .trim();

      const q = normalize(name);
      const exact =
        rows.find((p) => normalize(String(p.name ?? "")) === q) ??
        rows.find((p) => normalize(String(p.name ?? "")).startsWith(q)) ??
        rows[0];

      const snapshot = await bbPm.projectSnapshot(exact.id);
      return {
        found: true,
        query: name,
        matchedProject: {
          id: exact.id,
          name: exact.name,
          code: exact.code,
          status: exact.status,
        },
        snapshot: compactProjectSnapshot(snapshot.data),
      };
    },
  },

  {
    name: "pm.get_overdue_tasks",
    description: "Get overdue open tasks.",
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "integer" },
        days: { type: "integer", default: 0 },
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
    name: "pm.get_blocked_tasks",
    description: "Get open tasks that have blockers.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", default: 30 },
      },
      required: [],
    },
    handler: async (args: { limit?: number }) => {
      const limit = clampLimit(args.limit, 30, 100);
      const res = await bbPm.reportQueryRaw(
        `SELECT t.id, t.name, t.status, t.priority, p.name AS project,
                COUNT(b.id) AS blocker_count, MAX(b.severity) AS max_severity
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
         JOIN task_blockers b ON b.task_id = t.id
         WHERE p.company_id = 1 AND t.status != 'DONE'
         GROUP BY t.id, t.name, t.status, t.priority, p.name
         ORDER BY blocker_count DESC, t.priority DESC
         LIMIT ${limit}`,
      );
      return { total: res.data.rowCount, tasks: res.data.rows };
    },
  },

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
      return compactProjectSnapshot(res.data);
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
      "Required: name, ownerId. Optional: description, endDate, priority. " +
      "Default priority=MEDIUM; endDate may be omitted. Always confirm before calling.",
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
        priority: t.priority,
        deadline: t.deadline,
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
        id: { type: "integer", description: "Exact bb-pm user id." },
        name: { type: "string", description: "Name or email substring to search." },
      },
      required: [],
    },
    handler: async (args: { id?: number; name?: string }) => {
      const res = await bbPm.findUser(args.name ?? "");
      if (args.id) {
        return res.data.find((u: any) => u.id === args.id) ?? null;
      }
      const name = requireString(args.name, "name");
      return res.data.filter(
        (u: any) =>
          String(u.name ?? "").toLowerCase().includes(name.toLowerCase()) ||
          String(u.email ?? "").toLowerCase().includes(name.toLowerCase()),
      );
    },
  },

  {
    name: "person_tasks",
    description: "Fast internal lookup for open tasks of a named person with caller permission checks.",
    parameters: {
      type: "object",
      properties: {
        targetName: { type: "string" },
        callerUserId: { type: "integer" },
      },
      required: ["targetName", "callerUserId"],
    },
    handler: async (args: { targetName: string; callerUserId: number }) => {
      const targetName = requireString(args.targetName, "targetName");
      const callerId = requirePositiveInt(args.callerUserId, "callerUserId");
      const callerMatches = await bbPm.findUser("");
      const caller = callerMatches.data.find((u: any) => u.id === callerId);
      if (!caller) return { kind: "no_caller" as const };
      const matches = (await bbPm.findUser(targetName)).data;
      if (!matches.length) return { kind: "not_found" as const, targetName };
      if (matches.length > 1) return { kind: "ambiguous" as const, matches: matches.map((u: any) => ({ name: u.name, role: u.role })) };
      const target = matches[0] as any;
      const askingSelf = target.id === callerId;
      if (!askingSelf && !["MANAGER", "ADMIN"].includes(String((caller as any).role))) {
        return { kind: "forbidden" as const };
      }
      const tasks = (await bbPm.searchTasks({ assigneeId: target.id, limit: 50 })).data
        .filter((t) => t.status !== "DONE")
        .map((t) => ({ id: t.id, name: t.name, status: t.status, project: t.project?.name, priority: t.priority, deadline: t.deadline }));
      return { kind: "ok" as const, target: { id: target.id, name: target.name }, tasks };
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

  {
    name: "checkin.missing",
    description:
      "[READ] Danh sách user còn thiếu check-in hôm nay. Dùng khi hỏi ai chưa cập nhật hoặc dữ liệu báo cáo còn thiếu.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD, optional." },
        projectId: { type: "integer" },
      },
      required: [],
    },
    handler: async (args: { date?: string; projectId?: number }) => {
      const res = await bbPm.getMissingCheckins(args);
      return res;
    },
  },

  {
    name: "project.daily_checkin_summary",
    description:
      "[READ] Tổng hợp check-in trong ngày của một project: tổng giờ, update mới nhất, blocker mới. " +
      "Dùng cho câu CEO hỏi tiến độ hôm nay của project.",
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "integer" },
        date: { type: "string", description: "YYYY-MM-DD, optional." },
      },
      required: ["projectId"],
    },
    handler: async (args: { projectId: number; date?: string }) => {
      const res = await bbPm.getProjectDailyCheckinSummary(args);
      return res.data;
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

      // Look up an existing Gapo thread for the user, post via gapo-agent
      // /send. Không có thread → không gửi được, skip sạch.
      let threadId: string | null = null;
      try {
        const res = await bbPm.getGapoThread(args.userId);
        threadId = res.data.gapoThreadId;
      } catch (err: any) {
        if (!/404/.test(err?.message || "")) throw err;
      }

      if (!threadId) {
        return { skipped: "no_gapo_thread" };
      }
      await sendToGapo(threadId, question);

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
        deliveredVia: "gapo-bot",
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
      "[ACTION/v2/BULK] Gửi tin nhắn cùng template cho N task assignees đồng thời. " +
      "Dùng khi PM 'nhắc tất cả overdue', 'thông báo " +
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
                  kind: { type: "string", enum: ["task_assignee"] },
                  taskId: { type: "integer" },
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
      const { renderTemplate } = await import("../shared/template");
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
      "[ACTION/v2] Tạo project mới. Required: name + ownerId. Optional: " +
      "description, endDate, priority. priority mặc định MEDIUM; endDate có thể bỏ trống. " +
      "Confirm với user TRƯỚC khi gọi.",
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
      "[ACTION/v2] Nhắc assignee về một task (to.kind='task_assignee'): " +
      "resolve assignee → gửi qua send_follow_up (cooldown 24h, log follow_up). " +
      "SAFETY: LUÔN confirm trước khi send (mô tả 'sẽ gửi cho ai, nội dung gì' rồi đợi user OK).",
    parameters: {
      type: "object",
      properties: {
        to: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["task_assignee"] },
            taskId: { type: "integer", description: "Khi kind=task_assignee." },
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

  reportQueryTool,

  // ── AUTOMATION (Phase 4 — real impl) ──────────────────────────────
  {
    name: "automation.create",
    description:
      "[AUTOMATION/v2] Đăng ký workflow recurring. Persist vào DB; cron " +
      "registration ở next gateway boot (Phase 4 MVP — Phase 4.1 sẽ hot-register). " +
      "Workflow names khả dụng: daily_digest, weekly_report, hygiene_check, role_based_digest, " +
      "noon_checkin_reminder, eod_checkin_reminder, missing_checkin_followup. " +
      "Schedule: cron expression (vd '0 9 * * *' = 9h sáng mỗi ngày). " +
      "Target: Gapo cid (vd 'collab:7001341214635140096' hoặc 'dm:<cid>'). " +
      "Limit: max 50 active per company.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Tên hiển thị (vd 'Daily digest cho group Bluebolt')." },
        schedule: { type: "string", description: "Cron expression (5 fields)." },
        workflow: {
          type: "string",
          enum: [
            "daily_digest",
            "weekly_report",
            "hygiene_check",
            "role_based_digest",
            "noon_checkin_reminder",
            "eod_checkin_reminder",
            "missing_checkin_followup",
          ],
        },
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
      "weekly_report, hygiene_check, role_based_digest, noon_checkin_reminder, eod_checkin_reminder, " +
      "missing_checkin_followup. Inputs tùy workflow. Target = Gapo cid để push " +
      "output (bắt buộc nếu workflow gửi message). Confirm trước khi chạy nếu " +
      "workflow gửi message ra channel.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          enum: [
            "daily_digest",
            "weekly_report",
            "hygiene_check",
            "role_based_digest",
            "noon_checkin_reminder",
            "eod_checkin_reminder",
            "missing_checkin_followup",
          ],
        },
        inputs: { type: "object", description: "Workflow-specific args." },
        target: { type: "string", description: "Gapo cid để push (vd 'collab:7001...')." },
      },
      required: ["name"],
    },
    handler: async (args: { name: string; inputs?: any; target?: string }) => {
      const { runWorkflow } = await import("../workflows/registry");
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
