import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, closeApp, agentHeaders, getPrisma } from "./helpers";

describe("agent audit log", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
    // Wipe audit log for deterministic counts; other suites don't share it.
    await getPrisma().agentAuditLog.deleteMany({});
  });

  afterAll(async () => {
    await closeApp();
  });

  it("POST /agent/audit creates a row", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agent/audit",
      headers: agentHeaders(),
      payload: {
        tool: "list_overdue_tasks",
        argsJson: { days: 0 },
        resultJson: { length: 1 },
        durationMs: 12,
        correlationId: "corr-A",
        source: "chat",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data).toHaveProperty("id");
    expect(body.data).toHaveProperty("createdAt");
  });

  it("POST records errorMessage when tool failed", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agent/audit",
      headers: agentHeaders(),
      payload: {
        tool: "post_blocker",
        argsJson: { taskId: 999 },
        errorMessage: "Task not found",
        durationMs: 5,
        correlationId: "corr-A",
        source: "chat",
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it("GET /agent/audit lists rows newest-first with cursor", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/agent/audit?limit=10",
      headers: agentHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    // newest-first
    const ids = body.data.map((r: any) => r.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(body.meta).toHaveProperty("cutoff");
    expect(body.meta).toHaveProperty("nextCursor");
  });

  it("GET /agent/audit?tool= filters", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/agent/audit?tool=list_overdue_tasks",
      headers: agentHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.every((r: any) => r.tool === "list_overdue_tasks")).toBe(true);
  });

  it("GET /agent/audit?hasError=true filters errors only", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/agent/audit?hasError=true",
      headers: agentHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.length).toBe(1);
    expect(body.data[0].tool).toBe("post_blocker");
    expect(body.data[0].errorMessage).toContain("Task not found");
  });

  it("GET /agent/audit/stats rolls up counts and percentiles", async () => {
    // Add a few more rows to make percentiles meaningful
    for (const ms of [10, 20, 30, 40, 100]) {
      await app.inject({
        method: "POST",
        url: "/api/v1/agent/audit",
        headers: agentHeaders(),
        payload: { tool: "find_user", argsJson: {}, durationMs: ms, source: "chat" },
      });
    }

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/agent/audit/stats?daysBack=7",
      headers: agentHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.data.totals.count).toBeGreaterThanOrEqual(7);
    expect(body.data.totals.errorCount).toBe(1);
    expect(body.data.totals.errorRate).toBeGreaterThan(0);
    expect(body.data.totals.errorRate).toBeLessThan(1);

    const findUser = body.data.byTool.find((t: any) => t.tool === "find_user");
    expect(findUser).toBeDefined();
    expect(findUser.count).toBe(5);
    expect(findUser.p50Ms).toBe(30);
    expect(findUser.p95Ms).toBe(100);
    expect(findUser.errorRate).toBe(0);

    expect(body.data.bySource.chat).toBeGreaterThan(0);
    expect(body.data.byDay.length).toBeGreaterThan(0);
    expect(body.data.topCorrelations.length).toBeGreaterThan(0);
    expect(body.data.topCorrelations[0].correlationId).toBe("corr-A");
  });
});
