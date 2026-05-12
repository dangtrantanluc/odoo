import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import bcrypt from "bcrypt";
import { userCreateSchema, userAdminUpdateSchema } from "@bb-pm/shared";

const idParam = z.object({ id: z.coerce.number().int().positive() });
const listQuery = z.object({
  q: z.string().optional(),
  role: z.enum(["ADMIN", "MANAGER", "MEMBER", "VIEWER"]).optional(),
  active: z.coerce.boolean().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

const adminUsersRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);
  app.addHook("preHandler", app.requireRole("ADMIN"));

  app.get("/", { schema: { querystring: listQuery } }, async (req) => {
    const q = req.query as z.infer<typeof listQuery>;
    const where: any = {};
    if (!req.user.isSuperAdmin) where.companyId = req.user.companyId;
    if (q.role) where.role = q.role;
    if (q.active !== undefined) where.active = q.active;
    if (q.q) where.OR = [
      { fullName: { contains: q.q, mode: "insensitive" } },
      { email: { contains: q.q, mode: "insensitive" } },
    ];
    const [total, data] = await app.prisma.$transaction([
      app.prisma.user.count({ where }),
      app.prisma.user.findMany({
        where,
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        orderBy: { fullName: "asc" },
        select: {
          id: true, email: true, fullName: true, role: true, active: true,
          avatarUrl: true, lang: true, lastLoginAt: true, createdAt: true,
        },
      }),
    ]);
    return { data, meta: { total, page: q.page, pageSize: q.pageSize } };
  });

  app.post("/", { schema: { body: userCreateSchema } }, async (req, reply) => {
    const body = req.body as z.infer<typeof userCreateSchema>;
    const existing = await app.prisma.user.findUnique({ where: { email: body.email } });
    if (existing) return reply.code(409).send({ error: { code: "EMAIL_TAKEN" } });
    const passwordHash = await bcrypt.hash(body.password, 10);
    const user = await app.prisma.user.create({
      data: {
        email: body.email,
        fullName: body.fullName,
        role: body.role,
        passwordHash,
        companyId: req.user.companyId,
      },
      select: { id: true, email: true, fullName: true, role: true, active: true },
    });
    return reply.code(201).send({ data: user });
  });

  app.patch("/:id", { schema: { params: idParam, body: userAdminUpdateSchema } }, async (req, reply) => {
    const { id } = req.params as any;
    const body = req.body as z.infer<typeof userAdminUpdateSchema>;
    const existing = await app.prisma.user.findFirst({
      where: req.user.isSuperAdmin ? { id } : { id, companyId: req.user.companyId },
    });
    if (!existing) return reply.code(404).send({ error: { code: "USER_NOT_FOUND" } });
    if (existing.id === req.user.id && body.active === false) {
      return reply.code(400).send({ error: { code: "CANT_DEACTIVATE_SELF" } });
    }

    const data: any = { ...body };
    if (body.password) {
      data.passwordHash = await bcrypt.hash(body.password, 10);
      delete data.password;
    }
    const user = await app.prisma.user.update({
      where: { id },
      data,
      select: { id: true, email: true, fullName: true, role: true, active: true },
    });
    return { data: user };
  });
};

export default adminUsersRoutes;
