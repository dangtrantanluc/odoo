import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { currencyCreateSchema, currencyUpdateSchema } from "@bb-pm/shared";

const idParam = z.object({ id: z.coerce.number().int().positive() });

const currenciesRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async () => {
    const data = await app.prisma.currency.findMany({
      orderBy: { code: "asc" },
      include: { _count: { select: { companies: true, projects: true } } },
    });
    return { data };
  });

  app.post("/", {
    preHandler: [app.requireRole("ADMIN")],
    schema: { body: currencyCreateSchema },
  }, async (req, reply) => {
    const c = await app.prisma.currency.create({ data: req.body as any });
    return reply.code(201).send({ data: c });
  });

  app.patch("/:id", {
    preHandler: [app.requireRole("ADMIN")],
    schema: { params: idParam, body: currencyUpdateSchema },
  }, async (req) => {
    const { id } = req.params as any;
    const c = await app.prisma.currency.update({ where: { id }, data: req.body as any });
    return { data: c };
  });

  app.delete("/:id", {
    preHandler: [app.requireRole("ADMIN")],
    schema: { params: idParam },
  }, async (req, reply) => {
    const { id } = req.params as any;
    await app.prisma.currency.delete({ where: { id } });
    return reply.code(204).send();
  });
};

export default currenciesRoutes;
