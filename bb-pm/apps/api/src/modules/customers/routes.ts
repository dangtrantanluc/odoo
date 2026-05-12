import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { customerCreateSchema, customerUpdateSchema } from "@bb-pm/shared";

const idParam = z.object({ id: z.coerce.number().int().positive() });
const listQuery = z.object({
  q: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const customersRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/", { schema: { querystring: listQuery } }, async (req) => {
    const q = req.query as z.infer<typeof listQuery>;
    const where = q.q ? { name: { contains: q.q, mode: "insensitive" as const } } : {};
    const [total, data] = await app.prisma.$transaction([
      app.prisma.customer.count({ where }),
      app.prisma.customer.findMany({
        where,
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        orderBy: { name: "asc" },
        include: { _count: { select: { projects: true } } },
      }),
    ]);
    return { data, meta: { total, page: q.page, pageSize: q.pageSize } };
  });

  app.get("/:id", { schema: { params: idParam } }, async (req, reply) => {
    const { id } = req.params as any;
    const c = await app.prisma.customer.findUnique({
      where: { id },
      include: { projects: { select: { id: true, name: true, status: true } } },
    });
    if (!c) return reply.code(404).send({ error: { code: "CUSTOMER_NOT_FOUND" } });
    return { data: c };
  });

  app.post("/", {
    preHandler: [app.requireRole("ADMIN", "MANAGER")],
    schema: { body: customerCreateSchema },
  }, async (req, reply) => {
    const c = await app.prisma.customer.create({ data: req.body as any });
    return reply.code(201).send({ data: c });
  });

  app.patch("/:id", {
    preHandler: [app.requireRole("ADMIN", "MANAGER")],
    schema: { params: idParam, body: customerUpdateSchema },
  }, async (req) => {
    const { id } = req.params as any;
    const c = await app.prisma.customer.update({ where: { id }, data: req.body as any });
    return { data: c };
  });

  app.delete("/:id", {
    preHandler: [app.requireRole("ADMIN")],
    schema: { params: idParam },
  }, async (req, reply) => {
    const { id } = req.params as any;
    await app.prisma.customer.delete({ where: { id } });
    return reply.code(204).send();
  });
};

export default customersRoutes;
