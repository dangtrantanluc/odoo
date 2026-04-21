import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { milestoneCreateSchema, milestoneUpdateSchema } from "@bb-pm/shared";
import { recomputeMilestoneProgress } from "../../services/recompute.js";

const idParam = z.object({ id: z.coerce.number().int().positive() });
const projectIdParam = z.object({ projectId: z.coerce.number().int().positive() });

const milestonesRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  // List by project
  app.get("/by-project/:projectId", { schema: { params: projectIdParam } }, async (req, reply) => {
    const { projectId } = req.params as any;
    const project = await app.prisma.project.findFirst({
      where: req.user.isSuperAdmin ? { id: projectId } : { id: projectId, companyId: req.user.companyId },
    });
    if (!project) return reply.code(404).send({ error: { code: "PROJECT_NOT_FOUND" } });

    const data = await app.prisma.milestone.findMany({
      where: { projectId },
      orderBy: { dueDate: "asc" },
    });
    return { data };
  });

  // Create under project
  app.post("/by-project/:projectId", {
    preHandler: [app.requireRole("ADMIN", "MANAGER")],
    schema: { params: projectIdParam, body: milestoneCreateSchema },
  }, async (req, reply) => {
    const { projectId } = req.params as any;
    const project = await app.prisma.project.findFirst({
      where: req.user.isSuperAdmin ? { id: projectId } : { id: projectId, companyId: req.user.companyId },
    });
    if (!project) return reply.code(404).send({ error: { code: "PROJECT_NOT_FOUND" } });

    const body = req.body as any;
    const m = await app.prisma.milestone.create({
      data: {
        ...body,
        dueDate: body.dueDate ? new Date(body.dueDate) : undefined,
        projectId,
      },
    });
    await app.prisma.project.update({
      where: { id: projectId },
      data: { milestoneCount: { increment: 1 } },
    });
    return reply.code(201).send({ data: m });
  });

  app.patch("/:id", {
    preHandler: [app.requireRole("ADMIN", "MANAGER")],
    schema: { params: idParam, body: milestoneUpdateSchema },
  }, async (req, reply) => {
    const { id } = req.params as any;
    const existing = await app.prisma.milestone.findFirst({ where: msScope(req, id) });
    if (!existing) return reply.code(404).send({ error: { code: "MILESTONE_NOT_FOUND" } });
    const body = req.body as any;
    const m = await app.prisma.milestone.update({
      where: { id },
      data: {
        ...body,
        dueDate: body.dueDate ? new Date(body.dueDate) : undefined,
      },
    });
    return { data: m };
  });

  app.delete("/:id", {
    preHandler: [app.requireRole("ADMIN", "MANAGER")],
    schema: { params: idParam },
  }, async (req, reply) => {
    const { id } = req.params as any;
    const existing = await app.prisma.milestone.findFirst({ where: msScope(req, id) });
    if (!existing) return reply.code(404).send({ error: { code: "MILESTONE_NOT_FOUND" } });
    await app.prisma.milestone.delete({ where: { id } });
    await app.prisma.project.update({
      where: { id: existing.projectId },
      data: { milestoneCount: { decrement: 1 } },
    });
    return reply.code(204).send();
  });

  // Recompute manually (utility)
  app.post("/:id/recompute", {
    preHandler: [app.requireRole("ADMIN", "MANAGER")],
    schema: { params: idParam },
  }, async (req) => {
    const { id } = req.params as any;
    await recomputeMilestoneProgress(app.prisma, id);
    const m = await app.prisma.milestone.findUnique({ where: { id } });
    return { data: m };
  });
};

function msScope(req: any, id: number) {
  return req.user.isSuperAdmin
    ? { id }
    : { id, project: { companyId: req.user.companyId } };
}

export default milestonesRoutes;
