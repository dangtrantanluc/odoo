import { bbPm, TaskListItem } from "../../infrastructure/api-client";
import { toolsByName } from "../../tools";
import type { AgentContext } from "../../shared/types";
import { normalizeVietnameseText } from "../../shared/text";

export type ActionTurnResult = { reply: string; pattern: string };
type ProjectPriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";
type PendingAction =
  | { kind: "deadline"; taskId: number; taskName: string; deadline: string }
  | { kind: "assign"; taskId: number; taskName: string; assigneeId: number; assigneeName: string }
  | { kind: "status"; taskId: number; taskName: string; status: "DONE" | "REVIEW" }
  | { kind: "create"; projectId: number; projectName: string; name: string }
  | { kind: "message"; recipientQuery: string; text: string };
type ProjectDraft = {
  name?: string;
  description?: string;
  endDate?: string;
  priority: ProjectPriority;
  ownerId: number;
};
type PendingProjectCreate = {
  draft: ProjectDraft;
  state: "awaiting_name" | "awaiting_duplicate_decision" | "awaiting_confirm";
  duplicateNames?: string[];
  expiresAt: number;
};
const pending = new Map<string, { action: PendingAction; expiresAt: number }>();
const pendingProjectCreates = new Map<string, PendingProjectCreate>();
const TTL_MS = 10 * 60_000;

export async function handleActionTurn(text: string, ctx: AgentContext): Promise<ActionTurnResult | null> {
  const key = ctx.conversationId;
  if (!key) return null;
  prune();
  const normalized = text.trim().toLowerCase();
  const projectCreate = pendingProjectCreates.get(key);
  if (projectCreate) {
    return await continueProjectCreate(key, text, projectCreate);
  }
  const existing = pending.get(key);
  if (existing && /^(ok|đúng|dung|confirm|xác nhận|xac nhan)$/iu.test(normalized)) {
    pending.delete(key);
    return execute(existing.action);
  }
  if (existing && /^(hủy|huy|cancel|không|khong)$/iu.test(normalized)) {
    pending.delete(key);
    return { reply: "Đã hủy thay đổi.", pattern: "action:cancel" };
  }

  const deadline = text.match(/^\s*(?:đổi|doi|dời|doi)\s+deadline\s+task\s+(.+?)\s+sang\s+(\d{4}-\d{2}-\d{2})\s*$/iu);
  if (deadline) return previewTaskAction(key, deadline[1], (task) => ({ kind: "deadline", taskId: task.id, taskName: task.name, deadline: deadline[2] }), (a) => `Sẽ đổi deadline task "${a.taskName}" sang ${a.deadline}. Gõ "ok" để xác nhận.`);

  const assign = text.match(/^\s*(?:assign|giao)\s+task\s+(.+?)\s+cho\s+(.+?)\s*$/iu);
  if (assign) {
    const task = await resolveTask(assign[1]);
    if (typeof task === "string") return { reply: task, pattern: "action:assign:clarify_task" };
    const users = (await bbPm.findUser(assign[2])).data;
    if (!users.length) return { reply: `Không thấy người dùng "${assign[2].trim()}".`, pattern: "action:assign:no_user" };
    if (users.length > 1) return { reply: `Có nhiều người khớp tên này: ${users.slice(0, 3).map((u: any) => u.name).join(" · ")}.`, pattern: "action:assign:ambiguous_user" };
    const u: any = users[0];
    const action: PendingAction = { kind: "assign", taskId: task.id, taskName: task.name, assigneeId: u.id, assigneeName: u.name };
    save(key, action);
    return { reply: `Sẽ giao task "${task.name}" cho ${u.name}. Gõ "ok" để xác nhận.`, pattern: "action:assign:preview" };
  }

  const status = text.match(/^\s*(?:đánh dấu|danh dau|set)\s+task\s+(.+?)\s+(done|review)\s*$/iu);
  if (status) return previewTaskAction(key, status[1], (task) => ({ kind: "status", taskId: task.id, taskName: task.name, status: status[2].toUpperCase() as "DONE" | "REVIEW" }), (a) => `Sẽ chuyển task "${a.taskName}" sang ${a.status}. Gõ "ok" để xác nhận.`);

  const create = text.match(/^\s*tạo\s+task\s+(.+?)\s+(?:trong|cho)\s+(?:project|dự án)\s+(.+?)\s*$/iu);
  if (create) {
    const projects = (await bbPm.findProject(create[2])).data;
    if (!projects.length) return { reply: `Không thấy dự án "${create[2].trim()}".`, pattern: "action:create:no_project" };
    if (projects.length > 1) return { reply: `Có nhiều dự án khớp tên này: ${projects.slice(0, 3).map((p) => p.name).join(" · ")}.`, pattern: "action:create:ambiguous_project" };
    const p = projects[0];
    const action: PendingAction = { kind: "create", projectId: p.id, projectName: p.name, name: create[1].trim() };
    save(key, action);
    return { reply: `Sẽ tạo task "${action.name}" trong ${p.name}. Gõ "ok" để xác nhận.`, pattern: "action:create:preview" };
  }

  const message = text.match(/^\s*(?:nhắn|nhan|gửi\s+tin|gui\s+tin)\s+cho\s+(.+?)\s+(?:hỏi|hoi)\s+(.+?)\s*$/iu);
  if (message) {
    const action: PendingAction = { kind: "message", recipientQuery: message[1].trim(), text: message[2].trim() };
    save(key, action);
    return { reply: `Sẽ nhắn cho ${action.recipientQuery}: "${action.text}". Gõ "ok" để xác nhận.`, pattern: "action:message:preview" };
  }

  const draft = parseProjectCreate(text, ctx.callerUserId);
  if (draft) return await startProjectCreate(key, draft);
  return null;
}

async function previewTaskAction<T extends PendingAction>(key: string, query: string, build: (task: TaskListItem) => T, preview: (a: T) => string): Promise<ActionTurnResult> {
  const task = await resolveTask(query);
  if (typeof task === "string") return { reply: task, pattern: "action:task:clarify" };
  const action = build(task);
  save(key, action);
  return { reply: preview(action), pattern: `action:${action.kind}:preview` };
}
async function resolveTask(query: string): Promise<TaskListItem | string> {
  const rows = (await bbPm.findTask(query.trim())).data;
  if (!rows.length) return `Không thấy task "${query.trim()}".`;
  if (rows.length > 1) return `Có nhiều task khớp tên này: ${rows.slice(0, 3).map((t) => t.name).join(" · ")}.`;
  return rows[0];
}
function save(key: string, action: PendingAction) { pending.set(key, { action, expiresAt: Date.now() + TTL_MS }); }
function prune() {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expiresAt < now) pending.delete(k);
  for (const [k, v] of pendingProjectCreates) if (v.expiresAt < now) pendingProjectCreates.delete(k);
}
async function execute(action: PendingAction): Promise<ActionTurnResult> {
  if (action.kind === "deadline") { await bbPm.patchTask(action.taskId, { deadline: action.deadline }); return { reply: `Đã đổi deadline task "${action.taskName}" sang ${action.deadline}.`, pattern: "action:deadline:done" }; }
  if (action.kind === "assign") { await bbPm.patchTask(action.taskId, { assigneeId: action.assigneeId }); return { reply: `Đã giao task "${action.taskName}" cho ${action.assigneeName}.`, pattern: "action:assign:done" }; }
  if (action.kind === "status") { await bbPm.updateTaskStatus(action.taskId, action.status); return { reply: `Đã chuyển task "${action.taskName}" sang ${action.status}.`, pattern: "action:status:done" }; }
  if (action.kind === "message") {
    const sender = toolsByName.get("message.send");
    if (!sender) return { reply: "Hiện chưa gửi được tin nhắn vì công cụ nhắn tin chưa sẵn sàng.", pattern: "action:message:unavailable" };
    try {
      const result: any = await sender.handler({ to: { kind: "gapo_query", query: action.recipientQuery }, text: action.text });
      if (result?.sent) return { reply: `Đã nhắn cho ${result.name || action.recipientQuery}.`, pattern: "action:message:done" };
      if (result?.reason === "user_not_found") return { reply: `Không tìm thấy ${action.recipientQuery} trên Gapo.`, pattern: "action:message:not_found" };
      return { reply: `Chưa gửi được tin cho ${action.recipientQuery}; luồng nhắn tin đang lỗi tạm thời.`, pattern: "action:message:failed" };
    } catch {
      return { reply: `Chưa gửi được tin cho ${action.recipientQuery}; luồng nhắn tin đang lỗi tạm thời.`, pattern: "action:message:failed" };
    }
  }
  await bbPm.createActionItem({ projectId: action.projectId, name: action.name });
  return { reply: `Đã tạo task "${action.name}" trong ${action.projectName}.`, pattern: "action:create:done" };
}
function parseProjectCreate(text: string, ownerId?: number): ProjectDraft | null {
  if (!ownerId) return null;
  const match = text.match(/^\s*(?:(?:tôi|toi|mình|minh)\s+muốn\s+)?(?:tạo|tao)\s+(?:một\s+)?project(?:\s+mới)?(?:\s+(.+))?\s*$/iu);
  if (!match) return null;
  const rest = (match[1] ?? "").trim();
  const draft: ProjectDraft = { priority: parsePriority(rest) ?? "MEDIUM", ownerId };
  const endDate = rest.match(/\b(?:deadline|hạn|han)\s+(\d{4}-\d{2}-\d{2})\b/iu)?.[1];
  const description = rest.match(/\b(?:mô\s*tả|mo\s*ta|description)\s+(.+?)(?=,\s*(?:deadline|hạn|han|priority|ưu\s*tiên|uu\s*tien)\b|$)/iu)?.[1]?.trim();
  const quotedName = rest.match(/["“'](.+?)["”']/u)?.[1]?.trim();
  const namePart = rest
    .replace(/\b(?:mô\s*tả|mo\s*ta|description)\s+.+?(?=,\s*(?:deadline|hạn|han|priority|ưu\s*tiên|uu\s*tien)\b|$)/iu, "")
    .replace(/\b(?:deadline|hạn|han)\s+\d{4}-\d{2}-\d{2}\b/iu, "")
    .replace(/\b(?:priority|ưu\s*tiên|uu\s*tien)\s+(low|medium|high|urgent)\b/iu, "")
    .replace(/^mới\b/iu, "")
    .replace(/^[\s,:-]+|[\s,:-]+$/g, "")
    .trim();
  const name = quotedName || (namePart && !/^mới$/iu.test(namePart) ? namePart : undefined);
  if (name) draft.name = name;
  if (description) draft.description = description;
  if (endDate) draft.endDate = endDate;
  return draft;
}

function parsePriority(text: string): ProjectPriority | null {
  const raw = text.match(/\b(?:priority|ưu\s*tiên|uu\s*tien)\s+(low|medium|high|urgent)\b/iu)?.[1]?.toUpperCase();
  return raw && ["LOW", "MEDIUM", "HIGH", "URGENT"].includes(raw) ? raw as ProjectPriority : null;
}

async function startProjectCreate(key: string, draft: ProjectDraft): Promise<ActionTurnResult> {
  if (!draft.name) {
    pendingProjectCreates.set(key, { draft, state: "awaiting_name", expiresAt: Date.now() + TTL_MS });
    return { reply: "Tên project là gì?", pattern: "action:project_create:ask_name" };
  }
  return await validateProjectDraft(key, draft);
}

async function continueProjectCreate(
  key: string,
  text: string,
  pendingDraft: PendingProjectCreate,
): Promise<ActionTurnResult> {
  const normalized = normalize(text);
  if (/^(huy|cancel|khong)$/u.test(normalized)) {
    pendingProjectCreates.delete(key);
    return { reply: "Đã hủy tạo project.", pattern: "action:project_create:cancel" };
  }
  if (pendingDraft.state === "awaiting_name") {
    const name = text.trim();
    if (!name) return { reply: "Tên project là gì?", pattern: "action:project_create:ask_name" };
    return await validateProjectDraft(key, { ...pendingDraft.draft, name });
  }
  if (pendingDraft.state === "awaiting_duplicate_decision") {
    if (/^(tao moi|van tao|tao)$/u.test(normalized)) {
      return previewProjectDraft(key, pendingDraft.draft);
    }
    if (/^(dung cu|dung project cu)$/u.test(normalized)) {
      pendingProjectCreates.delete(key);
      return { reply: "Đã dừng tạo project mới.", pattern: "action:project_create:use_existing" };
    }
    return {
      reply: `Có project gần giống: ${pendingDraft.duplicateNames?.join(" · ")}. Gõ "tạo mới" để tiếp tục hoặc "dùng cũ" để dừng.`,
      pattern: "action:project_create:duplicate_clarify",
    };
  }
  if (/^(ok|dung|confirm|xac nhan)$/u.test(normalized)) {
    pendingProjectCreates.delete(key);
    return await executeProjectCreate(pendingDraft.draft);
  }
  return { reply: `${projectPreview(pendingDraft.draft)} Gõ "ok" để xác nhận hoặc "hủy" để dừng.`, pattern: "action:project_create:confirm" };
}

async function validateProjectDraft(key: string, draft: ProjectDraft): Promise<ActionTurnResult> {
  const matches = (await bbPm.findProject(draft.name!)).data
    .filter((p) => isSimilarProjectName(p.name, draft.name!));
  if (matches.length) {
    const duplicateNames = matches.slice(0, 3).map((p) => p.name);
    pendingProjectCreates.set(key, { draft, state: "awaiting_duplicate_decision", duplicateNames, expiresAt: Date.now() + TTL_MS });
    return { reply: `Có project gần giống: ${duplicateNames.join(" · ")}. Gõ "tạo mới" để tiếp tục hoặc "dùng cũ" để dừng.`, pattern: "action:project_create:duplicate" };
  }
  return previewProjectDraft(key, draft);
}

function previewProjectDraft(key: string, draft: ProjectDraft): ActionTurnResult {
  pendingProjectCreates.set(key, { draft, state: "awaiting_confirm", expiresAt: Date.now() + TTL_MS });
  return { reply: `${projectPreview(draft)} Gõ "ok" để xác nhận hoặc "hủy" để dừng.`, pattern: "action:project_create:preview" };
}

function projectPreview(draft: ProjectDraft): string {
  return `Sẽ tạo project "${draft.name}" · mô tả: ${draft.description || "không có"} · deadline: ${draft.endDate || "không có"} · priority: ${draft.priority}.`;
}

async function executeProjectCreate(draft: ProjectDraft): Promise<ActionTurnResult> {
  const creator = toolsByName.get("project.create");
  if (!creator) return { reply: "Hiện chưa tạo được project vì công cụ chưa sẵn sàng.", pattern: "action:project_create:unavailable" };
  const created: any = await creator.handler({
    name: draft.name,
    description: draft.description,
    endDate: draft.endDate,
    priority: draft.priority,
    ownerId: draft.ownerId,
  });
  return { reply: `Đã tạo project "${created.name || draft.name}". Muốn mình lập kế hoạch task cho project này không?`, pattern: "action:project_create:done" };
}

function normalize(text: string): string {
  return normalizeVietnameseText(text).replace(/\s+/g, " ");
}
function isSimilarProjectName(a: string, b: string): boolean {
  const left = normalize(a);
  const right = normalize(b);
  return left === right || left.includes(right) || right.includes(left);
}
export function _resetActionRouter() { pending.clear(); pendingProjectCreates.clear(); }
