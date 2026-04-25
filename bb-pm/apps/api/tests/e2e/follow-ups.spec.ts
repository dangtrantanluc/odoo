import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, closeApp, agentHeaders, getPrisma } from "./helpers";

describe("agent follow-ups", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let createdId: number;
  let devUserId: number;

  beforeAll(async () => {
    app = await buildApp();
    const prisma = getPrisma();
    await prisma.agentFollowUp.deleteMany({});
    const dev = await prisma.user.findUnique({ where: { email: "dev@test.local" } });
    if (!dev) throw new Error("Seed user dev@test.local missing");
    devUserId = dev.id;
  });

  afterAll(async () => {
    await closeApp();
  });

  it("POST /agent/follow-up creates a PENDING row", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agent/follow-up",
      headers: agentHeaders(),
      payload: {
        taskId: 1,
        userId: devUserId,
        question: "Tiến độ task này thế nào?",
        correlationId: "test-followup-1",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.status).toBe("PENDING");
    expect(body.data.id).toBeGreaterThan(0);
    createdId = body.data.id;
  });

  it("POST rejects unknown taskId with 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agent/follow-up",
      headers: agentHeaders(),
      payload: {
        taskId: 99999,
        userId: devUserId,
        question: "Should fail",
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("TASK_NOT_FOUND");
  });

  it("GET /agent/follow-ups lists with task + user join", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/agent/follow-ups?status=PENDING&limit=10",
      headers: agentHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.length).toBe(1);
    const row = body.data[0];
    expect(row.task.name).toBe("Overdue task");
    expect(row.task.project.code).toBe("TEST-PRJ");
    expect(row.user.email).toBe("dev@test.local");
  });

  it("PATCH /agent/follow-up/:id transitions to REPLIED with timestamp", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/agent/follow-up/${createdId}`,
      headers: agentHeaders(),
      payload: { status: "REPLIED", replyText: "Đã làm xong" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.status).toBe("REPLIED");
    expect(body.data.repliedAt).toBeTruthy();
    expect(body.data.replyText).toBe("Đã làm xong");
  });

  it("PATCH 404 for non-existent id", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/agent/follow-up/99999",
      headers: agentHeaders(),
      payload: { status: "REPLIED" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET filter by status=REPLIED returns the marked row", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/agent/follow-ups?status=REPLIED&limit=10",
      headers: agentHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.length).toBe(1);
    expect(res.json().data[0].id).toBe(createdId);
  });
});
