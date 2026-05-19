import assert from "node:assert/strict";
import { _resetActionRouter, handleActionTurn } from "../src/action-router";
import { bbPm } from "../src/api-client";
import { toolsByName } from "../src/tools";

const orig = { findTask: bbPm.findTask, findUser: bbPm.findUser, findProject: bbPm.findProject, patchTask: bbPm.patchTask, updateTaskStatus: bbPm.updateTaskStatus, createActionItem: bbPm.createActionItem };
(bbPm as any).findTask = async () => ({ data: [{ id: 7, name: "API login" }] });
(bbPm as any).findUser = async () => ({ data: [{ id: 3, name: "Phương Thảo" }] });
(bbPm as any).findProject = async () => ({ data: [{ id: 2, name: "MTL" }] });
(bbPm as any).patchTask = async () => ({ data: { id: 7 } });
(bbPm as any).updateTaskStatus = async () => ({ data: { status: "DONE" } });
(bbPm as any).createActionItem = async () => ({ data: { id: 9 } });
const ctx: any = { conversationId: "c1", callerUserId: 5 };
const projectCreate = toolsByName.get("project.create")!;
const origProjectCreate = projectCreate.handler;
(async () => {
  _resetActionRouter();
  assert.equal((await handleActionTurn("đổi deadline task API login sang 2026-05-20", ctx))?.pattern, "action:deadline:preview");
  assert.equal((await handleActionTurn("ok", ctx))?.pattern, "action:deadline:done");
  assert.equal((await handleActionTurn("assign task API login cho Phương Thảo", ctx))?.pattern, "action:assign:preview");
  assert.equal((await handleActionTurn("hủy", ctx))?.pattern, "action:cancel");
  assert.equal((await handleActionTurn("đánh dấu task API login done", ctx))?.pattern, "action:status:preview");
  assert.equal((await handleActionTurn("ok", ctx))?.pattern, "action:status:done");
  assert.equal((await handleActionTurn("tạo task viết spec trong project MTL", ctx))?.pattern, "action:create:preview");

  let createdArgs: any = null;
  (projectCreate as any).handler = async (args: any) => {
    createdArgs = args;
    return { id: 10, name: args.name };
  };
  _resetActionRouter();
  assert.equal((await handleActionTurn("tạo project", ctx))?.pattern, "action:project_create:ask_name");
  assert.equal((await handleActionTurn("Project Apollo", ctx))?.pattern, "action:project_create:preview");
  assert.equal((await handleActionTurn("ok", ctx))?.pattern, "action:project_create:done");
  assert.deepEqual(createdArgs, {
    name: "Project Apollo",
    description: undefined,
    endDate: undefined,
    priority: "MEDIUM",
    ownerId: 5,
  });

  _resetActionRouter();
  assert.equal((await handleActionTurn("tạo project Mobile App, mô tả app bán hàng, deadline 2026-08-01, priority high", ctx))?.pattern, "action:project_create:preview");
  assert.equal((await handleActionTurn("hủy", ctx))?.pattern, "action:project_create:cancel");

  (bbPm as any).findProject = async (name: string) => ({ data: [{ id: 8, name: name }] });
  _resetActionRouter();
  assert.equal((await handleActionTurn("tạo project Project Apollo", ctx))?.pattern, "action:project_create:duplicate");
  assert.equal((await handleActionTurn("tạo mới", ctx))?.pattern, "action:project_create:preview");
  assert.equal((await handleActionTurn("ok", ctx))?.pattern, "action:project_create:done");
  console.log("action-router tests passed");
  Object.assign(bbPm, orig);
  (projectCreate as any).handler = origProjectCreate;
})();
