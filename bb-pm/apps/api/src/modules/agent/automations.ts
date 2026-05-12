// Phase 4 — Automation CRUD endpoints.
//   POST   /agent/automations       — register new automation
//   GET    /agent/automations       — list (filter by active/owner)
//   GET    /agent/automations/:id   — fetch one
//   DELETE /agent/automations/:id   — soft-delete (set active=false)
//   POST   /agent/automations/:id/run-now — trigger workflow immediately
//
// Hook into scheduler: scheduler load on boot + listen for active=true changes
// (Phase 4.1 nếu cần — Phase 4 MVP chỉ load on boot, restart gateway để pick
// up new entries).

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

// Sanity check — allow digits, common cron chars, and weekday/month abbrevs (MON-SUN, JAN-DEC)
const cronRe = /^[\dA-Za-z*/,\- ]+$/;
const createBody = z.object({
  name: z.string().min(1).max(200),
  workflow: z.string().min(1).max(64),
  schedule: z.string().min(3).max(128).regex(cronRe, "schedule phải là cron expression"),
  inputs: z.record(z.any()).optional().default({}),
  target: z.string().max(256).optional(),
  ownerId: z.number().int().positive().optional(),       // default = caller
});

const listQuery = z.object({
  active: z.coerce.boolean().optional(),
  ownerId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(200).optional().default(50),
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

const automationsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  // POST — create
  app.post("/", { schema: { body: createBody } }, async (req, reply) => {
    const body = req.body as z.infer<typeof createBody>;
    const user = (req as any).user;

    // Hard limit per company — anti-runaway (vd LLM tạo loạn)
    const ACTIVE_LIMIT_PER_COMPANY = 50;
    const existing = await app.prisma.automation.count({
      where: { companyId: user.companyId, active: true },
    });
    if (existing >= ACTIVE_LIMIT_PER_COMPANY) {
      return reply.code(429).send({
        error: { code: "AUTOMATION_LIMIT", message: `Max ${ACTIVE_LIMIT_PER_COMPANY} active per company.` },
      });
    }

    const ownerId = body.ownerId ?? user.id;
    const row = await app.prisma.automation.create({
      data: {
        name: body.name,
        workflow: body.workflow,
        schedule: body.schedule,
        inputs: body.inputs,
        target: body.target ?? null,
        ownerId,
        companyId: user.companyId,
      },
    });
    return reply.code(201).send({ data: row });
  });

  // GET — list
  app.get("/", { schema: { querystring: listQuery } }, async (req) => {
    const q = req.query as z.infer<typeof listQuery>;
    const user = (req as any).user;
    const where: any = user.isSuperAdmin ? {} : { companyId: user.companyId };
    if (q.active !== undefined) where.active = q.active;
    if (q.ownerId) where.ownerId = q.ownerId;
    const rows = await app.prisma.automation.findMany({
      where,
      orderBy: [{ active: "desc" }, { createdAt: "desc" }],
      take: q.limit,
    });
    return { data: rows, meta: { total: rows.length } };
  });

  // GET :id — fetch
  app.get("/:id", { schema: { params: idParam } }, async (req, reply) => {
    const { id } = req.params as any;
    const user = (req as any).user;
    const where: any = user.isSuperAdmin ? { id } : { id, companyId: user.companyId };
    const row = await app.prisma.automation.findFirst({ where });
    if (!row) return reply.code(404).send({ error: { code: "AUTOMATION_NOT_FOUND" } });
    return { data: row };
  });

  // DELETE — soft delete (set active=false). Scheduler unregister on next boot
  // (Phase 4 MVP) hoặc qua emit event (Phase 4.1).
  app.delete("/:id", { schema: { params: idParam } }, async (req, reply) => {
    const { id } = req.params as any;
    const user = (req as any).user;
    const existing = await app.prisma.automation.findFirst({
      where: user.isSuperAdmin ? { id } : { id, companyId: user.companyId },
    });
    if (!existing) return reply.code(404).send({ error: { code: "AUTOMATION_NOT_FOUND" } });
    await app.prisma.automation.update({
      where: { id },
      data: { active: false },
    });
    return reply.code(204).send();
  });

  // POST :id/run-now — synthesize a run record (actual execution by plugin).
  // Plugin sẽ poll này hoặc dùng webhook ở Phase 4.1.
  app.post("/:id/run-now", { schema: { params: idParam } }, async (req, reply) => {
    const { id } = req.params as any;
    const user = (req as any).user;
    const row = await app.prisma.automation.findFirst({
      where: user.isSuperAdmin ? { id } : { id, companyId: user.companyId },
    });
    if (!row) return reply.code(404).send({ error: { code: "AUTOMATION_NOT_FOUND" } });
    if (!row.active) {
      return reply.code(409).send({ error: { code: "AUTOMATION_INACTIVE" } });
    }
    // Phase 4 MVP: trả ra automation entry để plugin tự execute. Không
    // queue/exec ở backend — plugin có workflow registry.
    return { data: { automation: row, action: "execute_now" } };
  });

  // PATCH — update lastRun status (called by plugin scheduler after each tick)
  const patchBody = z.object({
    active: z.boolean().optional(),
    lastRunAt: z.string().datetime().optional(),
    lastRunStatus: z.enum(["ok", "error"]).optional(),
    lastRunError: z.string().max(2000).optional().nullable(),
    consecutiveFails: z.number().int().nonnegative().optional(),
  });
  app.patch("/:id", { schema: { params: idParam, body: patchBody } }, async (req, reply) => {
    const { id } = req.params as any;
    const user = (req as any).user;
    const existing = await app.prisma.automation.findFirst({
      where: user.isSuperAdmin ? { id } : { id, companyId: user.companyId },
    });
    if (!existing) return reply.code(404).send({ error: { code: "AUTOMATION_NOT_FOUND" } });
    const body = req.body as z.infer<typeof patchBody>;
    const data: any = { ...body };
    if (data.lastRunAt) data.lastRunAt = new Date(data.lastRunAt);
    const updated = await app.prisma.automation.update({ where: { id }, data });
    return { data: updated };
  });
};

export default automationsRoutes;
