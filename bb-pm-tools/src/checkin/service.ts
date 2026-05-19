import { bbPm, CheckinSessionDto, TaskListItem } from "../infrastructure/api-client";
import { chat } from "../infrastructure/llm-client";
import type { AgentContext, ChannelReplyBody } from "../shared/types";

export type ParsedCheckin = {
  work_date: string;
  summary: string;
  hours: number;
  status: "IN_PROGRESS" | "REVIEW" | "DONE" | null;
  blocker: { description: string; severity: "LOW" | "MED" | "HIGH" } | null;
  task_hint: string | null;
  needs_clarification: boolean;
  clarification_question: string | null;
};

type RelativeRangeResult = {
  hours: number | null;
  needsClarification: boolean;
};

export type CheckinTurnResult = {
  reply: string;
  channelReply?: ChannelReplyBody;
  pattern: string;
};

const SESSION_TTL_MS = Number(process.env.CHECKIN_SESSION_TTL_MS ?? 2 * 60 * 60 * 1000);
let nowProvider = () => new Date();
const counters = {
  sessionsStarted: 0,
  projectsSelected: 0,
  completed: 0,
  parseSuccess: 0,
  parseFallback: 0,
  remindersSent: 0,
  remindersSkipped: 0,
};

export function getCheckinTelemetrySnapshot() {
  return { ...counters };
}

export function recordReminderMetric(kind: "sent" | "skipped") {
  if (kind === "sent") counters.remindersSent += 1;
  else counters.remindersSkipped += 1;
}

export function setCheckinNowProviderForTests(provider?: () => Date) {
  nowProvider = provider ?? (() => new Date());
}

export async function handleCheckinTurn(
  text: string,
  ctx: AgentContext,
): Promise<CheckinTurnResult | null> {
  const isWorklogStart = isWorklogStartCommand(text);
  const isWorklogEdit = isWorklogEditCommand(text);
  if (!ctx.callerUserId || !ctx.externalId || !ctx.conversationId) {
    if (isWorklogStart || isWorklogEdit) {
      return {
        reply: "Mình chưa nhận diện được tài khoản của bạn trong hệ thống worklog. Nhờ admin map tài khoản Gapo này trước nhé.",
        pattern: "checkin:no_caller",
      };
    }
    return null;
  }
  const payload = typeof ctx.metadata?.payload === "string" ? ctx.metadata.payload : null;
  const messageId = typeof ctx.metadata?.messageId === "string" ? ctx.metadata.messageId : undefined;
  const threadId =
    typeof ctx.metadata?.threadId === "string" ? ctx.metadata.threadId : ctx.conversationId;

  if (isCurrentProjectQuestion(text)) {
    return await answerCurrentProject(ctx.callerUserId);
  }

  if (payload === "CANCEL_CHECKIN" || isCancelText(text)) {
    const session = await getSession(ctx.callerUserId);
    if (session && !isExpired(session)) await bbPm.completeCheckinSession(session.id);
    return { reply: "Đã hủy thao tác worklog hiện tại.", pattern: "checkin:cancel" };
  }
  if (isWorklogEdit) {
    return await startEditWorklogSession(ctx, threadId, messageId);
  }
  if (isWorklogStart) {
    return await startSession(ctx, threadId, messageId);
  }
  if (payload?.startsWith("SELECT_PROJECT:")) {
    const projectId = Number(payload.slice("SELECT_PROJECT:".length));
    if (!Number.isInteger(projectId)) return null;
    const session = await ensureSession(ctx, threadId, messageId);
    return await selectProject(ctx, session, projectId, messageId);
  }
  if (payload?.startsWith("SELECT_TASK:") || payload?.startsWith("CONFIRM_ATTACH_TASK:")) {
    const sep = payload.indexOf(":");
    const taskId = Number(payload.slice(sep + 1));
    if (!Number.isInteger(taskId)) return null;
    const session = await getSession(ctx.callerUserId);
    if (!session?.pendingParsed || !session.pendingText) return null;
    return await completeWithTask(ctx, session, taskId, session.pendingParsed as ParsedCheckin, session.pendingText);
  }

  const session = await getSession(ctx.callerUserId);
  if (!session || isExpired(session)) return null;
  if (session.state === "AWAITING_PROJECT") {
    const projects = await listUserProjects(ctx.callerUserId);
    const selectedProject = selectByText(projects, text);
    if (!selectedProject) return null;
    return await selectProject(ctx, session, selectedProject.id, messageId);
  }
  if (session.state === "AWAITING_TASK_CONFIRM") {
    if (isEditSelectSession(session)) {
      return await selectWorklogToEdit(ctx, session, text, messageId);
    }
    const tasks = await listProjectTasks(ctx.callerUserId, session.currentProjectId);
    const selectedTask = selectByText(tasks, text);
    if (!selectedTask || !session.pendingParsed || !session.pendingText) return null;
    return await completeWithTask(
      ctx,
      session,
      selectedTask.id,
      session.pendingParsed as ParsedCheckin,
      session.pendingText,
    );
  }
  if (session.state !== "AWAITING_UPDATE") return null;

  const parsed = await parseCheckin(text);
  if (parsed.needs_clarification) {
    return {
      reply: parsed.clarification_question || "Bạn nói rõ thêm giúp mình phần update hôm nay nhé.",
      pattern: "checkin:clarify",
    };
  }
  if (isEditApplySession(session)) {
    return await updateExistingWorklog(ctx, session, parsed);
  }
  return await completeWithProject(ctx, session, parsed, text);
}

function isCancelText(text: string): boolean {
  return /^(?:hủy|huy|cancel|thoát|thoat|dừng|dung)$/u.test(normalize(text));
}

function isWorklogStartCommand(text: string): boolean {
  const normalized = normalize(text);
  return /^\s*\/(?:checkin|worklog|project)\b/iu.test(text) ||
    /^(?:update|cap nhat) worklog$/u.test(normalized) ||
    /^(?:update|cap nhat) (?:cong viec|tien do)(?: hom nay)?$/u.test(normalized) ||
    /^(?:worklog|check in|checkin|project)$/u.test(normalized);
}

function isWorklogEditCommand(text: string): boolean {
  const normalized = normalize(text);
  return /^\s*\/(?:edit-worklog|edit_worklog|sua-worklog|update-worklog)\b/iu.test(text) ||
    /^(?:sua|chinh sua|edit|update|cap nhat lai) worklog(?: hom nay)?$/u.test(normalized) ||
    /^(?:sua|chinh sua|edit|update lai|cap nhat lai) (?:tien do|cong viec)(?: hom nay)?$/u.test(normalized);
}


type EditSelectPending = {
  mode: "EDIT_WORKLOG_SELECT";
  candidates: Array<{ id: number; description: string | null; hours: number; projectId: number; projectName: string | null; workDate: string }>;
};

type EditApplyPending = {
  mode: "EDIT_WORKLOG_APPLY";
  backlogId: number;
  projectId: number;
};

function isEditSelectSession(session: CheckinSessionDto): boolean {
  return session.pendingParsed?.mode === "EDIT_WORKLOG_SELECT";
}

function isEditApplySession(session: CheckinSessionDto): boolean {
  return session.pendingParsed?.mode === "EDIT_WORKLOG_APPLY";
}

async function startEditWorklogSession(
  ctx: AgentContext,
  threadId: string,
  messageId?: string,
): Promise<CheckinTurnResult> {
  const today = todayIso();
  const rows = (await bbPm.getCheckinStatus({ date: today, userId: ctx.callerUserId! })).data
    .filter((row: any) => row.status === "PENDING" && row.user?.id === ctx.callerUserId);
  if (!rows.length) {
    return {
      reply: "Hôm nay chưa có worklog nào để sửa. Gõ /checkin để tạo worklog mới nhé.",
      pattern: "checkin:edit:none",
    };
  }
  const candidates: EditSelectPending["candidates"] = rows.slice(0, 10).map((row: any) => ({
    id: row.id,
    description: row.description ?? "",
    hours: Number(row.hours),
    projectId: row.project?.id ?? row.projectId,
    projectName: row.project?.name ?? null,
    workDate: String(row.workDate).slice(0, 10),
  }));
  const session = await ensureSession(ctx, threadId, messageId);
  await bbPm.patchCheckinSession(session.id, {
    state: "AWAITING_TASK_CONFIRM",
    pendingText: "EDIT_WORKLOG_SELECT",
    pendingParsed: { mode: "EDIT_WORKLOG_SELECT", candidates } satisfies EditSelectPending,
    lastMessageId: messageId ?? session.lastMessageId,
    expiresAt: expiresAtIso(),
  });
  return {
    reply: `Bạn muốn sửa worklog nào?\n${formatWorklogChoices(candidates)}\n\nTrả lời bằng số, hoặc gõ "hủy" để dừng.`,
    pattern: "checkin:edit:list",
  };
}

async function selectWorklogToEdit(
  ctx: AgentContext,
  session: CheckinSessionDto,
  text: string,
  messageId?: string,
): Promise<CheckinTurnResult | null> {
  const pending = session.pendingParsed as EditSelectPending;
  const selected = selectWorklogChoice(pending.candidates, text);
  if (!selected) {
    return { reply: "Bạn chọn số worklog cần sửa giúp mình nhé, hoặc gõ \"hủy\" để dừng.", pattern: "checkin:edit:select_clarify" };
  }
  await bbPm.patchCheckinSession(session.id, {
    currentProjectId: selected.projectId,
    state: "AWAITING_UPDATE",
    pendingText: "EDIT_WORKLOG_APPLY",
    pendingParsed: { mode: "EDIT_WORKLOG_APPLY", backlogId: selected.id, projectId: selected.projectId } satisfies EditApplyPending,
    lastMessageId: messageId ?? session.lastMessageId,
    expiresAt: expiresAtIso(),
  });
  return {
    reply: `Đang sửa worklog: ${selected.description || "không có nội dung"} (${selected.hours}h). Gửi nội dung mới + số giờ, hoặc gõ "hủy" để dừng.`,
    pattern: "checkin:edit:selected",
  };
}

async function updateExistingWorklog(
  ctx: AgentContext,
  session: CheckinSessionDto,
  parsed: ParsedCheckin,
): Promise<CheckinTurnResult> {
  const pending = session.pendingParsed as EditApplyPending;
  const updated = await bbPm.updateCheckinWorklog(pending.backlogId, {
    userId: ctx.callerUserId!,
    workDate: parsed.work_date,
    hours: parsed.hours,
    description: parsed.summary,
  });
  await bbPm.completeCheckinSession(session.id);
  counters.completed += 1;
  await audit(ctx, "checkin.worklog_updated", { backlogId: pending.backlogId, projectId: pending.projectId });
  return {
    reply: `Đã cập nhật: ${updated.data.description} ${Number(updated.data.hours)}h.`,
    pattern: "checkin:edit:updated",
  };
}

function selectWorklogChoice<T extends { id: number }>(items: T[], text: string): T | null {
  const n = Number(text.trim());
  if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1];
  return null;
}

function formatWorklogChoices(items: EditSelectPending["candidates"]): string {
  return items.map((item, index) => {
    const desc = item.description || "không có nội dung";
    const project = item.projectName ? ` · ${item.projectName}` : "";
    return `${index + 1}. ${desc} · ${item.hours}h${project}`;
  }).join("\n");
}

function todayIso(): string {
  return nowProvider().toISOString().slice(0, 10);
}

function isCurrentProjectQuestion(text: string): boolean {
  const n = normalize(text);
  return /^(?:project|du an) hien tai (?:la gi|la project nao)$/u.test(n);
}

async function answerCurrentProject(userId: number): Promise<CheckinTurnResult> {
  const session = await getSession(userId);
  if (!session?.currentProjectId) {
    return { reply: "Mình chưa xác định được project hiện tại.", pattern: "checkin:current_project_unknown" };
  }
  const projects = await listUserProjects(userId);
  const project = projects.find((item) => item.id === session.currentProjectId);
  if (!project) {
    return { reply: "Mình đã có project hiện tại nhưng chưa lấy được tên project.", pattern: "checkin:current_project_unresolved" };
  }
  return { reply: `Project hiện tại của bạn là ${project.name}.`, pattern: "checkin:current_project" };
}

export async function buildProjectSelectionReply(
  userId: number,
): Promise<ChannelReplyBody | null> {
  const projects = await listUserProjects(userId);
  if (!projects.length) return null;
  const options = projects.slice(0, 3).map((project) => ({
    title: project.name.slice(0, 30),
    payload: `SELECT_PROJECT:${project.id}`,
  }));
  return {
    type: "quick_replies",
    text: buildProjectChoiceText(options),
    metadata: {
      options,
    },
  };
}

async function startSession(
  ctx: AgentContext,
  threadId: string,
  messageId?: string,
): Promise<CheckinTurnResult> {
  const channelReply = await buildProjectSelectionReply(ctx.callerUserId!);
  if (!channelReply) {
    return {
      reply: "Mình chưa thấy project nào bạn đang tham gia để mở check-in.",
      pattern: "checkin:no_project",
    };
  }
  await bbPm.startCheckinSession({
    userId: ctx.callerUserId!,
    gapoUserId: ctx.externalId!,
    threadId,
    lastMessageId: messageId,
    expiresAt: expiresAtIso(),
  });
  console.log(`[checkin] state=AWAITING_PROJECT userId=${ctx.callerUserId} threadId=${threadId}`);
  counters.sessionsStarted += 1;
  await audit(ctx, "checkin.session_started", {});
  return {
    reply: channelReply.text,
    channelReply,
    pattern: "checkin:start",
  };
}

async function ensureSession(
  ctx: AgentContext,
  threadId: string,
  messageId?: string,
): Promise<CheckinSessionDto> {
  return (await bbPm.startCheckinSession({
    userId: ctx.callerUserId!,
    gapoUserId: ctx.externalId!,
    threadId,
    lastMessageId: messageId,
    expiresAt: expiresAtIso(),
  })).data;
}

async function getSession(userId: number): Promise<CheckinSessionDto | null> {
  try {
    return (await bbPm.getCurrentCheckinSession(userId)).data;
  } catch (err: any) {
    if (/404/.test(err?.message || "")) return null;
    throw err;
  }
}

async function listUserProjects(userId: number): Promise<Array<{ id: number; name: string }>> {
  try {
    return (await bbPm.getCheckinProjects(userId)).data;
  } catch (err: any) {
    if (!/404/.test(err?.message || "")) throw err;
    const tasks = (await bbPm.searchTasks({ assigneeId: userId, limit: 100 })).data
      .filter((task) => task.status !== "DONE" && task.project);
    const seen = new Set<number>();
    return tasks
      .map((task) => task.project)
      .filter((project): project is NonNullable<TaskListItem["project"]> => Boolean(project))
      .filter((project) => {
        if (seen.has(project.id)) return false;
        seen.add(project.id);
        return true;
      });
  }
}

async function listProjectTasks(userId: number, projectId: number | null): Promise<TaskListItem[]> {
  if (!projectId) return [];
  return (await bbPm.searchTasks({
    assigneeId: userId,
    projectId,
    limit: 50,
  })).data.filter((task) => task.status !== "DONE");
}

function findHintedTask(tasks: TaskListItem[], hint: string | null): TaskListItem | null {
  if (!hint) return null;
  const q = normalize(hint);
  return tasks.find((task) => normalize(task.name).includes(q) || q.includes(normalize(task.name))) ?? null;
}

function selectByText<T extends { id: number; name: string }>(items: T[], text: string): T | null {
  const trimmed = text.trim();
  const numeric = Number(trimmed);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= items.length) {
    return items[numeric - 1];
  }
  const q = normalize(trimmed);
  if (!q) return null;
  return items.find((item) => normalize(item.name) === q) ??
    items.find((item) => normalize(item.name).includes(q) || q.includes(normalize(item.name))) ??
    null;
}

function buildManualChoiceText(
  prompt: string,
  options: Array<{ title: string; payload: string }>,
): string {
  const choices = options.map((option, index) => `${index + 1}. ${option.title}`).join("\n");
  return `${prompt}\nNếu không thấy nút, trả lời bằng số:\n${choices}`;
}

function buildProjectChoiceText(
  options: Array<{ title: string; payload: string }>,
): string {
  const choices = options.map((option, index) => `${index + 1}. ${option.title}`).join("\n");
  return `Hôm nay bạn làm project nào?\n\nGần đây:\n${choices}\n\nHoặc nhập tên project khác. Gõ "hủy" để dừng.`;
}

async function selectProject(
  ctx: AgentContext,
  session: CheckinSessionDto,
  projectId: number,
  messageId?: string,
): Promise<CheckinTurnResult> {
  await bbPm.patchCheckinSession(session.id, {
    currentProjectId: projectId,
    currentTaskId: null,
    state: "AWAITING_UPDATE",
    lastMessageId: messageId ?? session.lastMessageId,
    expiresAt: expiresAtIso(),
  });
  console.log(`[checkin] state=AWAITING_UPDATE userId=${ctx.callerUserId} projectId=${projectId}`);
  counters.projectsSelected += 1;
  await audit(ctx, "checkin.project_selected", { projectId });
  return {
    reply: "Bạn cập nhật worklog hôm nay nhé: nội dung đã làm, số giờ, trạng thái (đang làm/review/xong) và blocker nếu có. Gõ \"hủy\" để dừng.",
    pattern: "checkin:project_selected",
  };
}

async function completeWithTask(
  ctx: AgentContext,
  session: CheckinSessionDto,
  taskId: number,
  parsed: ParsedCheckin,
  rawText: string,
): Promise<CheckinTurnResult> {
  const tasks = await listProjectTasks(ctx.callerUserId!, session.currentProjectId);
  if (!tasks.some((task) => task.id === taskId)) {
    return { reply: `Task #${taskId} không nằm trong project hiện tại của bạn.`, pattern: "checkin:invalid_task" };
  }
  const backlog = await bbPm.importCheckin({
    userId: ctx.callerUserId!,
    projectId: session.currentProjectId!,
    taskId,
    workDate: parsed.work_date,
    hours: parsed.hours,
    description: parsed.summary,
  });
  if (parsed.status) await bbPm.updateTaskStatus(taskId, parsed.status);
  const blocker = parsed.blocker ? await bbPm.postBlocker(taskId, parsed.blocker) : null;
  await bbPm.completeCheckinSession(session.id);
  console.log(`[checkin] state=COMPLETED userId=${ctx.callerUserId} taskId=${taskId}`);
  counters.completed += 1;
  await audit(ctx, "checkin.backlog_created", { taskId, backlogId: backlog.data.id });
  const parts = [`Đã ghi nhận: ${parsed.summary}`, `Backlog ${backlog.data.id}, ${parsed.hours}h.`];
  if (parsed.status) parts.push(`Status: ${parsed.status}.`);
  if (blocker) parts.push(`Blocker ${blocker.data.blockerId} đã được ghi.`);
  return { reply: parts.join(" "), pattern: "checkin:completed" };
}

async function completeWithProject(
  ctx: AgentContext,
  session: CheckinSessionDto,
  parsed: ParsedCheckin,
  rawText: string,
): Promise<CheckinTurnResult> {
  if (!session.currentProjectId) {
    return { reply: "Mình chưa xác định được project hiện tại.", pattern: "checkin:no_project" };
  }
  const backlog = await bbPm.importCheckin({
    userId: ctx.callerUserId!,
    projectId: session.currentProjectId,
    workDate: parsed.work_date,
    hours: parsed.hours,
    description: parsed.summary,
  });
  await bbPm.completeCheckinSession(session.id);
  console.log(`[checkin] state=COMPLETED userId=${ctx.callerUserId} projectId=${session.currentProjectId}`);
  counters.completed += 1;
  await audit(ctx, "checkin.worklog_created", { projectId: session.currentProjectId, backlogId: backlog.data.id });
  const parts = [`Đã ghi nhận: ${parsed.summary}`, `${parsed.hours}h.`];
  if (parsed.status) parts.push(`Trạng thái: ${parsed.status}.`);
  if (parsed.blocker) parts.push("Có blocker.");
  return { reply: parts.join(" "), pattern: "checkin:completed_project" };
}

export async function parseCheckin(text: string): Promise<ParsedCheckin> {
  const fallback = regexFallback(text);
  if (fallback.needs_clarification && hasRelativeNowRange(text)) return fallback;
  try {
    const res = await chat(
      [
        {
          role: "system",
          content:
            "Bạn là parser check-in PM. Trả JSON object với schema " +
            '{"work_date":"YYYY-MM-DD","summary":"string","hours":1.5,"status":"IN_PROGRESS|REVIEW|DONE|null",' +
            '"blocker":{"description":"string","severity":"LOW|MED|HIGH"}|null,"task_hint":"string|null",' +
            '"needs_clarification":false,"clarification_question":"string|null"}. ' +
            "Không bịa dữ liệu; nếu thiếu giờ thì dùng 1; nếu input mơ hồ không có tiến độ cụ thể thì needs_clarification=true.",
        },
        { role: "user", content: text },
      ],
      undefined,
      { temperature: 0, max_tokens: 350, response_format: { type: "json_object" } },
    );
    const payload = JSON.parse(res.content ?? "{}");
    const parsed = normalizeParsed(payload, fallback);
    counters.parseSuccess += 1;
    return parsed;
  } catch {
    counters.parseFallback += 1;
    return fallback;
  }
}

function normalizeParsed(payload: any, fallback: ParsedCheckin): ParsedCheckin {
  const status = ["IN_PROGRESS", "REVIEW", "DONE"].includes(payload?.status) ? payload.status : null;
  const severity = ["LOW", "MED", "HIGH"].includes(payload?.blocker?.severity)
    ? payload.blocker.severity
    : "MED";
  return {
    work_date: typeof payload?.work_date === "string" ? payload.work_date : fallback.work_date,
    summary: typeof payload?.summary === "string" && payload.summary.trim() ? payload.summary.trim() : fallback.summary,
    hours: hasRelativeNowRange(fallback.summary)
      ? fallback.hours
      : Number.isFinite(Number(payload?.hours)) && Number(payload.hours) > 0
      ? Number(payload.hours)
      : fallback.hours,
    status,
    blocker: payload?.blocker?.description
      ? { description: String(payload.blocker.description), severity }
      : null,
    task_hint: typeof payload?.task_hint === "string" && payload.task_hint.trim()
      ? payload.task_hint.trim()
      : null,
    needs_clarification: Boolean(payload?.needs_clarification),
    clarification_question:
      typeof payload?.clarification_question === "string" ? payload.clarification_question : null,
  };
}

function regexFallback(text: string): ParsedCheckin {
  const lowered = text.toLowerCase();
  const relativeRange = extractRelativeNowRange(text);
  const hours = relativeRange.hours ?? extractHours(text);
  const status = /\b(done|xong|hoàn thành|hoan thanh)|100% \b/u.test(lowered)
    ? "DONE"
    : /\b(review|pr|merge request|chờ duyệt|cho duyet)\b/u.test(lowered)
      ? "REVIEW"
      : /\b(đang làm|dang lam|in progress)\b/u.test(lowered)
        ? "IN_PROGRESS"
        : null;
  const hasBlocker = /\b(blocker|vướng|vuong|kẹt|ket|chưa có|chua co|không có|khong co)\b/u.test(lowered);
  return {
    work_date: new Date().toISOString().slice(0, 10),
    summary: text.trim(),
    hours,
    status,
    blocker: hasBlocker
      ? {
          description: text.trim(),
          severity: /\b(gấp|gap|critical|nghiêm trọng|nghiem trong)\b/u.test(lowered) ? "HIGH" : "MED",
        }
      : null,
    task_hint: null,
    needs_clarification: !text.trim() || relativeRange.needsClarification,
    clarification_question: !text.trim()
      ? "Bạn cập nhật cụ thể giúp mình nhé."
      : relativeRange.needsClarification
        ? "Khoảng thời gian này có vẻ đang qua ngày. Bạn nhập rõ số giờ hoặc mốc kết thúc giúp mình nhé."
        : null,
  };
}

export function extractHours(text: string, now = nowProvider()): number {
  const relativeRange = extractRelativeNowRange(text, now);
  if (relativeRange.hours !== null) return relativeRange.hours;

  const range = extractRangeHours(text);
  if (range !== null) return range;

  const halfHourMatch = text.match(/\b(?:nửa|nua)\s*(?:giờ|gio|tiếng|tieng)\b/iu);
  if (halfHourMatch) return 0.5;

  const halfSuffixMatch = text.match(/(\d+)\s*(?:giờ|gio|tiếng|tieng)\s*(?:rưỡi|ruoi)\b/iu);
  if (halfSuffixMatch) return Number(halfSuffixMatch[1]) + 0.5;

  const mixedMatch = text.match(
    /(\d+)\s*(?:giờ|gio|tiếng|tieng|h)\s*(\d+)\s*(?:phút|phut|p)\b/iu,
  );
  if (mixedMatch) return Number(mixedMatch[1]) + Number(mixedMatch[2]) / 60;

  const compactMixedMatch = text.match(/\b(\d+)\s*h\s*(\d{1,2})\b/iu);
  if (compactMixedMatch) return Number(compactMixedMatch[1]) + Number(compactMixedMatch[2]) / 60;

  const durationMatch = text.match(
    /(\d+(?:[,.]\d+)?)\s*(h|giờ|gio|tiếng|tieng|hours?)\b/iu,
  );
  if (durationMatch) return Number(durationMatch[1].replace(",", "."));

  const minutesMatch = text.match(/(\d+)\s*(?:phút|phut|minutes?|mins?|p)\b/iu);
  if (minutesMatch) return Number(minutesMatch[1]) / 60;

  return 1;
}

function hasRelativeNowRange(text: string): boolean {
  return extractRelativeNowRangeMatch(text) !== null;
}

function extractRelativeNowRange(text: string, now = nowProvider()): RelativeRangeResult {
  const match = extractRelativeNowRangeMatch(text);
  if (!match) return { hours: null, needsClarification: false };
  const start = toMinutes(match[1], match[2], match[3]);
  if (start === null) return { hours: null, needsClarification: false };
  const current = getHanoiMinutes(now);
  if (current < start) return { hours: null, needsClarification: true };
  return { hours: (current - start) / 60, needsClarification: false };
}

function extractRelativeNowRangeMatch(text: string): RegExpMatchArray | null {
  return text.match(
    /(?:^|\s)(?:từ|tu)\s*(\d{1,2})(?:(?::|h)(\d{2}))?\s*(?:h|giờ|gio)?\s*(sáng|sang|chiều|chieu|tối|toi)?\s*(?:-|–|—|đến|den|tới|toi)\s*(?:bây\s*giờ|bay\s*gio|hiện\s*tại|hien\s*tai|bây\s*h|bay\s*h)(?=\s|$)/iu,
  );
}

function extractRangeHours(text: string): number | null {
  const match = text.match(
    /\b(?:từ\s*)?(\d{1,2})(?:(?::|h)(\d{2}))?\s*(?:h|giờ|gio)?\s*(sáng|sang|chiều|chieu|tối|toi)?\s*(?:-|–|—|đến|den|tới|toi)\s*(\d{1,2})(?:(?::|h)(\d{2}))?\s*(?:h|giờ|gio)?\s*(sáng|sang|chiều|chieu|tối|toi)?\b/iu,
  );
  if (!match) return null;
  const start = toMinutes(match[1], match[2], match[3]);
  let end = toMinutes(match[4], match[5], match[6]);
  if (start === null || end === null) return null;
  if (end < start) end += 24 * 60;
  const duration = (end - start) / 60;
  return duration > 0 && duration <= 24 ? duration : null;
}

function getHanoiMinutes(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return hour * 60 + minute;
}

function toMinutes(hourRaw: string, minuteRaw?: string, periodRaw?: string): number | null {
  let hour = Number(hourRaw);
  const minute = minuteRaw ? Number(minuteRaw) : 0;
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  const period = normalize(periodRaw ?? "");
  if ((period === "chieu" || period === "toi") && hour >= 1 && hour <= 11) hour += 12;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

function expiresAtIso(): string {
  return new Date(Date.now() + SESSION_TTL_MS).toISOString();
}

function isExpired(session: CheckinSessionDto): boolean {
  return new Date(session.expiresAt).getTime() <= Date.now();
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function audit(ctx: AgentContext, tool: string, argsJson: unknown) {
  try {
    await bbPm.postAudit({
      tool,
      argsJson,
      source: ctx.source === "eval" ? "other" : (ctx.source ?? "chat"),
      correlationId: ctx.correlationId,
    });
  } catch {}
}
