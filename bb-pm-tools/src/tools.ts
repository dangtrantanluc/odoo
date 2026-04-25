import { bbPm } from "./api-client";
import { cooldown } from "./cooldown";
import { sendToGapo } from "./channel-out";
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
    description: "Find user by name or email. Use for 'tìm người dùng X', 'find user X'.",
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
    name: "search_tasks",
    description:
      "Search tasks by keyword. Use for 'tìm kiếm task với từ khóa X', 'search tasks with keyword X'.",
    parameters: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "Keyword to search in task names." },
        limit: { type: "integer", default: 50 },
      },
      required: ["keyword"],
    },
    handler: async (args: { keyword: string; limit?: number }) => {
      const keyword = requireString(args.keyword, "keyword");
      const res = await bbPm.searchTasks(keyword, args.limit ?? 50);
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
            "Vietnamese, <=200 chars, polite. Must reference the task name or id " +
            "so the recipient has context. Examples: 'Chào A, task WR-12 Dashboard " +
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
      let threadId: string;
      try {
        const res = await bbPm.getGapoThread(args.userId);
        threadId = res.data.gapoThreadId;
      } catch (err: any) {
        if (/404/.test(err?.message || "")) {
          return { skipped: "no_gapo_thread" };
        }
        throw err;
      }
      await sendToGapo(threadId, question);
      await cooldown.mark(key);
      let followUpId: number | undefined;
      try {
        const rec = await bbPm.recordFollowUp({
          taskId: args.taskId,
          userId: args.userId,
          channel: "gapo",
          threadId,
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
];

export const toolsByName = new Map(tools.map((t) => [t.name, t]));

export function toolCatalog() {
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}
