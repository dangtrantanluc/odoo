import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { scopeCreateSchema, scopeUpdateSchema, scopeReorderSchema } from "@bb-pm/shared";
import { recomputeProjectTotals } from "../../services/recompute.js";

const idParam = z.object({ id: z.coerce.number().int().positive() });
const projectIdParam = z.object({ projectId: z.coerce.number().int().positive() });

const scopesRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/by-project/:projectId", { schema: { params: projectIdParam } }, async (req, reply) => {
    const { projectId } = req.params as any;
    const project = await app.prisma.project.findFirst({
      where: req.user.isSuperAdmin ? { id: projectId } : { id: projectId, companyId: req.user.companyId },
    });
    if (!project) return reply.code(404).send({ error: { code: "PROJECT_NOT_FOUND" } });

    const scopes = await app.prisma.scope.findMany({
      where: { projectId },
      orderBy: [{ sequence: "asc" }, { id: "asc" }],
      include: {
        task:     { select: { id: true, name: true, status: true } },
        assignee: { select: { id: true, fullName: true } },
        currency: { select: { id: true, code: true, symbol: true } },
      },
    });
    return { data: scopes };
  });

  app.post("/by-project/:projectId", {
    preHandler: [app.requireRole("ADMIN", "MANAGER")],
    schema: { params: projectIdParam, body: scopeCreateSchema },
  }, async (req, reply) => {
    const { projectId } = req.params as any;
    const project = await app.prisma.project.findFirst({
      where: req.user.isSuperAdmin ? { id: projectId } : { id: projectId, companyId: req.user.companyId },
    });
    if (!project) return reply.code(404).send({ error: { code: "PROJECT_NOT_FOUND" } });

    const body = req.body as any;
    // Auto-seq = max + 10 if not provided
    let sequence = body.sequence;
    if (sequence === undefined) {
      const last = await app.prisma.scope.findFirst({ where: { projectId }, orderBy: { sequence: "desc" } });
      sequence = (last?.sequence ?? 0) + 10;
    }

    const scope = await app.prisma.scope.create({
      data: {
        ...body,
        sequence,
        projectId,
        currencyId: body.currencyId ?? project.currencyId ?? undefined,
      },
    });

    await app.prisma.$transaction(async (tx) => { await recomputeProjectTotals(tx, projectId); });
    return reply.code(201).send({ data: scope });
  });

  app.patch("/:id", {
    preHandler: [app.requireRole("ADMIN", "MANAGER")],
    schema: { params: idParam, body: scopeUpdateSchema },
  }, async (req, reply) => {
    const { id } = req.params as any;
    const existing = await app.prisma.scope.findFirst({ where: scopeScope(req, id) });
    if (!existing) return reply.code(404).send({ error: { code: "SCOPE_NOT_FOUND" } });

    const body = req.body as any;
    const scope = await app.prisma.scope.update({ where: { id }, data: body });
    return { data: scope };
  });

  app.delete("/:id", {
    preHandler: [app.requireRole("ADMIN", "MANAGER")],
    schema: { params: idParam },
  }, async (req, reply) => {
    const { id } = req.params as any;
    const existing = await app.prisma.scope.findFirst({ where: scopeScope(req, id) });
    if (!existing) return reply.code(404).send({ error: { code: "SCOPE_NOT_FOUND" } });
    await app.prisma.scope.delete({ where: { id } });
    await app.prisma.$transaction(async (tx) => { await recomputeProjectTotals(tx, existing.projectId); });
    return reply.code(204).send();
  });

  // Bulk reorder: given array of ids in desired order, assign sequence = 10, 20, 30…
  app.post("/by-project/:projectId/reorder", {
    preHandler: [app.requireRole("ADMIN", "MANAGER")],
    schema: { params: projectIdParam, body: scopeReorderSchema },
  }, async (req, reply) => {
    const { projectId } = req.params as any;
    const { orderedIds } = req.body as any;
    await app.prisma.$transaction(
      orderedIds.map((id: number, idx: number) =>
        app.prisma.scope.updateMany({
          where: { id, projectId },
          data: { sequence: (idx + 1) * 10 },
        }),
      ),
    );
    return reply.code(204).send();
  });
};

function scopeScope(req: any, id: number) {
  return req.user.isSuperAdmin
    ? { id }
    : { id, project: { companyId: req.user.companyId } };
}

export default scopesRoutes;
