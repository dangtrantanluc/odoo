import fetch from "node-fetch";
import { config } from "./config";

export type ProjectRef = { id: number; name: string; code: string };
export type UserRef = { id: number; fullName: string; email?: string };

export type OverdueTask = {
  id: number;
  name: string;
  status: string;
  priority: string;
  deadline: string | null;
  daysOverdue: number | null;
  project: ProjectRef;
  assignee: UserRef | null;
};

export type StaleTask = {
  id: number;
  name: string;
  status: string;
  priority: string;
  updatedAt: string;
  daysSinceUpdate: number;
  project: ProjectRef;
  assignee: UserRef | null;
};

export type HygieneIssue = {
  id: number;
  name: string;
  status: string;
  project: ProjectRef;
  assignee: UserRef | null;
  deadline: string | null;
  updatedAt: string;
};

export type Digest = {
  generatedAt: string;
  totals: {
    activeProjects: number;
    openTasks: number;
    overdueTasks: number;
    staleTasks: number;
    unassignedTasks: number;
  };
  projects: Array<{
    id: number;
    name: string;
    code: string;
    status: string;
    completionPct: number | null;
    taskCount: number;
    doneTaskCount: number;
    endDate: string | null;
  }>;
};

export type TaskListItem = {
  id: number;
  name: string;
  status: string;
  priority: string;
  deadline: string | null;
  updatedAt: string;
  project: ProjectRef | null;
  assignee: UserRef | null;
};

export type ProjectListItem = {
  id: number;
  name: string;
  code: string;
  status: string;
};

export type RoleBasedDigest = {
  generatedAt: string;
  recipient: {
    id: number;
    fullName: string;
    email: string;
    role: "ADMIN" | "MANAGER" | "MEMBER" | "VIEWER";
    companyId: number;
    isSuperAdmin: boolean;
  };
  options: {
    include: string[];
    detailLevel: "brief" | "normal" | "detailed";
    daysAhead: number;
    staleDays: number;
    requestedProjectIds: number[] | null;
  };
  scope: { projectIds: number[]; projectCount: number };
  overview: {
    activeProjects: number;
    openTasks: number;
    overdueTasks: number;
    upcomingTasks: number;
    blockedTasks: number;
    staleTasks: number;
    pendingBacklogs: number;
  };
  projects: Array<{
    id: number;
    name: string;
    code: string | null;
    status: string;
    endDate: string | null;
    taskCount: number;
    doneTaskCount: number;
    completionPct: number | null;
    totalHours: number;
    totalCost: number;
    budget: number | null;
    budgetRemaining: number | null;
  }>;
  overdue: Array<TaskListItem & { daysOverdue: number | null; daysSinceUpdate: number }>;
  upcoming: Array<TaskListItem & { daysOverdue: number | null; daysSinceUpdate: number }>;
  stale: Array<TaskListItem & { daysOverdue: number | null; daysSinceUpdate: number }>;
  blocked: Array<{
    id: number;
    severity: string;
    description: string;
    createdAt: string;
    task: TaskListItem & { daysOverdue: number | null; daysSinceUpdate: number };
  }>;
  pendingBacklogs: Array<{
    id: number;
    workDate: string;
    hours: number;
    project: ProjectRef | null;
    task: { id: number; name: string };
    user: { id: number; fullName: string };
  }>;
  hygiene: {
    missingOwner: Array<TaskListItem & { daysOverdue: number | null; daysSinceUpdate: number }>;
    missingDeadline: Array<TaskListItem & { daysOverdue: number | null; daysSinceUpdate: number }>;
    stale: Array<TaskListItem & { daysOverdue: number | null; daysSinceUpdate: number }>;
  };
  milestones: Array<{
    id: number;
    name: string;
    status: string | null;
    dueDate: string | null;
    taskCount: number;
    doneCount: number;
    completionPct: number;
    project: ProjectRef;
  }>;
};

type Query = Record<string, string | number | boolean | undefined | null>;

class BbPmClient {
  private async request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    query?: Query,
    body?: unknown,
  ): Promise<T> {
    const url = new URL(config.bbPmApi.baseUrl.replace(/\/$/, "") + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    const res = await fetch(url.toString(), {
      method,
      headers: {
        "X-Agent-Token": config.bbPmApi.agentToken,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`bb-pm API ${res.status} ${method} ${path}: ${text}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private get<T>(path: string, query?: Query) {
    return this.request<T>("GET", path, query);
  }
  private post<T>(path: string, body?: unknown) {
    return this.request<T>("POST", path, undefined, body);
  }
  private patch<T>(path: string, body?: unknown) {
    return this.request<T>("PATCH", path, undefined, body);
  }
  private delete<T>(path: string) {
    return this.request<T>("DELETE", path);
  }

  // ── Daily scan / hygiene ──────────────────────────
  listOverdueTasks(args: { projectId?: number; days?: number; limit?: number }) {
    return this.get<{ data: OverdueTask[]; meta: { total: number; cutoff: string } }>(
      "/tasks/overdue",
      { projectId: args.projectId, days: args.days ?? 0, limit: args.limit ?? 50 },
    );
  }

  listStaleTasks(args: { projectId?: number; daysSinceUpdate?: number; limit?: number }) {
    return this.get<{ data: StaleTask[]; meta: { total: number; cutoff: string } }>(
      "/tasks/stale",
      {
        projectId: args.projectId,
        daysSinceUpdate: args.daysSinceUpdate ?? 7,
        limit: args.limit ?? 50,
      },
    );
  }

  checkHygiene(args: { projectId?: number; staleDays?: number }) {
    return this.get<{
      data: {
        missingOwner: HygieneIssue[];
        missingDeadline: HygieneIssue[];
        staleStatus: HygieneIssue[];
      };
      meta: { total: number; staleCutoff: string };
    }>("/tasks/hygiene", { projectId: args.projectId, staleDays: args.staleDays ?? 14 });
  }

  digest() {
    return this.get<{ data: Digest }>("/projects/digest");
  }

  roleBasedDigest(args: {
    userId: number;
    projectIds?: number[];
    include?: string[];
    detailLevel?: "brief" | "normal" | "detailed";
    daysAhead?: number;
    staleDays?: number;
  }) {
    return this.get<{ data: RoleBasedDigest }>("/agent/digests/role-based", {
      userId: args.userId,
      projectIds: args.projectIds?.join(","),
      include: args.include?.join(","),
      detailLevel: args.detailLevel,
      daysAhead: args.daysAhead,
      staleDays: args.staleDays,
    });
  }

  // ── Project / task fetch ──────────────────────────
  // Backend has no /projects/:id/snapshot — compose from project detail + task list.
  async projectSnapshot(projectId: number) {
    type ProjectDetail = {
      data: { id: number; name: string; code: string; status: string; endDate: string | null };
    };
    type TaskList = { data: TaskListItem[]; meta: { total: number } };

    const [proj, tasks] = await Promise.all([
      this.get<ProjectDetail>(`/projects/${projectId}`),
      this.get<TaskList>("/tasks", { projectId, pageSize: 200 }),
    ]);
    const p = proj.data;
    return {
      data: {
        id: p.id,
        name: p.name,
        code: p.code,
        status: p.status,
        endDate: p.endDate,
        tasks: tasks.data.map((t) => ({
          id: t.id,
          name: t.name,
          status: t.status,
          priority: t.priority,
          deadline: t.deadline,
          assignee: t.assignee,
          updatedAt: t.updatedAt,
        })),
      },
    };
  }

  // ── Task ops ──────────────────────────────────────
  listBlockedTasks(projectId: number, limit = 50) {
    return this.get<{ data: TaskListItem[]; meta: { total: number } }>("/tasks", {
      projectId,
      status: "BLOCKED",
      pageSize: limit,
    });
  }

  async getTaskOwner(taskId: number) {
    type T = { data: { id: number; assignee: UserRef | null } };
    const res = await this.get<T>(`/tasks/${taskId}`);
    return { data: { taskId: res.data.id, owner: res.data.assignee } };
  }

  updateTaskStatus(taskId: number, status: string) {
    return this.post<{ data: { id: number; status: string } }>(
      `/tasks/${taskId}/transition`,
      { status },
    );
  }

  createActionItem(args: {
    projectId: number;
    name: string;
    assigneeId?: number;
    deadline?: string;
  }) {
    return this.post<{ data: { id: number } }>(`/tasks/by-project/${args.projectId}`, {
      name: args.name,
      assigneeId: args.assigneeId,
      deadline: args.deadline,
    });
  }

  // ── Search / find ─────────────────────────────────
  searchProjects(keyword: string, limit = 50) {
    return this.get<{ data: ProjectListItem[]; meta: { total: number } }>("/projects", {
      q: keyword,
      pageSize: limit,
    });
  }
  findProject(name: string) {
    return this.searchProjects(name, 10);
  }

  // 2026-05-07 — Extended với assigneeId/status/projectId. System prompt
  // advertise filter (assignee, status, project, keyword) nhưng tool cũ chỉ
  // nhận keyword → LLM call search_tasks(keyword="Lực") để tìm task của Lực,
  // 0 hit vì keyword search task NAME, không phải assignee. Real bug, không
  // phải LLM-specific.
  searchTasks(args: {
    keyword?: string;
    assigneeId?: number;
    projectId?: number;
    status?: string;
    limit?: number;
  } | string, legacyLimit?: number) {
    // Backward-compat: searchTasks(keyword, limit?) signature cũ.
    const params: Record<string, string | number> = {};
    if (typeof args === "string") {
      if (args) params.q = args;
      params.pageSize = legacyLimit ?? 50;
    } else {
      if (args.keyword) params.q = args.keyword;
      if (args.assigneeId) params.assigneeId = args.assigneeId;
      if (args.projectId) params.projectId = args.projectId;
      if (args.status) params.status = args.status;
      params.pageSize = args.limit ?? 50;
    }
    return this.get<{ data: TaskListItem[]; meta: { total: number } }>("/tasks", params);
  }
  findTask(name: string) {
    return this.searchTasks(name, 10);
  }

  // /users has no q param and the agent (MANAGER) cannot hit /admin/users — filter client-side.
  async findUser(name: string) {
    type Users = {
      data: Array<{ id: number; fullName: string; email: string; role: string }>;
    };
    const res = await this.get<Users>("/users");
    const needle = name.trim().toLowerCase();
    const filtered = res.data.filter(
      (u) =>
        u.fullName.toLowerCase().includes(needle) ||
        u.email.toLowerCase().includes(needle),
    );
    return {
      data: filtered.map((u) => ({ id: u.id, name: u.fullName, email: u.email })),
    };
  }

  // ── Audit ─────────────────────────────────────────
  postAudit(entry: {
    tool: string;
    argsJson: unknown;
    resultJson?: unknown;
    errorMessage?: string;
    durationMs?: number;
    correlationId?: string;
    source?: "chat" | "cron" | "cli" | "other";
  }) {
    return this.post<{ data: { id: number } }>("/agent/audit", entry);
  }

  // Sprint 8 follow-up — retention sweep. Scheduler gọi daily (3 AM ICT).
  // Trả về { deletedCount, cutoff }. dryRun=true để preview.
  cleanupAudit(days: number = 90, dryRun: boolean = false) {
    return this.post<{
      data: { deletedCount: number; cutoff: string; dryRun: boolean; wouldDelete?: number };
    }>("/agent/audit/cleanup", { days, dryRun });
  }

  // ── Tasks: assignment ─────────────────────────────
  updateTaskAssignee(taskId: number, assigneeId: number) {
    return this.patch<{ data: { id: number; assigneeId: number; name: string } }>(
      `/tasks/${taskId}`,
      { assigneeId },
    );
  }

  // Full task patch (v2 — task.update). Accepts any subset of taskUpdateSchema.
  // Note: status changes here BYPASS transition validation. For status, prefer
  // updateTaskStatus() which goes through /transition.
  patchTask(taskId: number, patch: {
    name?: string;
    priority?: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
    deadline?: string;          // YYYY-MM-DD
    endAt?: string;             // YYYY-MM-DD
    description?: string;
    result?: string;
    issues?: string;
    assigneeId?: number;
    milestoneId?: number;
  }) {
    return this.patch<{ data: { id: number } }>(`/tasks/${taskId}`, patch);
  }

  // ── Phase 4: Automation CRUD ──────────────────────
  createAutomation(body: {
    name: string;
    workflow: string;
    schedule: string;
    inputs?: Record<string, any>;
    target?: string;
    ownerId?: number;
  }): Promise<{ data: { id: number; name: string; workflow: string; schedule: string; active: boolean } }> {
    return this.post("/agent/automations", body);
  }

  listAutomations(args: { active?: boolean; ownerId?: number; limit?: number } = {}): Promise<{
    data: Array<{
      id: number;
      name: string;
      workflow: string;
      schedule: string;
      inputs: Record<string, any>;
      target: string | null;
      active: boolean;
      lastRunAt: string | null;
      lastRunStatus: string | null;
      lastRunError: string | null;
      consecutiveFails: number;
    }>;
    meta: { total: number };
  }> {
    return this.get("/agent/automations", args as any);
  }

  deleteAutomation(id: number): Promise<void> {
    return this.delete<void>(`/agent/automations/${id}`);
  }

  patchAutomation(id: number, body: {
    active?: boolean;
    lastRunAt?: string;
    lastRunStatus?: "ok" | "error";
    lastRunError?: string | null;
    consecutiveFails?: number;
  }): Promise<{ data: any }> {
    return this.patch(`/agent/automations/${id}`, body);
  }

  // ── Phase 1: Report SQL gateway ───────────────────
  fetchSchemaDoc(): Promise<{ data: { schema: string; generatedAt: string } }> {
    return this.get("/agent/report/schema");
  }

  reportQueryRaw(sql: string): Promise<{
    data: {
      rows: any[];
      rowCount: number;
      truncated: boolean;
      sqlExecuted: string;
      warnings: string[];
      durationMs: number;
    };
  }> {
    return this.post("/agent/report/query", { sql });
  }

  // Project full patch (v2 — project.update).
  patchProject(projectId: number, patch: {
    name?: string;
    code?: string;
    priority?: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
    startDate?: string;
    endDate?: string;
    description?: string;
    ownerId?: number;
    estimatedTotalHours?: number;
  }) {
    return this.patch<{ data: { id: number } }>(`/projects/${projectId}`, patch);
  }

  // ── Users: workload listing ──────────────────────
  listUsersWithWorkload(params: { department?: string; role?: string; limit?: number } = {}) {
    const q = new URLSearchParams();
    if (params.department) q.set("department", params.department);
    if (params.role) q.set("role", params.role);
    if (params.limit) q.set("limit", String(params.limit));
    return this.get<{
      data: Array<{
        id: number;
        fullName: string;
        role: string;
        department: string | null;
        position: string | null;
        openTasks: number;
      }>;
    }>(`/agent/users-workload${q.toString() ? "?" + q.toString() : ""}`);
  }

  // ── Projects: create ─────────────────────────────
  createProject(input: {
    name: string;
    code?: string;
    priority?: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
    startDate?: string;     // YYYY-MM-DD
    endDate?: string;       // YYYY-MM-DD
    description?: string;
    ownerId: number;
    estimatedTotalHours?: number;
  }) {
    return this.post<{ data: { id: number; name: string; code: string | null; ownerId: number } }>(
      "/projects",
      input,
    );
  }

  // ── Agent: Gapo thread lookup ─────────────────────
  getGapoThread(userId: number) {
    return this.get<{
      data: {
        userId: number;
        gapoUserId: string;
        gapoThreadId: string;
        gapoFullName: string | null;
      };
    }>(`/agent/gapo-thread/${userId}`);
  }

  // Reverse lookup: Gapo conversation id → bb-pm user. Returns null if
  // no mapping exists (caller is a stranger or import didn't include them).
  async getUserByGapoCid(externalId: string): Promise<{
    id: number; email: string; fullName: string; role: string; active: boolean;
  } | null> {
    try {
      const res = await this.get<{
        data: {
          user: { id: number; email: string; fullName: string; role: string; active: boolean };
        };
      }>(`/agent/user-by-channel?channel=gapo&externalId=${encodeURIComponent(externalId)}`);
      return res.data.user;
    } catch (err: any) {
      if (/404/.test(err?.message || "")) return null;
      throw err;
    }
  }

  // ── Agent: Blocker ────────────────────────────────
  postBlocker(taskId: number, body: { description: string; severity: "LOW" | "MED" | "HIGH" }) {
    return this.post<{
      data: { taskId: number; blockerId: number; severity: string; createdAt: string };
    }>(`/tasks/${taskId}/blocker`, body);
  }

  // ── Agent: Memory (Sprint 4) ──────────────────────
  postMemory(body: {
    conversationId?: string;
    source?: "chat" | "cron" | "cli" | "other";
    userText: string;
    replyText: string;
    summary: string;
    toolsUsed?: string[];
    projectIds?: number[];
    taskIds?: number[];
    correlationId?: string;
  }) {
    return this.post<{ data: { id: number; createdAt: string } }>("/agent/memory", body);
  }

  searchMemory(args: {
    q?: string;
    projectId?: number;
    taskId?: number;
    conversationId?: string;
    daysBack?: number;
    limit?: number;
  }) {
    return this.get<{
      data: Array<{
        id: number;
        createdAt: string;
        conversationId: string | null;
        source: string;
        userText: string;
        summary: string;
        toolsUsed: string[];
        projectIds: number[];
        taskIds: number[];
      }>;
      meta: { total: number; cutoff: string };
    }>("/agent/memory/search", args);
  }

  // ── Meetings (Sprint 5) ───────────────────────────
  createMeeting(body: {
    title?: string;
    heldAt?: string;
    transcript: string;
    summary?: string;
    decisions?: string[];
    participants?: string[];
    projectId?: number;
    items?: Array<{
      title: string;
      description?: string;
      ownerName?: string;
      dueDate?: string;
      priority?: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
    }>;
  }) {
    return this.post<{
      data: {
        id: number;
        title: string | null;
        heldAt: string;
        projectId: number | null;
        summary: string | null;
        decisions: string[];
        participants: string[];
        items: Array<{
          id: number;
          title: string;
          description: string | null;
          ownerName: string | null;
          ownerUserId: number | null;
          dueDate: string | null;
          priority: string;
          status: string;
          createdTaskId: number | null;
        }>;
      };
    }>("/meetings", body);
  }

  getMeeting(id: number) {
    return this.get<{ data: any }>(`/meetings/${id}`);
  }

  approveMeetingItems(meetingId: number, body: { itemIds: number[]; defaultProjectId?: number }) {
    return this.post<{
      data: {
        meetingId: number;
        projectId: number;
        created: Array<{ itemId: number; taskId: number }>;
        skipped: Array<{ itemId: number; reason: string }>;
      };
    }>(`/meetings/${meetingId}/approve`, body);
  }

  rejectMeetingItems(meetingId: number, body: { itemIds: number[] }) {
    return this.post<{ data: { rejected: number } }>(`/meetings/${meetingId}/reject`, body);
  }

  // ── Agent: Follow-up tracking (Sprint 6.2) ────────
  recordFollowUp(body: {
    taskId: number;
    userId: number;
    channel?: "gapo" | "slack" | "zalo" | "zalouser" | "telegram" | "email" | "sms";
    threadId?: string;
    question: string;
    correlationId?: string;
  }) {
    return this.post<{ data: { id: number; askedAt: string; status: string } }>(
      "/agent/follow-up",
      body,
    );
  }

  listFollowUps(args: {
    userId?: number;
    taskId?: number;
    status?: "PENDING" | "REPLIED" | "EXPIRED" | "CANCELLED";
    daysBack?: number;
    limit?: number;
  } = {}) {
    return this.get<{
      data: Array<{
        id: number;
        taskId: number;
        userId: number;
        channel: string;
        threadId: string | null;
        question: string;
        status: string;
        askedAt: string;
        repliedAt: string | null;
        replyText: string | null;
        task: {
          id: number;
          name: string;
          status: string;
          project: { id: number; name: string; code: string } | null;
        };
        user: { id: number; fullName: string; email: string };
      }>;
      meta: { total: number; cutoff: string };
    }>("/agent/follow-ups", args);
  }

  patchFollowUp(id: number, body: { status: "PENDING" | "REPLIED" | "EXPIRED" | "CANCELLED"; replyText?: string }) {
    return this.patch<{
      data: { id: number; status: string; repliedAt: string | null; replyText: string | null };
    }>(`/agent/follow-up/${id}`, body);
  }

  // ── Weekly report ─────────────────────────────────
  weeklyReport(args: { days?: number; projectId?: number } = {}) {
    return this.get<{
      data: {
        generatedAt: string;
        window: { start: string; end: string; days: number };
        totals: {
          activeProjects: number;
          newTasks: number;
          tasksDone: number;
          newBlockers: number;
          backlogsApproved: number;
          hoursApproved: number;
          costApproved: number;
        };
        projects: Array<{
          id: number;
          name: string;
          code: string;
          status: string;
          endDate: string | null;
          taskCount: number;
          doneTaskCount: number;
          completionPct: number | null;
          totalHours: number;
          totalCost: number;
        }>;
        upcomingDeadlines: Array<{
          id: number;
          name: string;
          deadline: string | null;
          priority: string;
          project: { id: number; name: string; code: string } | null;
          assignee: { id: number; fullName: string } | null;
        }>;
      };
    }>("/projects/weekly-report", args);
  }
}

export const bbPm = new BbPmClient();
