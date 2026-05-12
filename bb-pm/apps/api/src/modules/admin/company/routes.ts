import type { FastifyPluginAsync } from "fastify";
import { companyUpdateSchema } from "@bb-pm/shared";

const companyAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  // Anyone in the company can view company info; but only ADMIN can update.
  app.get("/", async (req) => {
    const company = await app.prisma.company.findUnique({
      where: { id: req.user.companyId },
      include: {
        currency: true,
        _count: { select: { users: true, projects: true } },
      },
    });
    return { data: company };
  });

  app.patch("/", {
    preHandler: [app.requireRole("ADMIN")],
    schema: { body: companyUpdateSchema },
  }, async (req) => {
    const company = await app.prisma.company.update({
      where: { id: req.user.companyId },
      data: req.body as any,
      include: { currency: true },
    });
    return { data: company };
  });
};

export default companyAdminRoutes;
