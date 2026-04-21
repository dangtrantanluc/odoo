import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  taskCreateSchema,
  taskUpdateSchema,
  taskTransitionSchema,
  taskListQuerySchema,
} from "@bb-pm/shared";
import { isTaskTransitionAllowed } from "../../lib/transitions.js";
import { recomputeMilestoneProgress } from "../../services/recompute.js";
import { notify } from "../../services/notify.js";

const idParam = z.object({ id: z.coerce.number().int().positive() });
const projectIdParam = z.object({ projectId: z.coerce.number().int().positive() });

const tasksRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  // ── LIST ──────────────────────────────────────────
  app.get("/", { schema: { querystring: taskListQuerySchema } }, async (req) => {
    const q = req.query as z.infer<typeof taskListQuerySchema>;
    const where: any = {};
    if (!req.user.isSuperAdmin) where.project = { companyId: req.user.companyId };
    if (q.projectId) where.projectId = q.projectId;
    if (q.status) where.status = q.status;
    if (q.assigneeId) where.assigneeId = q.assigneeId;
    if (q.milestoneId) where.milestoneId = q.milestoneId;
    if (q.tagId) where.tags = { some: { tagId: q.tagId } };
    if (q.q) where.name = { contains: q.q, mode: "insensitive" };

    const orderBy = parseSort(q.sort ?? "-updatedAt");
    const [total, data] = await app.prisma.$transaction([
      app.prisma.task.count({ where }),
      app.prisma.task.findMany({
        where,
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        orderBy,
        include: {
          project:   { select: { id: true, name: true, code: true } },
          assignee:  { select: { id: true, fullName: true, avatarUrl: true } },
          milestone: { select: { id: true, name: true } },
          tags:      { select: { tag: { select: { id: true, name: true, color: true } } } },
          _count:    { select: { backlogs: true } },
        },
      }),
    ]);
    return {
      data: data.map(t => ({ ...t, tags: t.tags.map(x => x.tag) })),
      meta: { page: q.page, pageSize: q.pageSize, total },
    };
  });

  // ── DETAIL ────────────────────────────────────────
  app.get("/:id", { schema: { params: idParam } }, async (req, reply) => {
    const { id } = req.params as any;
    const t = await app.prisma.task.findFirst({
      where: taskScope(req, id),
      include: {
        project:   { select: { id: true, name: true, code: true, currency: true } },
        assignee:  { select: { id: true, fullName: true, email: true, avatarUrl: true } },
        milestone: true,
        tags:      { select: { tag: true } },
        _count:    { select: { backlogs: true } },
      },
    });
    if (!t) return reply.code(404).send({ error: { code: "TASK_NOT_FOUND" } });
    return { data: { ...t, tags: t.tags.map(x => x.tag) } };
  });

  // ── CREATE (nested under project) ─────────────────
  app.post("/by-project/:projectId", {
    preHandler: [app.requireRole("ADMIN", "MANAGER", "MEMBER")],
    schema: { params: projectIdParam, body: taskCreateSchema },
  }, async (req, reply) => {
    const { projectId } = req.params as any;
    const body = req.body as z.infer<typeof taskCreateSchema>;
    const project = await app.prisma.project.findFirst({
      where: req.user.isSuperAdmin ? { id: projectId } : { id: projectId, companyId: req.user.companyId },
    });
    if (!project) return reply.code(404).send({ error: { code: "PROJECT_NOT_FOUND" } });

    const { tagIds, ...rest } = body;
    const task = await app.prisma.task.create({
      data: {
        ...rest,
        projectId,
        companyId: project.companyId,
        currencyId: rest.currencyId ?? project.currencyId ?? undefined,
        deadline: rest.deadline ? new Date(rest.deadline) : undefined,
        endAt: rest.endAt ? new Date(rest.endAt) : undefined,
        tags: tagIds?.length ? { create: tagIds.map(tagId => ({ tagId })) } : undefined,
      },
    });

    await bumpProjectTaskCount(app, projectId);
    if (task.milestoneId) await recomputeMilestoneProgress(app.prisma, task.milestoneId);
    if (task.assigneeId && task.assigneeId !== req.user.id) {
      await notify(app.prisma, {
        userId: task.assigneeId,
        type: "task_assigned",
        title: "Bạn được assign task mới",
        message: task.name,
        link: `/projects/${projectId}?tab=tasks`,
      });
    }
    return reply.code(201).send({ data: task });
  });

  // ── UPDATE ────────────────────────────────────────
  app.patch("/:id", {
    preHandler: [app.requireRole("ADMIN", "MANAGER", "MEMBER")],
    schema: { params: idParam, body: taskUpdateSchema },
  }, async (req, reply) => {
    const { id } = req.params as any;
    const existing = await app.prisma.task.findFirst({ where: taskScope(req, id) });
    if (!existing) return reply.code(404).send({ error: { code: "TASK_NOT_FOUND" } });

    const body = req.body as z.infer<typeof taskUpdateSchema>;
    const { tagIds, ...rest } = body;
    const task = await app.prisma.$transaction(async (tx) => {
      const updated = await tx.task.update({
        where: { id },
        data: {
          ...rest,
          deadline: rest.deadline ? new Date(rest.deadline) : undefined,
          endAt: rest.endAt ? new Date(rest.endAt) : undefined,
        },
      });
      if (tagIds) {
        await tx.taskTag.deleteMany({ where: { taskId: id } });
        if (tagIds.length) await tx.taskTag.createMany({ data: tagIds.map(tagId => ({ taskId: id, tagId })) });
      }
      return updated;
    });

    // recompute milestone if status or milestone changed
    const affectedMs = new Set<number>();
    if (existing.milestoneId) affectedMs.add(existing.milestoneId);
    if (task.milestoneId) affectedMs.add(task.milestoneId);
    for (const mid of affectedMs) await recomputeMilestoneProgress(app.prisma, mid);

    // Notify on assignee change
    if (rest.assigneeId && rest.assigneeId !== existing.assigneeId && rest.assigneeId !== req.user.id) {
      await notify(app.prisma, {
        userId: rest.assigneeId,
        type: "task_assigned",
        title: "Bạn được assign task",
        message: task.name,
        link: `/projects/${task.projectId}?tab=tasks`,
      });
    }

    return { data: task };
  });

  // ── DELETE ────────────────────────────────────────
  app.delete("/:id", {
    preHandler: [app.requireRole("ADMIN", "MANAGER")],
    schema: { params: idParam },
  }, async (req, reply) => {
    const { id } = req.params as any;
    const existing = await app.prisma.task.findFirst({ where: taskScope(req, id) });
    if (!existing) return reply.code(404).send({ error: { code: "TASK_NOT_FOUND" } });
    await app.prisma.task.delete({ where: { id } });
    await bumpProjectTaskCount(app, existing.projectId);
    if (existing.milestoneId) await recomputeMilestoneProgress(app.prisma, existing.milestoneId);
    return reply.code(204).send();
  });

  // ── TRANSITION ────────────────────────────────────
  app.post("/:id/transition", {
    preHandler: [app.authenticate],
    schema: { params: idParam, body: taskTransitionSchema },
  }, async (req, reply) => {
    const { id } = req.params as any;
    const { status } = req.body as any;
    const existing = await app.prisma.task.findFirst({ where: taskScope(req, id) });
    if (!existing) return reply.code(404).send({ error: { code: "TASK_NOT_FOUND" } });

    // MEMBER can transition only own tasks
    if (
      !req.user.isSuperAdmin &&
      req.user.role === "MEMBER" &&
      existing.assigneeId !== req.user.id
    ) {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Only assignee can move task" } });
    }
    if (req.user.role === "VIEWER" && !req.user.isSuperAdmin) {
      return reply.code(403).send({ error: { code: "FORBIDDEN" } });
    }
    if (!isTaskTransitionAllowed(existing.status, status)) {
      return reply.code(400).send({
        error: { code: "INVALID_TRANSITION", message: `Cannot move from ${existing.status} to ${status}` },
      });
    }
    const updated = await app.prisma.task.update({ where: { id }, data: { status } });
    if (updated.milestoneId) await recomputeMilestoneProgress(app.prisma, updated.milestoneId);
    return { data: updated };
  });
};

function taskScope(req: any, id: number) {
  return req.user.isSuperAdmin
    ? { id }
    : { id, project: { companyId: req.user.companyId } };
}

async function bumpProjectTaskCount(app: any, projectId: number) {
  const count = await app.prisma.task.count({ where: { projectId } });
  await app.prisma.project.update({ where: { id: projectId }, data: { taskCount: count } });
}

function parseSort(s: string) {
  return s.split(",").map(token => {
    const desc = token.startsWith("-");
    const field = desc ? token.slice(1) : token;
    return { [field]: desc ? "desc" : "asc" } as any;
  });
}

export default tasksRoutes;
