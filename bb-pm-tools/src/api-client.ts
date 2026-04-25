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

  searchTasks(keyword: string, limit = 50) {
    return this.get<{ data: TaskListItem[]; meta: { total: number } }>("/tasks", {
      q: keyword,
      pageSize: limit,
    });
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
