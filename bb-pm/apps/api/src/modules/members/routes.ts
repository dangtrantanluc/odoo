import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  memberCreateSchema,
  memberUpdateSchema,
  memberRateCreateSchema,
} from "@bb-pm/shared";
import { recomputeProjectTotals } from "../../services/recompute.js";

const idParam = z.object({ id: z.coerce.number().int().positive() });
const projectIdParam = z.object({ projectId: z.coerce.number().int().positive() });

const membersRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  // ── List by project ────────────────────────────
  app.get("/by-project/:projectId", { schema: { params: projectIdParam } }, async (req, reply) => {
    const { projectId } = req.params as any;
    const project = await app.prisma.project.findFirst({
      where: req.user.isSuperAdmin ? { id: projectId } : { id: projectId, companyId: req.user.companyId },
    });
    if (!project) return reply.code(404).send({ error: { code: "PROJECT_NOT_FOUND" } });

    const members = await app.prisma.member.findMany({
      where: { projectId },
      orderBy: { joinedAt: "asc" },
      include: {
        user: { select: { id: true, fullName: true, email: true, avatarUrl: true, role: true } },
        rates: {
          orderBy: { effectiveFrom: "desc" },
          take: 1,
          include: { currency: { select: { id: true, code: true, symbol: true } } },
        },
      },
    });
    return { data: members };
  });

  // ── Create member ───────────────────────────────
  app.post("/by-project/:projectId", {
    preHandler: [app.requireRole("ADMIN", "MANAGER")],
    schema: { params: projectIdParam, body: memberCreateSchema },
  }, async (req, reply) => {
    const { projectId } = req.params as any;
    const body = req.body as any;
    const project = await app.prisma.project.findFirst({
      where: req.user.isSuperAdmin ? { id: projectId } : { id: projectId, companyId: req.user.companyId },
    });
    if (!project) return reply.code(404).send({ error: { code: "PROJECT_NOT_FOUND" } });

    const member = await app.prisma.member.create({
      data: { projectId, userId: body.userId, role: body.role },
    });
    await app.prisma.$transaction(async (tx) => { await recomputeProjectTotals(tx, projectId); });
    return reply.code(201).send({ data: member });
  });

  app.patch("/:id", {
    preHandler: [app.requireRole("ADMIN", "MANAGER")],
    schema: { params: idParam, body: memberUpdateSchema },
  }, async (req, reply) => {
    const { id } = req.params as any;
    const existing = await app.prisma.member.findFirst({ where: mScope(req, id) });
    if (!existing) return reply.code(404).send({ error: { code: "MEMBER_NOT_FOUND" } });
    const updated = await app.prisma.member.update({ where: { id }, data: req.body as any });
    return { data: updated };
  });

  app.delete("/:id", {
    preHandler: [app.requireRole("ADMIN", "MANAGER")],
    schema: { params: idParam },
  }, async (req, reply) => {
    const { id } = req.params as any;
    const existing = await app.prisma.member.findFirst({ where: mScope(req, id) });
    if (!existing) return reply.code(404).send({ error: { code: "MEMBER_NOT_FOUND" } });
    await app.prisma.member.delete({ where: { id } });
    await app.prisma.$transaction(async (tx) => { await recomputeProjectTotals(tx, existing.projectId); });
    return reply.code(204).send();
  });

  // ── List rates for a member ────────────────────
  app.get("/:id/rates", { schema: { params: idParam } }, async (req, reply) => {
    const { id } = req.params as any;
    const existing = await app.prisma.member.findFirst({ where: mScope(req, id) });
    if (!existing) return reply.code(404).send({ error: { code: "MEMBER_NOT_FOUND" } });
    const rates = await app.prisma.memberRate.findMany({
      where: { memberId: id },
      orderBy: { effectiveFrom: "desc" },
      include: { currency: { select: { id: true, code: true, symbol: true } } },
    });
    return { data: rates };
  });

  // ── Create a new rate ──────────────────────────
  app.post("/:id/rates", {
    preHandler: [app.requireRole("ADMIN", "MANAGER")],
    schema: { params: idParam, body: memberRateCreateSchema },
  }, async (req, reply) => {
    const { id } = req.params as any;
    const body = req.body as any;
    const existing = await app.prisma.member.findFirst({ where: mScope(req, id) });
    if (!existing) return reply.code(404).send({ error: { code: "MEMBER_NOT_FOUND" } });

    const project = await app.prisma.project.findUnique({ where: { id: existing.projectId } });
    const rate = await app.prisma.memberRate.create({
      data: {
        memberId: id,
        projectId: existing.projectId,
        userId: existing.userId,
        currencyId: body.currencyId ?? project?.currencyId ?? undefined,
        effectiveFrom: new Date(body.effectiveFrom),
        effectiveTo: body.effectiveTo ? new Date(body.effectiveTo) : null,
        costPerHour: body.costPerHour,
      },
    });
    return reply.code(201).send({ data: rate });
  });
};

function mScope(req: any, id: number) {
  return req.user.isSuperAdmin
    ? { id }
    : { id, project: { companyId: req.user.companyId } };
}

export default membersRoutes;
