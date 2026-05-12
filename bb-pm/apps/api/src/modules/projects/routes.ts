import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  projectCreateSchema,
  projectUpdateSchema,
  projectTransitionSchema,
  projectListQuerySchema,
} from "@bb-pm/shared";
import { isProjectTransitionAllowed } from "../../lib/transitions.js";

const idParam = z.object({ id: z.coerce.number().int().positive() });

const projectsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  // ── AGENT: WEEKLY REPORT (Sprint 4) ───────────────
  // Richer rollup than /digest — adds activity deltas over a window
  // (default 7 days): tasks done, blockers opened, backlog hours approved,
  // upcoming deadlines. Used by generate_weekly_report tool.
  const weeklyQuery = z.object({
    days: z.coerce.number().int().positive().max(90).optional().default(7),
    projectId: z.coerce.number().int().positive().optional(),
  });
  app.get("/weekly-report", { schema: { querystring: weeklyQuery } }, async (req) => {
    const q = req.query as z.infer<typeof weeklyQuery>;
    const now = new Date();
    const windowStart = new Date(now.getTime() - q.days * 86_400_000);
    const windowEnd = new Date(now.getTime() + q.days * 86_400_000);
    const scope: any = req.user.isSuperAdmin ? {} : { companyId: req.user.companyId };
    const projectWhere: any = { ...scope };
    if (q.projectId) projectWhere.id = q.projectId;

    const taskScope: any = { project: projectWhere };

    const [projects, tasksDone, newBlockers, backlogsApproved, upcomingDeadlines, newTasks] =
      await app.prisma.$transaction([
        app.prisma.project.findMany({
          where: { ...projectWhere, status: { in: ["PLANNED", "IN_PROGRESS"] } },
          select: {
            id: true, name: true, code: true, status: true, endDate: true,
            taskCount: true, totalHours: true, totalCost: true,
            _count: { select: { tasks: { where: { status: "DONE" } } } },
          },
          orderBy: [{ status: "asc" }, { endDate: "asc" }],
        }),
        app.prisma.task.count({
          where: { ...taskScope, status: "DONE", updatedAt: { gte: windowStart } },
        }),
        app.prisma.taskBlocker.count({
          where: {
            createdAt: { gte: windowStart },
            task: { project: projectWhere } as any,
          },
        }),
        app.prisma.backlog.aggregate({
          where: {
            status: "APPROVED",
            approvedAt: { gte: windowStart },
            project: projectWhere,
          },
          _sum: { hours: true, totalCostSnapshot: true },
          _count: true,
        }),
        app.prisma.task.findMany({
          where: {
            ...taskScope,
            status: { not: "DONE" },
            deadline: { gte: now, lte: windowEnd },
          },
          take: 20,
          orderBy: { deadline: "asc" },
          select: {
            id: true, name: true, deadline: true, priority: true,
            project: { select: { id: true, name: true, code: true } },
            assignee: { select: { id: true, fullName: true } },
          },
        }),
        app.prisma.task.count({
          where: { ...taskScope, createdAt: { gte: windowStart } },
        }),
      ]);

    return {
      data: {
        generatedAt: now.toISOString(),
        window: { start: windowStart.toISOString(), end: now.toISOString(), days: q.days },
        totals: {
          activeProjects: projects.length,
          newTasks,
          tasksDone,
          newBlockers,
          backlogsApproved: backlogsApproved._count ?? 0,
          hoursApproved: Number(backlogsApproved._sum.hours ?? 0),
          costApproved: Number(backlogsApproved._sum.totalCostSnapshot ?? 0),
        },
        projects: projects.map((p) => ({
          id: p.id,
          name: p.name,
          code: p.code,
          status: p.status,
          endDate: p.endDate,
          taskCount: p.taskCount,
          doneTaskCount: p._count.tasks,
          completionPct: p.taskCount > 0
            ? Math.round((100 * p._count.tasks) / p.taskCount)
            : null,
          totalHours: Number(p.totalHours),
          totalCost: Number(p.totalCost),
        })),
        upcomingDeadlines: upcomingDeadlines.map((t) => ({
          id: t.id,
          name: t.name,
          deadline: t.deadline,
          priority: t.priority,
          project: t.project,
          assignee: t.assignee,
        })),
      },
    };
  });

  // ── AGENT: DIGEST ─────────────────────────────────
  // Cross-project rollup for daily digest. Company-scoped; returns active
  // projects + global open/overdue/stale/unassigned counters.
  app.get("/digest", async (req) => {
    const scope: any = req.user.isSuperAdmin ? {} : { companyId: req.user.companyId };
    const now = new Date();
    const staleCutoff = new Date(now.getTime() - 7 * 86_400_000);

    const activeProjects = await app.prisma.project.findMany({
      where: { ...scope, status: { in: ["PLANNED", "IN_PROGRESS"] } },
      select: {
        id: true, name: true, code: true, status: true, endDate: true,
        taskCount: true,
        _count: { select: { tasks: { where: { status: "DONE" } } } },
      },
      orderBy: [{ status: "asc" }, { endDate: "asc" }],
    });

    const taskScope: any = { project: scope };
    const [openTasks, overdueTasks, staleTasks, unassignedTasks] =
      await app.prisma.$transaction([
        app.prisma.task.count({ where: { ...taskScope, status: { not: "DONE" } } }),
        app.prisma.task.count({
          where: {
            ...taskScope,
            status: { not: "DONE" },
            deadline: { not: null, lt: now },
          },
        }),
        app.prisma.task.count({
          where: {
            ...taskScope,
            status: { not: "DONE" },
            updatedAt: { lt: staleCutoff },
          },
        }),
        app.prisma.task.count({
          where: { ...taskScope, status: { not: "DONE" }, assigneeId: null },
        }),
      ]);

    return {
      data: {
        generatedAt: now.toISOString(),
        totals: {
          activeProjects: activeProjects.length,
          openTasks,
          overdueTasks,
          staleTasks,
          unassignedTasks,
        },
        projects: activeProjects.map((p) => ({
          id: p.id,
          name: p.name,
          code: p.code,
          status: p.status,
          endDate: p.endDate,
          taskCount: p.taskCount,
          doneTaskCount: p._count.tasks,
          completionPct: p.taskCount > 0
            ? Math.round((100 * p._count.tasks) / p.taskCount)
            : null,
        })),
      },
    };
  });

  // ── LIST ──────────────────────────────────────────
  app.get("/", { schema: { querystring: projectListQuerySchema } }, async (req) => {
    const q = req.query as z.infer<typeof projectListQuerySchema>;
    const where: any = {};
    if (!req.user.isSuperAdmin) where.companyId = req.user.companyId;
    if (q.status) where.status = q.status;
    if (q.customerId) where.customerId = q.customerId;
    if (q.tagId) where.tags = { some: { tagId: q.tagId } };
    if (q.q) where.OR = [{ name: { contains: q.q, mode: "insensitive" } }, { code: { contains: q.q, mode: "insensitive" } }];

    const orderBy = parseSort(q.sort ?? "-updatedAt");
    const [total, data] = await app.prisma.$transaction([
      app.prisma.project.count({ where }),
      app.prisma.project.findMany({
        where,
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        orderBy,
        include: {
          owner:    { select: { id: true, fullName: true, avatarUrl: true } },
          customer: { select: { id: true, name: true } },
          currency: { select: { id: true, code: true, symbol: true } },
          tags:     { select: { tag: { select: { id: true, name: true, color: true } } } },
        },
      }),
    ]);

    return {
      data: data.map(p => ({ ...p, tags: p.tags.map(t => t.tag) })),
      meta: { page: q.page, pageSize: q.pageSize, total },
    };
  });

  // ── DETAIL ────────────────────────────────────────
  app.get("/:id", { schema: { params: idParam } }, async (req, reply) => {
    const { id } = req.params as any;
    const p = await app.prisma.project.findFirst({
      where: scopeByCompany(req, id),
      include: {
        owner:          { select: { id: true, fullName: true, avatarUrl: true } },
        accountManager: { select: { id: true, fullName: true, avatarUrl: true } },
        customer:       true,
        currency:       { select: { id: true, code: true, symbol: true } },
        tags:           { select: { tag: { select: { id: true, name: true, color: true } } } },
        milestones:     { orderBy: { dueDate: "asc" } },
        members: {
          include: { user: { select: { id: true, fullName: true, email: true, avatarUrl: true } } },
        },
        _count: { select: { tasks: true, backlogs: true, scopes: true, milestones: true, members: true } },
      },
    });
    if (!p) return reply.code(404).send({ error: { code: "PROJECT_NOT_FOUND" } });
    return { data: { ...p, tags: p.tags.map(t => t.tag) } };
  });

  // ── CREATE ────────────────────────────────────────
  app.post("/", {
    preHandler: [app.requireRole("ADMIN", "MANAGER")],
    schema: { body: projectCreateSchema },
  }, async (req, reply) => {
    const body = req.body as z.infer<typeof projectCreateSchema>;
    const { tagIds, ...rest } = body;
    const project = await app.prisma.project.create({
      data: {
        ...rest,
        startDate: rest.startDate ? new Date(rest.startDate) : undefined,
        endDate: rest.endDate ? new Date(rest.endDate) : undefined,
        companyId: req.user.companyId,
        budgetRemaining: rest.budget ?? 0,
        tags: tagIds?.length ? { create: tagIds.map(tagId => ({ tagId })) } : undefined,
      },
    });
    return reply.code(201).send({ data: project });
  });

  // ── UPDATE ────────────────────────────────────────
  app.patch("/:id", {
    preHandler: [app.requireRole("ADMIN", "MANAGER")],
    schema: { params: idParam, body: projectUpdateSchema },
  }, async (req, reply) => {
    const { id } = req.params as any;
    const body = req.body as z.infer<typeof projectUpdateSchema>;
    const existing = await app.prisma.project.findFirst({ where: scopeByCompany(req, id) });
    if (!existing) return reply.code(404).send({ error: { code: "PROJECT_NOT_FOUND" } });

    const { tagIds, ...rest } = body;
    const project = await app.prisma.$transaction(async (tx) => {
      const updated = await tx.project.update({
        where: { id },
        data: {
          ...rest,
          startDate: rest.startDate ? new Date(rest.startDate) : undefined,
          endDate: rest.endDate ? new Date(rest.endDate) : undefined,
        },
      });
      if (tagIds) {
        await tx.projectTag.deleteMany({ where: { projectId: id } });
        if (tagIds.length) {
          await tx.projectTag.createMany({ data: tagIds.map(tagId => ({ projectId: id, tagId })) });
        }
      }
      return updated;
    });
    return { data: project };
  });

  // ── DELETE ────────────────────────────────────────
  app.delete("/:id", {
    preHandler: [app.requireRole("ADMIN", "MANAGER")],
    schema: { params: idParam },
  }, async (req, reply) => {
    const { id } = req.params as any;
    const existing = await app.prisma.project.findFirst({ where: scopeByCompany(req, id) });
    if (!existing) return reply.code(404).send({ error: { code: "PROJECT_NOT_FOUND" } });
    await app.prisma.project.delete({ where: { id } });
    return reply.code(204).send();
  });

  // ── TRANSITION ────────────────────────────────────
  app.post("/:id/transition", {
    preHandler: [app.requireRole("ADMIN", "MANAGER")],
    schema: { params: idParam, body: projectTransitionSchema },
  }, async (req, reply) => {
    const { id } = req.params as any;
    const { status } = req.body as any;
    const existing = await app.prisma.project.findFirst({ where: scopeByCompany(req, id) });
    if (!existing) return reply.code(404).send({ error: { code: "PROJECT_NOT_FOUND" } });
    if (!isProjectTransitionAllowed(existing.status, status, req.user.role, req.user.isSuperAdmin)) {
      return reply.code(400).send({
        error: { code: "INVALID_TRANSITION", message: `Cannot move from ${existing.status} to ${status}` },
      });
    }
    const updated = await app.prisma.project.update({ where: { id }, data: { status } });
    return { data: updated };
  });
};

function scopeByCompany(req: any, id: number) {
  return req.user.isSuperAdmin ? { id } : { id, companyId: req.user.companyId };
}

function parseSort(s: string) {
  return s.split(",").map(token => {
    const desc = token.startsWith("-");
    const field = desc ? token.slice(1) : token;
    return { [field]: desc ? "desc" : "asc" } as any;
  });
}

export default projectsRoutes;
