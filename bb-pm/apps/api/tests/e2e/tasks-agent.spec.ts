import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, closeApp, agentHeaders, getPrisma } from "./helpers";

describe("agent task endpoints", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await closeApp();
  });

  it("GET /tasks/overdue returns at least the overdue fixture", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/tasks/overdue",
      headers: agentHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const overdue = body.data.find((t: any) => t.id === 1);
    expect(overdue).toBeDefined();
    expect(overdue.name).toBe("Overdue task");
    expect(overdue.daysOverdue).toBeGreaterThan(0);
  });

  it("GET /tasks/overdue does not include the future task", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/tasks/overdue",
      headers: agentHeaders(),
    });
    const ids = res.json().data.map((t: any) => t.id);
    expect(ids).not.toContain(2);
  });

  it("GET /projects/digest rolls up totals", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/projects/digest",
      headers: agentHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.totals.activeProjects).toBeGreaterThanOrEqual(1);
    expect(body.data.totals.openTasks).toBeGreaterThanOrEqual(2);
    expect(body.data.totals.overdueTasks).toBeGreaterThanOrEqual(1);
  });

  it("POST /tasks/:id/blocker creates row + appends to issues", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tasks/1/blocker",
      headers: agentHeaders(),
      payload: { description: "Chờ design review", severity: "MED" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.taskId).toBe(1);
    expect(body.data.severity).toBe("MED");

    const prisma = getPrisma();
    const task = await prisma.task.findUnique({ where: { id: 1 }, select: { issues: true } });
    expect(task?.issues).toContain("Chờ design review");

    const blockerRow = await prisma.taskBlocker.findFirst({
      where: { taskId: 1 },
      orderBy: { id: "desc" },
    });
    expect(blockerRow).toBeTruthy();
    expect(blockerRow?.severity).toBe("MED");
  });

  it("X-Agent-Token rejected when wrong", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/tasks/overdue",
      headers: { "X-Agent-Token": "wrong-token" },
    });
    expect(res.statusCode).toBe(401);
  });
});
