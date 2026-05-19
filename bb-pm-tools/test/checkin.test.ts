import assert from "node:assert/strict";
import {
  buildProjectSelectionReply,
  extractHours,
  handleCheckinTurn,
  setCheckinNowProviderForTests,
} from "../src/checkin";
import { bbPm } from "../src/api-client";

const originals = {
  searchTasks: bbPm.searchTasks,
  getCheckinProjects: bbPm.getCheckinProjects,
  startCheckinSession: bbPm.startCheckinSession,
  getCurrentCheckinSession: bbPm.getCurrentCheckinSession,
  patchCheckinSession: bbPm.patchCheckinSession,
  completeCheckinSession: bbPm.completeCheckinSession,
  getCheckinStatus: bbPm.getCheckinStatus,
  importCheckin: bbPm.importCheckin,
  updateCheckinWorklog: bbPm.updateCheckinWorklog,
  updateTaskStatus: bbPm.updateTaskStatus,
  postBlocker: bbPm.postBlocker,
  postAudit: bbPm.postAudit,
};

async function run() {
  const hanoi1115 = new Date("2026-05-18T04:15:00.000Z");
  assert.equal(extractHours("sửa lại UI cho pricing trong 2 tiếng"), 2);
  assert.equal(extractHours("làm pricing từ 9h - 10h"), 1);
  assert.equal(extractHours("review từ 9h30 đến 11h"), 1.5);
  assert.equal(extractHours("fix bug 09:15-10:45"), 1.5);
  assert.equal(extractHours("họp 1 giờ 30 phút"), 1.5);
  assert.equal(extractHours("sync 45 phút"), 0.75);
  assert.equal(extractHours("fix pricing 1h30"), 1.5);
  assert.equal(extractHours("review 2 tiếng rưỡi"), 2.5);
  assert.equal(extractHours("sync nửa tiếng"), 0.5);
  assert.equal(extractHours("làm từ 9h đến 10h30"), 1.5);
  assert.equal(extractHours("họp từ 2h chiều đến 4h chiều"), 2);
  assert.equal(extractHours("fix bug từ 9h đến bây giờ", hanoi1115), 2.25);
  assert.equal(extractHours("fix bug tu 9h den bay gio", hanoi1115), 2.25);
  assert.equal(extractHours("fix bug từ 9h đến hiện tại", hanoi1115), 2.25);
  assert.equal(extractHours("fix bug từ 9h đến bây h", hanoi1115), 2.25);

  (bbPm.searchTasks as any) = async () => ({
    data: [
      {
        id: 11,
        name: "API login",
        status: "IN_PROGRESS",
        project: { id: 1, name: "AI PM Agent", code: "AI" },
      },
      {
        id: 12,
        name: "Dashboard",
        status: "TODO",
        project: { id: 2, name: "Odoo", code: "ODOO" },
      },
      {
        id: 13,
        name: "Webhook",
        status: "TODO",
        project: { id: 3, name: "Logistics Dashboard", code: "LOG" },
      },
      {
        id: 14,
        name: "Lead import",
        status: "TODO",
        project: { id: 4, name: "CRM Internal", code: "CRM" },
      },
    ],
  });
  (bbPm.getCheckinProjects as any) = async () => ({
    data: [
      { id: 1, name: "AI PM Agent", code: "AI" },
      { id: 2, name: "Odoo", code: "ODOO" },
      { id: 3, name: "Logistics Dashboard", code: "LOG" },
      { id: 4, name: "CRM Internal", code: "CRM" },
    ],
  });
  const projects = await buildProjectSelectionReply(7);
  assert.equal(projects?.type, "quick_replies");
  assert.equal(projects && "metadata" in projects ? projects.metadata.options.length : 0, 3);
  assert.match(projects?.text ?? "", /^Hôm nay bạn làm project nào\?/);
  assert.match(projects?.text ?? "", /Hoặc nhập tên project khác\./);
  assert.match(projects?.text ?? "", /hủy/);
  assert.doesNotMatch(projects?.text ?? "", /CRM Internal/);

  let session: any = null;
  (bbPm.startCheckinSession as any) = async (body: any) => ({
    data: (session = {
      id: 1,
      userId: body.userId,
      gapoUserId: body.gapoUserId,
      threadId: body.threadId,
      currentProjectId: null,
      currentTaskId: null,
      state: "AWAITING_PROJECT",
      expiresAt: body.expiresAt,
      lastMessageId: body.lastMessageId ?? null,
      completedAt: null,
    }),
  });
  (bbPm.getCurrentCheckinSession as any) = async () => ({ data: session });
  (bbPm.patchCheckinSession as any) = async (_id: number, patch: any) => ({
    data: (session = { ...session, ...patch }),
  });
  (bbPm.completeCheckinSession as any) = async () => ({
    data: (session = { ...session, state: "COMPLETED" }),
  });
  (bbPm.postAudit as any) = async () => ({ data: { id: 1 } });

  const start = await handleCheckinTurn("/checkin", {
    callerUserId: 7,
    externalId: "119",
    conversationId: "gapo:123",
    metadata: { threadId: "123" },
  });
  assert.equal(start?.pattern, "checkin:start");
  assert.match(start?.reply ?? "", /Gần đây:/);

  const selected = await handleCheckinTurn("AI PM Agent", {
    callerUserId: 7,
    externalId: "119",
    conversationId: "gapo:123",
    metadata: { threadId: "123", payload: "SELECT_PROJECT:1" },
  });
  assert.equal(selected?.pattern, "checkin:project_selected");
  assert.equal(session.currentProjectId, 1);
  assert.match(selected?.reply ?? "", /hủy/);
  session = { ...session, currentProjectId: null, state: "AWAITING_PROJECT" };
  const cancelledAfterProjectList = await handleCheckinTurn("hủy", {
    callerUserId: 7,
    externalId: "119",
    conversationId: "gapo:123",
    metadata: { threadId: "123" },
  });
  assert.equal(cancelledAfterProjectList?.pattern, "checkin:cancel");
  assert.equal(session.state, "COMPLETED");

  session = { ...session, currentProjectId: 1, state: "AWAITING_UPDATE" };
  const currentProject = await handleCheckinTurn("project hiện tại là gì", {
    callerUserId: 7,
    externalId: "119",
    conversationId: "gapo:123",
    metadata: { threadId: "123" },
  });
  assert.equal(currentProject?.pattern, "checkin:current_project");
  assert.match(currentProject?.reply ?? "", /AI PM Agent/);

  session = { ...session, currentProjectId: null, state: "AWAITING_PROJECT" };
  const selectedByNumber = await handleCheckinTurn("2", {
    callerUserId: 7,
    externalId: "119",
    conversationId: "gapo:123",
    metadata: { threadId: "123" },
  });
  assert.equal(selectedByNumber?.pattern, "checkin:project_selected");
  assert.equal(session.currentProjectId, 2);

  session = { ...session, currentProjectId: null, state: "AWAITING_PROJECT" };
  const selectedByHiddenProjectName = await handleCheckinTurn("CRM Internal", {
    callerUserId: 7,
    externalId: "119",
    conversationId: "gapo:123",
    metadata: { threadId: "123" },
  });
  assert.equal(selectedByHiddenProjectName?.pattern, "checkin:project_selected");
  assert.equal(session.currentProjectId, 4);

  (bbPm.searchTasks as any) = async (args: any) => ({
    data: [
      {
        id: 11,
        name: "API login",
        status: "IN_PROGRESS",
        project: { id: args.projectId ?? 1, name: "AI PM Agent", code: "AI" },
      },
    ],
  });
  (bbPm.importCheckin as any) = async () => ({ data: { id: 55 } });
  (bbPm.updateTaskStatus as any) = async () => ({ data: { status: "DONE" } });
  (bbPm.postBlocker as any) = async () => ({ data: { blockerId: 88 } });
  const completed = await handleCheckinTurn("hôm nay tôi fix login 2h, đã xong nhưng kẹt critical", {
    callerUserId: 7,
    externalId: "119",
    conversationId: "gapo:123",
    metadata: { threadId: "123" },
  });
  assert.equal(completed?.pattern, "checkin:completed_project");
  assert.equal(completed?.reply, "Đã ghi nhận: hôm nay tôi fix login 2h, đã xong nhưng kẹt critical 2h. Trạng thái: DONE. Có blocker.");

  session = { ...session, currentProjectId: 4, state: "AWAITING_UPDATE" };
  (bbPm.searchTasks as any) = async () => ({ data: [] });
  const projectOnly = await handleCheckinTurn("hôm nay tôi họp kickoff 1h", {
    callerUserId: 7,
    externalId: "119",
    conversationId: "gapo:123",
    metadata: { threadId: "123" },
  });
  assert.equal(projectOnly?.pattern, "checkin:completed_project");
  assert.equal(projectOnly?.reply, "Đã ghi nhận: hôm nay tôi họp kickoff 1h 1h.");

  setCheckinNowProviderForTests(() => hanoi1115);
  session = { ...session, currentProjectId: 4, state: "AWAITING_UPDATE" };
  let importedHours: number | null = null;
  (bbPm.importCheckin as any) = async (body: any) => {
    importedHours = body.hours;
    return { data: { id: 56 } };
  };
  const relativeNow = await handleCheckinTurn("fix bug từ 9h đến bây giờ", {
    callerUserId: 7,
    externalId: "119",
    conversationId: "gapo:123",
    metadata: { threadId: "123" },
  });
  assert.equal(relativeNow?.pattern, "checkin:completed_project");
  assert.equal(importedHours, 2.25);

  setCheckinNowProviderForTests(() => new Date("2026-05-17T17:30:00.000Z")); // 00:30 Hanoi
  session = { ...session, currentProjectId: 4, state: "AWAITING_UPDATE" };
  const ambiguousOvernight = await handleCheckinTurn("fix bug từ 22h đến bây giờ", {
    callerUserId: 7,
    externalId: "119",
    conversationId: "gapo:123",
    metadata: { threadId: "123" },
  });
  assert.equal(ambiguousOvernight?.pattern, "checkin:clarify");
  assert.match(ambiguousOvernight?.reply ?? "", /qua ngày/);

  session = { ...session, currentProjectId: 1, state: "AWAITING_UPDATE" };
  (bbPm.searchTasks as any) = async () => ({
    data: [
      { id: 21, name: "Task A", status: "TODO", project: { id: 1, name: "AI PM Agent", code: "AI" } },
      { id: 22, name: "Task B", status: "TODO", project: { id: 1, name: "AI PM Agent", code: "AI" } },
    ],
  });
  const multiTaskProject = await handleCheckinTurn("hôm nay tôi xử lý trao đổi khách hàng 1h", {
    callerUserId: 7,
    externalId: "119",
    conversationId: "gapo:123",
    metadata: { threadId: "123" },
  });
  assert.equal(multiTaskProject?.pattern, "checkin:completed_project");
  assert.doesNotMatch(multiTaskProject?.reply ?? "", /gắn vào task nào/);

  (bbPm.getCheckinStatus as any) = async () => ({
    data: [
      {
        id: 901,
        status: "PENDING",
        description: "fix login cũ",
        hours: 1,
        workDate: "2026-05-18T00:00:00.000Z",
        user: { id: 7 },
        project: { id: 1, name: "AI PM Agent" },
      },
    ],
  });
  const editList = await handleCheckinTurn("sửa worklog hôm nay", {
    callerUserId: 7,
    externalId: "119",
    conversationId: "gapo:123",
    metadata: { threadId: "123" },
  });
  assert.equal(editList?.pattern, "checkin:edit:list");
  assert.match(editList?.reply ?? "", /fix login cũ/);
  assert.match(editList?.reply ?? "", /hủy/);

  const editSelected = await handleCheckinTurn("1", {
    callerUserId: 7,
    externalId: "119",
    conversationId: "gapo:123",
    metadata: { threadId: "123" },
  });
  assert.equal(editSelected?.pattern, "checkin:edit:selected");
  assert.equal(session.currentProjectId, 1);

  const cancelEdit = await handleCheckinTurn("cancel", {
    callerUserId: 7,
    externalId: "119",
    conversationId: "gapo:123",
    metadata: { threadId: "123" },
  });
  assert.equal(cancelEdit?.pattern, "checkin:cancel");

  await handleCheckinTurn("/edit-worklog", {
    callerUserId: 7,
    externalId: "119",
    conversationId: "gapo:123",
    metadata: { threadId: "123" },
  });
  await handleCheckinTurn("1", {
    callerUserId: 7,
    externalId: "119",
    conversationId: "gapo:123",
    metadata: { threadId: "123" },
  });
  let updatedBody: any = null;
  (bbPm.updateCheckinWorklog as any) = async (backlogId: number, body: any) => {
    updatedBody = { backlogId, ...body };
    return { data: { id: backlogId, projectId: 1, taskId: null, workDate: body.workDate, hours: body.hours, description: body.description } };
  };
  const editUpdated = await handleCheckinTurn("đổi lại: fix login và test lại 1.5h", {
    callerUserId: 7,
    externalId: "119",
    conversationId: "gapo:123",
    metadata: { threadId: "123" },
  });
  assert.equal(editUpdated?.pattern, "checkin:edit:updated");
  assert.equal(updatedBody.backlogId, 901);
  assert.equal(updatedBody.userId, 7);
  assert.equal(updatedBody.hours, 1.5);
  assert.match(updatedBody.description, /fix login/);
}

run()
  .then(() => console.log("checkin tests passed"))
  .finally(() => {
    setCheckinNowProviderForTests();
    Object.assign(bbPm, originals);
  });
