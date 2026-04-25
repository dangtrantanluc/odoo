import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

// Audit log — receives per-tool invocation records from bb-pm-tools
// (OpenClaw PM Agent plugin). All entries are authenticated via the
// shared X-Agent-Token header; only the PM agent service user writes here.
const auditBody = z.object({
  tool: z.string().min(1).max(128),
  argsJson: z.any(),
  resultJson: z.any().optional(),
  errorMessage: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  correlationId: z.string().max(256).optional(),
  source: z.enum(["chat", "cron", "cli", "other"]).optional().default("chat"),
});

const listQuery = z.object({
  limit: z.coerce.number().int().positive().max(200).optional().default(50),
  tool: z.string().optional(),
  correlationId: z.string().optional(),
  source: z.enum(["chat", "cron", "cli", "other"]).optional(),
  hasError: z.coerce.boolean().optional(),
  daysBack: z.coerce.number().int().positive().max(365).optional().default(7),
  cursor: z.coerce.number().int().positive().optional(),
});

const statsQuery = z.object({
  daysBack: z.coerce.number().int().positive().max(90).optional().default(7),
});

const agentRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  // POST /agent/audit — append an audit log entry.
  app.post("/audit", { schema: { body: auditBody } }, async (req, reply) => {
    const body = req.body as z.infer<typeof auditBody>;
    const row = await app.prisma.agentAuditLog.create({
      data: {
        tool: body.tool,
        argsJson: body.argsJson ?? {},
        resultJson: body.resultJson ?? undefined,
        errorMessage: body.errorMessage ?? null,
        durationMs: body.durationMs ?? null,
        correlationId: body.correlationId ?? null,
        source: body.source,
      },
      select: { id: true, createdAt: true },
    });
    return reply.code(201).send({ data: row });
  });

  // GET /agent/audit — recent entries, for inspection / debugging.
  // Agent-authenticated users get all; human users company-scoped is moot
  // (audit log is global infra). Supports cursor pagination on id desc.
  app.get("/audit", { schema: { querystring: listQuery } }, async (req) => {
    const q = req.query as z.infer<typeof listQuery>;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - q.daysBack);

    const where: any = { createdAt: { gte: cutoff } };
    if (q.tool) where.tool = q.tool;
    if (q.correlationId) where.correlationId = q.correlationId;
    if (q.source) where.source = q.source;
    if (q.hasError === true) where.errorMessage = { not: null };
    if (q.hasError === false) where.errorMessage = null;
    if (q.cursor) where.id = { lt: q.cursor };

    const rows = await app.prisma.agentAuditLog.findMany({
      where,
      take: q.limit,
      orderBy: { id: "desc" },
    });
    const nextCursor = rows.length === q.limit ? rows[rows.length - 1].id : null;
    return {
      data: rows,
      meta: { total: rows.length, cutoff: cutoff.toISOString(), nextCursor },
    };
  });

  // GET /agent/audit/stats — rollup for the audit dashboard. Returns:
  //   - totals: count, errorCount, errorRate
  //   - byTool: per-tool count + p50/p95 duration + error rate
  //   - bySource: chat/cron/cli/other distribution
  //   - byDay: daily count + error count for sparkline / chart
  //   - topCorrelations: 5 noisiest correlation ids (debugging long flows)
  app.get("/audit/stats", { schema: { querystring: statsQuery } }, async (req) => {
    const q = req.query as z.infer<typeof statsQuery>;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - q.daysBack);

    // Pull everything in window once. AuditLog is small per day; tens of
    // thousands per week is fine for in-memory rollup. If volume grows
    // beyond ~100k rows, switch to SQL aggregation per metric.
    const rows = await app.prisma.agentAuditLog.findMany({
      where: { createdAt: { gte: cutoff } },
      select: {
        tool: true,
        durationMs: true,
        errorMessage: true,
        source: true,
        correlationId: true,
        createdAt: true,
      },
    });

    const total = rows.length;
    const errorCount = rows.filter((r) => r.errorMessage).length;

    const byTool = new Map<
      string,
      { count: number; errorCount: number; durations: number[] }
    >();
    const bySource: Record<string, number> = {
      chat: 0, cron: 0, cli: 0, other: 0,
    };
    const byDay = new Map<string, { count: number; errorCount: number }>();
    const byCorrelation = new Map<string, number>();

    for (const r of rows) {
      const slot = byTool.get(r.tool) ?? { count: 0, errorCount: 0, durations: [] };
      slot.count += 1;
      if (r.errorMessage) slot.errorCount += 1;
      if (r.durationMs != null) slot.durations.push(r.durationMs);
      byTool.set(r.tool, slot);

      bySource[r.source] = (bySource[r.source] ?? 0) + 1;

      const day = r.createdAt.toISOString().slice(0, 10);
      const d = byDay.get(day) ?? { count: 0, errorCount: 0 };
      d.count += 1;
      if (r.errorMessage) d.errorCount += 1;
      byDay.set(day, d);

      if (r.correlationId) {
        byCorrelation.set(r.correlationId, (byCorrelation.get(r.correlationId) ?? 0) + 1);
      }
    }

    const percentile = (xs: number[], p: number) => {
      if (!xs.length) return null;
      const sorted = [...xs].sort((a, b) => a - b);
      const idx = Math.min(sorted.length - 1, Math.floor(((sorted.length - 1) * p) / 100));
      return sorted[idx];
    };

    const byToolArr = Array.from(byTool.entries())
      .map(([tool, v]) => ({
        tool,
        count: v.count,
        errorCount: v.errorCount,
        errorRate: v.count > 0 ? v.errorCount / v.count : 0,
        p50Ms: percentile(v.durations, 50),
        p95Ms: percentile(v.durations, 95),
      }))
      .sort((a, b) => b.count - a.count);

    const byDayArr = Array.from(byDay.entries())
      .map(([day, v]) => ({ day, count: v.count, errorCount: v.errorCount }))
      .sort((a, b) => a.day.localeCompare(b.day));

    const topCorrelations = Array.from(byCorrelation.entries())
      .map(([correlationId, count]) => ({ correlationId, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      data: {
        window: {
          start: cutoff.toISOString(),
          end: new Date().toISOString(),
          days: q.daysBack,
        },
        totals: {
          count: total,
          errorCount,
          errorRate: total > 0 ? errorCount / total : 0,
        },
        byTool: byToolArr,
        bySource,
        byDay: byDayArr,
        topCorrelations,
      },
    };
  });

  // GET /agent/gapo-thread/:userId — back-compat wrapper over the new
  // ChannelIdentity table. Returns the preferred Gapo identity (if any),
  // falling back to the legacy GapoUserMap row during the transition.
  // 404 if the user has no Gapo mapping at all.
  const userIdParam = z.object({ userId: z.coerce.number().int().positive() });
  app.get(
    "/gapo-thread/:userId",
    { schema: { params: userIdParam } },
    async (req, reply) => {
      const { userId } = req.params as z.infer<typeof userIdParam>;

      // Prefer ChannelIdentity (Sprint 6), then fall back to GapoUserMap.
      const ident = await app.prisma.channelIdentity.findFirst({
        where: { userId, channel: "gapo" },
        orderBy: [{ preferred: "desc" }, { lastSeenAt: "desc" }],
      });
      if (ident?.threadId) {
        return {
          data: {
            userId: ident.userId,
            gapoUserId: ident.externalId,
            gapoThreadId: ident.threadId,
            gapoFullName: ident.externalName,
          },
        };
      }

      const legacy = await app.prisma.gapoUserMap.findUnique({ where: { userId } });
      if (!legacy) return reply.code(404).send({ error: { code: "GAPO_USER_NOT_MAPPED" } });
      return {
        data: {
          userId: legacy.userId,
          gapoUserId: String(legacy.gapoUserId),
          gapoThreadId: String(legacy.gapoThreadId),
          gapoFullName: legacy.gapoFullName,
        },
      };
    }
  );

  // ── Sprint 6: Multi-channel identity ──────────────
  const channelKindEnum = z.enum([
    "gapo", "slack", "zalo", "zalouser", "telegram", "email", "sms",
  ]);

  // GET /agent/channel-identity/:userId — list all channels for a user.
  // Optional ?channel= filter. Orders preferred first, newest updated next.
  app.get(
    "/channel-identity/:userId",
    {
      schema: {
        params: userIdParam,
        querystring: z.object({ channel: channelKindEnum.optional() }),
      },
    },
    async (req) => {
      const { userId } = req.params as z.infer<typeof userIdParam>;
      const q = req.query as { channel?: z.infer<typeof channelKindEnum> };
      const where: any = { userId };
      if (q.channel) where.channel = q.channel;
      const rows = await app.prisma.channelIdentity.findMany({
        where,
        orderBy: [{ preferred: "desc" }, { lastSeenAt: "desc" }],
      });
      return { data: rows, meta: { total: rows.length } };
    }
  );

  // POST /agent/channel-identity — upsert mapping (admin/manager only).
  const identityBody = z.object({
    userId: z.number().int().positive(),
    channel: channelKindEnum,
    externalId: z.string().min(1).max(256),
    externalName: z.string().max(200).optional(),
    threadId: z.string().max(256).optional(),
    preferred: z.boolean().optional().default(false),
  });
  app.post("/channel-identity", { schema: { body: identityBody } }, async (req, reply) => {
    const b = req.body as z.infer<typeof identityBody>;
    // Only ADMIN/MANAGER can mint identities; agent service user is MANAGER
    // so bot-driven upserts (e.g. capturing new Gapo threads on first msg) work.
    if (
      !req.user.isSuperAdmin &&
      req.user.role !== "ADMIN" &&
      req.user.role !== "MANAGER"
    ) {
      return reply.code(403).send({ error: { code: "FORBIDDEN" } });
    }
    const user = await app.prisma.user.findFirst({
      where: req.user.isSuperAdmin
        ? { id: b.userId }
        : { id: b.userId, companyId: req.user.companyId },
      select: { id: true },
    });
    if (!user) return reply.code(404).send({ error: { code: "USER_NOT_FOUND" } });

    // If caller marks this preferred, unmark other rows for same (userId,channel).
    if (b.preferred) {
      await app.prisma.channelIdentity.updateMany({
        where: { userId: b.userId, channel: b.channel, preferred: true },
        data: { preferred: false },
      });
    }

    const row = await app.prisma.channelIdentity.upsert({
      where: { channel_externalId: { channel: b.channel, externalId: b.externalId } },
      create: {
        userId: b.userId,
        channel: b.channel,
        externalId: b.externalId,
        externalName: b.externalName ?? null,
        threadId: b.threadId ?? null,
        preferred: b.preferred ?? false,
      },
      update: {
        userId: b.userId,
        externalName: b.externalName ?? null,
        threadId: b.threadId ?? null,
        preferred: b.preferred ?? false,
        lastSeenAt: new Date(),
      },
    });
    return reply.code(201).send({ data: row });
  });

  app.delete("/channel-identity/:id", {
    schema: { params: z.object({ id: z.coerce.number().int().positive() }) },
  }, async (req, reply) => {
    if (
      !req.user.isSuperAdmin &&
      req.user.role !== "ADMIN" &&
      req.user.role !== "MANAGER"
    ) {
      return reply.code(403).send({ error: { code: "FORBIDDEN" } });
    }
    const { id } = req.params as any;
    const existing = await app.prisma.channelIdentity.findUnique({
      where: { id },
      include: { user: { select: { companyId: true } } },
    });
    if (!existing) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    if (!req.user.isSuperAdmin && existing.user.companyId !== req.user.companyId) {
      return reply.code(403).send({ error: { code: "FORBIDDEN" } });
    }
    await app.prisma.channelIdentity.delete({ where: { id } });
    return reply.code(204).send();
  });

  // ── Sprint 4: Agent memory ────────────────────────
  // Store per-run summaries so the orchestrator can recall context on a
  // later run (executive Q&A, follow-up-to-previous-ask, etc.).
  const memoryBody = z.object({
    conversationId: z.string().max(256).optional(),
    source: z.enum(["chat", "cron", "cli", "other"]).optional().default("chat"),
    userText: z.string().min(1),
    replyText: z.string().min(1),
    summary: z.string().min(1).max(4000),
    toolsUsed: z.array(z.string()).optional().default([]),
    projectIds: z.array(z.number().int().positive()).optional().default([]),
    taskIds: z.array(z.number().int().positive()).optional().default([]),
    correlationId: z.string().max(256).optional(),
  });

  app.post("/memory", { schema: { body: memoryBody } }, async (req, reply) => {
    const b = req.body as z.infer<typeof memoryBody>;
    const row = await app.prisma.agentMemory.create({
      data: {
        companyId: req.user.companyId,
        conversationId: b.conversationId ?? null,
        source: b.source,
        userText: b.userText,
        replyText: b.replyText,
        summary: b.summary,
        toolsUsed: b.toolsUsed,
        projectIds: b.projectIds,
        taskIds: b.taskIds,
        correlationId: b.correlationId ?? null,
      },
      select: { id: true, createdAt: true },
    });
    return reply.code(201).send({ data: row });
  });

  const memorySearchQuery = z.object({
    q: z.string().optional(),
    projectId: z.coerce.number().int().positive().optional(),
    taskId: z.coerce.number().int().positive().optional(),
    conversationId: z.string().optional(),
    daysBack: z.coerce.number().int().positive().max(365).optional().default(30),
    limit: z.coerce.number().int().positive().max(50).optional().default(5),
  });

  app.get("/memory/search", { schema: { querystring: memorySearchQuery } }, async (req) => {
    const q = req.query as z.infer<typeof memorySearchQuery>;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - q.daysBack);

    const where: any = {
      companyId: req.user.companyId,
      createdAt: { gte: cutoff },
    };
    if (q.conversationId) where.conversationId = q.conversationId;
    if (q.projectId) where.projectIds = { has: q.projectId };
    if (q.taskId) where.taskIds = { has: q.taskId };
    if (q.q) {
      where.OR = [
        { summary:  { contains: q.q, mode: "insensitive" } },
        { userText: { contains: q.q, mode: "insensitive" } },
        { replyText: { contains: q.q, mode: "insensitive" } },
      ];
    }

    const rows = await app.prisma.agentMemory.findMany({
      where,
      take: q.limit,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        createdAt: true,
        conversationId: true,
        source: true,
        userText: true,
        summary: true,
        toolsUsed: true,
        projectIds: true,
        taskIds: true,
      },
    });
    return { data: rows, meta: { total: rows.length, cutoff: cutoff.toISOString() } };
  });

  // ── Sprint 6.2: Agent follow-up tracking ──────────
  // Persistent record of every send_follow_up that fired. The Redis
  // cooldown enforces "don't double-ping"; this table answers
  // "who got pinged for what, and did they reply?".
  const followUpStatusEnum = z.enum(["PENDING", "REPLIED", "EXPIRED", "CANCELLED"]);

  const followUpBody = z.object({
    taskId: z.number().int().positive(),
    userId: z.number().int().positive(),
    channel: channelKindEnum.optional().default("gapo"),
    threadId: z.string().max(256).optional(),
    question: z.string().min(1).max(4000),
    correlationId: z.string().max(256).optional(),
  });

  app.post("/follow-up", { schema: { body: followUpBody } }, async (req, reply) => {
    const b = req.body as z.infer<typeof followUpBody>;
    const task = await app.prisma.task.findUnique({
      where: { id: b.taskId },
      select: { id: true, companyId: true, projectId: true },
    });
    if (!task) return reply.code(404).send({ error: { code: "TASK_NOT_FOUND" } });
    const user = await app.prisma.user.findFirst({
      where: req.user.isSuperAdmin
        ? { id: b.userId }
        : { id: b.userId, companyId: req.user.companyId },
      select: { id: true },
    });
    if (!user) return reply.code(404).send({ error: { code: "USER_NOT_FOUND" } });

    const row = await app.prisma.agentFollowUp.create({
      data: {
        taskId: b.taskId,
        userId: b.userId,
        channel: b.channel,
        threadId: b.threadId ?? null,
        question: b.question,
        correlationId: b.correlationId ?? null,
      },
      select: { id: true, askedAt: true, status: true },
    });
    return reply.code(201).send({ data: row });
  });

  const followUpListQuery = z.object({
    userId: z.coerce.number().int().positive().optional(),
    taskId: z.coerce.number().int().positive().optional(),
    status: followUpStatusEnum.optional(),
    daysBack: z.coerce.number().int().positive().max(365).optional().default(14),
    limit: z.coerce.number().int().positive().max(200).optional().default(50),
  });

  app.get("/follow-ups", { schema: { querystring: followUpListQuery } }, async (req) => {
    const q = req.query as z.infer<typeof followUpListQuery>;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - q.daysBack);

    const where: any = { askedAt: { gte: cutoff } };
    if (q.userId) where.userId = q.userId;
    if (q.taskId) where.taskId = q.taskId;
    if (q.status) where.status = q.status;
    // Company scope via task -> companyId. Super-admin bypass.
    if (!req.user.isSuperAdmin) {
      where.task = { companyId: req.user.companyId };
    }

    const rows = await app.prisma.agentFollowUp.findMany({
      where,
      take: q.limit,
      orderBy: { askedAt: "desc" },
      include: {
        task: { select: { id: true, name: true, status: true, project: { select: { id: true, name: true, code: true } } } },
        user: { select: { id: true, fullName: true, email: true } },
      },
    });
    return { data: rows, meta: { total: rows.length, cutoff: cutoff.toISOString() } };
  });

  const followUpUpdateBody = z.object({
    status: followUpStatusEnum,
    replyText: z.string().max(4000).optional(),
  });

  app.patch(
    "/follow-up/:id",
    {
      schema: {
        params: z.object({ id: z.coerce.number().int().positive() }),
        body: followUpUpdateBody,
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: number };
      const b = req.body as z.infer<typeof followUpUpdateBody>;
      const existing = await app.prisma.agentFollowUp.findUnique({
        where: { id },
        include: { task: { select: { companyId: true } } },
      });
      if (!existing) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      if (!req.user.isSuperAdmin && existing.task.companyId !== req.user.companyId) {
        return reply.code(403).send({ error: { code: "FORBIDDEN" } });
      }
      const row = await app.prisma.agentFollowUp.update({
        where: { id },
        data: {
          status: b.status,
          replyText: b.replyText ?? null,
          repliedAt: b.status === "REPLIED" ? new Date() : existing.repliedAt,
        },
        select: { id: true, status: true, repliedAt: true, replyText: true },
      });
      return { data: row };
    }
  );
};

export default agentRoutes;
