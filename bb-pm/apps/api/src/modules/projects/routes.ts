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
