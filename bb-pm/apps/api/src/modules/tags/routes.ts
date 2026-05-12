import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { tagCreateSchema, tagUpdateSchema } from "@bb-pm/shared";

const idParam = z.object({ id: z.coerce.number().int().positive() });

const tagsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async () => {
    const data = await app.prisma.tag.findMany({
      orderBy: { name: "asc" },
      include: { _count: { select: { projects: true, tasks: true } } },
    });
    return { data };
  });

  app.post("/", {
    preHandler: [app.requireRole("ADMIN", "MANAGER")],
    schema: { body: tagCreateSchema },
  }, async (req, reply) => {
    const tag = await app.prisma.tag.create({ data: req.body as any });
    return reply.code(201).send({ data: tag });
  });

  app.patch("/:id", {
    preHandler: [app.requireRole("ADMIN", "MANAGER")],
    schema: { params: idParam, body: tagUpdateSchema },
  }, async (req) => {
    const { id } = req.params as any;
    const tag = await app.prisma.tag.update({ where: { id }, data: req.body as any });
    return { data: tag };
  });

  app.delete("/:id", {
    preHandler: [app.requireRole("ADMIN")],
    schema: { params: idParam },
  }, async (req, reply) => {
    const { id } = req.params as any;
    await app.prisma.tag.delete({ where: { id } });
    return reply.code(204).send();
  });
};

export default tagsRoutes;
