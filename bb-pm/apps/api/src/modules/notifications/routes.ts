import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const idParam = z.object({ id: z.coerce.number().int().positive() });
const listQuery = z.object({
  unread: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const notificationsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/", { schema: { querystring: listQuery } }, async (req) => {
    const q = req.query as z.infer<typeof listQuery>;
    const where: any = { userId: req.user.id };
    if (q.unread) where.readAt = null;
    const [total, unreadCount, data] = await app.prisma.$transaction([
      app.prisma.notification.count({ where: { userId: req.user.id } }),
      app.prisma.notification.count({ where: { userId: req.user.id, readAt: null } }),
      app.prisma.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: q.limit,
      }),
    ]);
    return { data, meta: { total, unreadCount } };
  });

  app.patch("/:id/read", { schema: { params: idParam } }, async (req) => {
    const { id } = req.params as any;
    const n = await app.prisma.notification.updateMany({
      where: { id, userId: req.user.id, readAt: null },
      data: { readAt: new Date() },
    });
    return { data: { updated: n.count } };
  });

  app.post("/read-all", async (req) => {
    const n = await app.prisma.notification.updateMany({
      where: { userId: req.user.id, readAt: null },
      data: { readAt: new Date() },
    });
    return { data: { updated: n.count } };
  });
};

export default notificationsRoutes;
