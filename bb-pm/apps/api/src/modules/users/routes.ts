import type { FastifyPluginAsync } from "fastify";
import { meUpdateSchema } from "@bb-pm/shared";

const usersRoutes: FastifyPluginAsync = async (app) => {
  app.get("/me", { preHandler: [app.authenticate] }, async (req) => {
    const user = await app.prisma.user.findUniqueOrThrow({
      where: { id: req.user.id },
      select: {
        id: true, email: true, fullName: true, role: true, companyId: true,
        isSuperAdmin: true, avatarUrl: true, lang: true, timezone: true,
        company: { select: { id: true, name: true, code: true } },
      },
    });
    return { data: user };
  });

  app.patch("/me", {
    preHandler: [app.authenticate],
    schema: { body: meUpdateSchema },
  }, async (req) => {
    const user = await app.prisma.user.update({
      where: { id: req.user.id },
      data: req.body as any,
      select: { id: true, email: true, fullName: true, avatarUrl: true, lang: true, timezone: true },
    });
    return { data: user };
  });

  // Public listing of companies (for register dropdown)
  app.get("/companies/public", async () => {
    const companies = await app.prisma.company.findMany({
      select: { id: true, name: true, code: true },
      orderBy: { name: "asc" },
    });
    return { data: companies };
  });

  // List users in own company (for pickers)
  app.get("/users", { preHandler: [app.authenticate] }, async (req) => {
    const where: any = { active: true };
    if (!req.user.isSuperAdmin) where.companyId = req.user.companyId;
    const users = await app.prisma.user.findMany({
      where,
      select: { id: true, email: true, fullName: true, role: true, avatarUrl: true, companyId: true },
      orderBy: { fullName: "asc" },
    });
    return { data: users };
  });
};

export default usersRoutes;
