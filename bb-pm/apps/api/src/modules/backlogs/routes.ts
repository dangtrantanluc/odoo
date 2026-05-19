import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  backlogCreateSchema,
  backlogUpdateSchema,
  backlogRejectSchema,
  backlogListQuerySchema,
} from "@bb-pm/shared";
import { isBacklogTransitionAllowed } from "../../lib/transitions.js";
import {
  recomputeTaskTotals,
  recomputeProjectTotals,
} from "../../services/recompute.js";
import { notify, notifyMany, findCompanyAdmins } from "../../services/notify.js";

const idParam = z.object({ id: z.coerce.number().int().positive() });
const taskIdParam = z.object({ taskId: z.coerce.number().int().positive() });
const projectIdParam = z.object({ projectId: z.coerce.number().int().positive() });
const projectBacklogCreateSchema = backlogCreateSchema.extend({
  taskId: z.number().int().positive().optional(),
});

const backlogsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  // ── LIST ──────────────────────────────────────────
  app.get("/", { schema: { querystring: backlogListQuerySchema } }, async (req) => {
    const q = req.query as z.infer<typeof backlogListQuerySchema>;
    const where: any = {};
    if (!req.user.isSuperAdmin) where.project = { companyId: req.user.companyId };
    if (q.status) where.status = q.status;
    if (q.userId) where.userId = q.userId;
    if (q.mine) where.userId = req.user.id;
    if (q.projectId) where.projectId = q.projectId;
    if (q.taskId) where.taskId = q.taskId;
    if (q.workDateFrom || q.workDateTo) {
      where.workDate = {
        gte: q.workDateFrom ? new Date(q.workDateFrom) : undefined,
        lte: q.workDateTo ? new Date(q.workDateTo) : undefined,
      };
    }

    const orderBy = parseSort(q.sort ?? "-workDate");
    const [total, data] = await app.prisma.$transaction([
      app.prisma.backlog.count({ where }),
      app.prisma.backlog.findMany({
        where,
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        orderBy,
        include: {
          task:     { select: { id: true, name: true } },
          project:  { select: { id: true, name: true, code: true } },
          user:     { select: { id: true, fullName: true, avatarUrl: true } },
          approver: { select: { id: true, fullName: true } },
          currency: { select: { id: true, code: true, symbol: true } },
        },
      }),
    ]);
    return { data, meta: { page: q.page, pageSize: q.pageSize, total } };
  });

  // ── CREATE under task ─────────────────────────────
  app.post("/by-task/:taskId", {
    schema: { params: taskIdParam, body: backlogCreateSchema },
  }, async (req, reply) => {
    if (req.user.role === "VIEWER" && !req.user.isSuperAdmin) {
      return reply.code(403).send({ error: { code: "FORBIDDEN" } });
    }
    const { taskId } = req.params as any;
    const body = req.body as z.infer<typeof backlogCreateSchema>;

    const task = await app.prisma.task.findFirst({
      where: req.user.isSuperAdmin ? { id: taskId } : { id: taskId, project: { companyId: req.user.companyId } },
      include: { project: true },
    });
    if (!task) return reply.code(404).send({ error: { code: "TASK_NOT_FOUND" } });

    // Snapshot cost: look up active rate for (projectId, userId, workDate)
    const workDate = new Date(body.workDate);
    const rate = await app.prisma.memberRate.findFirst({
      where: {
        member: { projectId: task.projectId, userId: req.user.id },
        effectiveFrom: { lte: workDate },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: workDate } }],
      },
      orderBy: { effectiveFrom: "desc" },
    });
    const costPerHour = rate?.costPerHour ?? null;
    const totalCost = costPerHour ? Number(costPerHour) * Number(body.hours) : null;

    const backlog = await app.prisma.backlog.create({
      data: {
        workDate,
        hours: body.hours,
        description: body.description,
        status: "PENDING",
        taskId,
        projectId: task.projectId,
        companyId: task.project.companyId,
        userId: req.user.id,
        currencyId: rate?.currencyId ?? task.currencyId ?? task.project.currencyId,
        costPerHourSnapshot: costPerHour,
        totalCostSnapshot: totalCost as any,
      },
    });

    await app.prisma.project.update({
      where: { id: task.projectId },
      data: { backlogCount: { increment: 1 } },
    });

    // Notify company admins about new pending backlog
    const admins = await findCompanyAdmins(app.prisma, task.project.companyId);
    await notifyMany(
      app.prisma,
      admins
        .filter(a => a.id !== req.user.id)
        .map(a => ({
          userId: a.id,
          type: "backlog_pending",
          title: "Backlog chờ duyệt",
          message: `${req.user.email} log ${body.hours}h cho "${task.name}"`,
          link: `/backlogs`,
        })),
    );

    return reply.code(201).send({ data: backlog });
  });

  // ── CREATE under project (task optional) ─────────
  app.post("/by-project/:projectId", {
    schema: { params: projectIdParam, body: projectBacklogCreateSchema },
  }, async (req, reply) => {
    if (req.user.role === "VIEWER" && !req.user.isSuperAdmin) {
      return reply.code(403).send({ error: { code: "FORBIDDEN" } });
    }
    const { projectId } = req.params as any;
    const body = req.body as z.infer<typeof projectBacklogCreateSchema>;
    const project = await app.prisma.project.findFirst({
      where: req.user.isSuperAdmin ? { id: projectId } : { id: projectId, companyId: req.user.companyId },
    });
    if (!project) return reply.code(404).send({ error: { code: "PROJECT_NOT_FOUND" } });
    const task = body.taskId
      ? await app.prisma.task.findFirst({ where: { id: body.taskId, projectId } })
      : null;
    if (body.taskId && !task) return reply.code(404).send({ error: { code: "TASK_NOT_FOUND" } });
    const workDate = new Date(body.workDate);
    const rate = await app.prisma.memberRate.findFirst({
      where: {
        member: { projectId, userId: req.user.id },
        effectiveFrom: { lte: workDate },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: workDate } }],
      },
      orderBy: { effectiveFrom: "desc" },
    });
    const costPerHour = rate?.costPerHour ?? null;
    const totalCost = costPerHour ? Number(costPerHour) * Number(body.hours) : null;
    const backlog = await app.prisma.backlog.create({
      data: {
        workDate,
        hours: body.hours,
        description: body.description,
        status: "PENDING",
        taskId: task?.id ?? null,
        projectId,
        companyId: project.companyId,
        userId: req.user.id,
        currencyId: rate?.currencyId ?? task?.currencyId ?? project.currencyId,
        costPerHourSnapshot: costPerHour,
        totalCostSnapshot: totalCost as any,
      },
    });
    await app.prisma.project.update({ where: { id: projectId }, data: { backlogCount: { increment: 1 } } });
    return reply.code(201).send({ data: backlog });
  });

  // ── UPDATE (owner + PENDING only, or admin) ───────
  app.patch("/:id", { schema: { params: idParam, body: backlogUpdateSchema } }, async (req, reply) => {
    const { id } = req.params as any;
    const existing = await app.prisma.backlog.findFirst({ where: blScope(req, id) });
    if (!existing) return reply.code(404).send({ error: { code: "BACKLOG_NOT_FOUND" } });

    const isOwner = existing.userId === req.user.id;
    const isAdmin = req.user.role === "ADMIN" || req.user.isSuperAdmin;
    if (!isAdmin && !(isOwner && existing.status === "PENDING")) {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Only owner of a PENDING backlog can edit" } });
    }

    const body = req.body as any;
    const workDate = body.workDate ? new Date(body.workDate) : existing.workDate;
    const hours = body.hours ?? Number(existing.hours);

    // Re-snapshot if workDate or hours changed and backlog still pending
    let costPerHour = existing.costPerHourSnapshot;
    let totalCost = existing.totalCostSnapshot;
    if (existing.status === "PENDING" && (body.workDate || body.hours !== undefined)) {
      const rate = await app.prisma.memberRate.findFirst({
        where: {
          member: { projectId: existing.projectId!, userId: existing.userId },
          effectiveFrom: { lte: workDate },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: workDate } }],
        },
        orderBy: { effectiveFrom: "desc" },
      });
      costPerHour = rate?.costPerHour ?? null;
      totalCost = costPerHour ? (Number(costPerHour) * Number(hours)) as any : null;
    }

    const updated = await app.prisma.backlog.update({
      where: { id },
      data: {
        workDate,
        hours,
        description: body.description,
        costPerHourSnapshot: costPerHour,
        totalCostSnapshot: totalCost,
      },
    });

    // If it was APPROVED and hours changed, recompute totals
    if (existing.status === "APPROVED" && body.hours !== undefined) {
      await app.prisma.$transaction(async (tx) => {
        if (existing.taskId) await recomputeTaskTotals(tx, existing.taskId);
        if (existing.projectId) await recomputeProjectTotals(tx, existing.projectId);
      });
    }
    return { data: updated };
  });

  // ── DELETE ────────────────────────────────────────
  app.delete("/:id", { schema: { params: idParam } }, async (req, reply) => {
    const { id } = req.params as any;
    const existing = await app.prisma.backlog.findFirst({ where: blScope(req, id) });
    if (!existing) return reply.code(404).send({ error: { code: "BACKLOG_NOT_FOUND" } });
    const isOwner = existing.userId === req.user.id;
    const isAdmin = req.user.role === "ADMIN" || req.user.isSuperAdmin;
    if (!isAdmin && !(isOwner && existing.status === "PENDING")) {
      return reply.code(403).send({ error: { code: "FORBIDDEN" } });
    }

    const wasApproved = existing.status === "APPROVED";
    await app.prisma.backlog.delete({ where: { id } });
    if (existing.projectId) {
      await app.prisma.project.update({
        where: { id: existing.projectId },
        data: { backlogCount: { decrement: 1 } },
      });
    }
    if (wasApproved) {
      await app.prisma.$transaction(async (tx) => {
        if (existing.taskId) await recomputeTaskTotals(tx, existing.taskId);
        if (existing.projectId) await recomputeProjectTotals(tx, existing.projectId);
      });
    }
    return reply.code(204).send();
  });

  // ── APPROVE (ADMIN) ───────────────────────────────
  app.post("/:id/approve", {
    preHandler: [app.requireRole("ADMIN")],
    schema: { params: idParam },
  }, async (req, reply) => {
    const { id } = req.params as any;
    const existing = await app.prisma.backlog.findFirst({ where: blScope(req, id) });
    if (!existing) return reply.code(404).send({ error: { code: "BACKLOG_NOT_FOUND" } });
    if (!isBacklogTransitionAllowed(existing.status, "APPROVED")) {
      return reply.code(400).send({ error: { code: "INVALID_TRANSITION" } });
    }
    const updated = await app.prisma.$transaction(async (tx) => {
      const u = await tx.backlog.update({
        where: { id },
        data: { status: "APPROVED", approverId: req.user.id, approvedAt: new Date(), rejectedReason: null },
      });
      if (existing.taskId) await recomputeTaskTotals(tx, existing.taskId);
      if (existing.projectId) await recomputeProjectTotals(tx, existing.projectId);
      await notify(tx, {
        userId: existing.userId,
        type: "backlog_approved",
        title: "Backlog đã được duyệt",
        message: `Backlog ngày ${existing.workDate.toISOString().slice(0,10)} (${existing.hours}h)`,
        link: "/backlogs",
      });
      return u;
    });
    return { data: updated };
  });

  // ── REJECT (ADMIN) ────────────────────────────────
  app.post("/:id/reject", {
    preHandler: [app.requireRole("ADMIN")],
    schema: { params: idParam, body: backlogRejectSchema },
  }, async (req, reply) => {
    const { id } = req.params as any;
    const { reason } = req.body as any;
    const existing = await app.prisma.backlog.findFirst({ where: blScope(req, id) });
    if (!existing) return reply.code(404).send({ error: { code: "BACKLOG_NOT_FOUND" } });
    if (!isBacklogTransitionAllowed(existing.status, "REJECTED")) {
      return reply.code(400).send({ error: { code: "INVALID_TRANSITION" } });
    }
    const wasApproved = existing.status === "APPROVED";
    const updated = await app.prisma.$transaction(async (tx) => {
      const u = await tx.backlog.update({
        where: { id },
        data: { status: "REJECTED", approverId: req.user.id, approvedAt: new Date(), rejectedReason: reason },
      });
      if (wasApproved) {
        if (existing.taskId) await recomputeTaskTotals(tx, existing.taskId);
        if (existing.projectId) await recomputeProjectTotals(tx, existing.projectId);
      }
      await notify(tx, {
        userId: existing.userId,
        type: "backlog_rejected",
        title: "Backlog bị từ chối",
        message: reason,
        link: "/backlogs",
      });
      return u;
    });
    return { data: updated };
  });

  // ── RESET (ADMIN) ─────────────────────────────────
  app.post("/:id/reset", {
    preHandler: [app.requireRole("ADMIN")],
    schema: { params: idParam },
  }, async (req, reply) => {
    const { id } = req.params as any;
    const existing = await app.prisma.backlog.findFirst({ where: blScope(req, id) });
    if (!existing) return reply.code(404).send({ error: { code: "BACKLOG_NOT_FOUND" } });
    if (!isBacklogTransitionAllowed(existing.status, "PENDING")) {
      return reply.code(400).send({ error: { code: "INVALID_TRANSITION" } });
    }
    const wasApproved = existing.status === "APPROVED";
    const updated = await app.prisma.$transaction(async (tx) => {
      const u = await tx.backlog.update({
        where: { id },
        data: { status: "PENDING", approverId: null, approvedAt: null, rejectedReason: null },
      });
      if (wasApproved) {
        if (existing.taskId) await recomputeTaskTotals(tx, existing.taskId);
        if (existing.projectId) await recomputeProjectTotals(tx, existing.projectId);
      }
      return u;
    });
    return { data: updated };
  });
};

function blScope(req: any, id: number) {
  return req.user.isSuperAdmin
    ? { id }
    : { id, project: { companyId: req.user.companyId } };
}

function parseSort(s: string) {
  return s.split(",").map(token => {
    const desc = token.startsWith("-");
    const field = desc ? token.slice(1) : token;
    return { [field]: desc ? "desc" : "asc" } as any;
  });
}

export default backlogsRoutes;
