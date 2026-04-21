import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { memberRateCreateSchema } from "@bb-pm/shared";

const idParam = z.object({ id: z.coerce.number().int().positive() });

const ratesRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.patch("/:id", {
    preHandler: [app.requireRole("ADMIN", "MANAGER")],
    schema: { params: idParam, body: memberRateCreateSchema.partial() },
  }, async (req, reply) => {
    const { id } = req.params as any;
    const existing = await app.prisma.memberRate.findFirst({ where: rScope(req, id) });
    if (!existing) return reply.code(404).send({ error: { code: "RATE_NOT_FOUND" } });

    const body = req.body as any;
    const rate = await app.prisma.memberRate.update({
      where: { id },
      data: {
        effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : undefined,
        effectiveTo: body.effectiveTo !== undefined ? (body.effectiveTo ? new Date(body.effectiveTo) : null) : undefined,
        costPerHour: body.costPerHour,
        currencyId: body.currencyId,
      },
    });
    return { data: rate };
  });

  app.delete("/:id", {
    preHandler: [app.requireRole("ADMIN", "MANAGER")],
    schema: { params: idParam },
  }, async (req, reply) => {
    const { id } = req.params as any;
    const existing = await app.prisma.memberRate.findFirst({ where: rScope(req, id) });
    if (!existing) return reply.code(404).send({ error: { code: "RATE_NOT_FOUND" } });
    await app.prisma.memberRate.delete({ where: { id } });
    return reply.code(204).send();
  });
};

function rScope(req: any, id: number) {
  return req.user.isSuperAdmin
    ? { id }
    : { id, project: { companyId: req.user.companyId } };
}

export default ratesRoutes;
