import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const chartsQuery = z.object({
  range: z.enum(["7d", "30d", "90d"]).default("30d"),
});

const dashboardRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/kpis", async (req) => {
    const companyScope = req.user.isSuperAdmin ? {} : { companyId: req.user.companyId };
    const taskScope = req.user.isSuperAdmin ? {} : { project: { companyId: req.user.companyId } };

    const now = new Date();
    const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      activeProjects,
      plannedProjects,
      completedProjects,
      onHoldProjects,
      pendingBacklogs,
      tasksByStatus,
      monthHours,
    ] = await Promise.all([
      app.prisma.project.count({ where: { ...companyScope, status: "IN_PROGRESS" } }),
      app.prisma.project.count({ where: { ...companyScope, status: "PLANNED" } }),
      app.prisma.project.count({ where: { ...companyScope, status: "COMPLETED" } }),
      app.prisma.project.count({ where: { ...companyScope, status: "ON_HOLD" } }),
      app.prisma.backlog.count({
        where: req.user.isSuperAdmin ? { status: "PENDING" } : { status: "PENDING", project: { companyId: req.user.companyId } },
      }),
      app.prisma.task.groupBy({
        by: ["status"],
        where: taskScope,
        _count: true,
      }),
      app.prisma.backlog.aggregate({
        where: {
          ...(req.user.isSuperAdmin ? {} : { project: { companyId: req.user.companyId } }),
          status: "APPROVED",
          workDate: { gte: firstOfMonth },
        },
        _sum: { hours: true, totalCostSnapshot: true },
      }),
    ]);

    return {
      data: {
        projects: {
          active: activeProjects,
          planned: plannedProjects,
          completed: completedProjects,
          onHold: onHoldProjects,
        },
        pendingBacklogs,
        tasksByStatus: tasksByStatus.reduce<Record<string, number>>((acc, t) => {
          acc[t.status] = t._count;
          return acc;
        }, {}),
        thisMonth: {
          hours: Number(monthHours._sum.hours ?? 0),
          cost: Number(monthHours._sum.totalCostSnapshot ?? 0),
        },
      },
    };
  });

  app.get("/charts", { schema: { querystring: chartsQuery } }, async (req) => {
    const q = req.query as z.infer<typeof chartsQuery>;
    const days = q.range === "7d" ? 7 : q.range === "90d" ? 90 : 30;
    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);

    const companyScope = req.user.isSuperAdmin ? {} : { project: { companyId: req.user.companyId } };

    const hoursByDayRaw = req.user.isSuperAdmin
      ? await app.prisma.$queryRawUnsafe<{ day: Date; hours: number | null; cost: string | null }[]>(
          `SELECT DATE_TRUNC('day', work_date) AS day,
                  SUM(hours)::float AS hours,
                  COALESCE(SUM(total_cost_snapshot), 0)::text AS cost
           FROM backlogs
           WHERE status = 'APPROVED' AND work_date >= $1
           GROUP BY 1 ORDER BY 1`,
          since,
        )
      : await app.prisma.$queryRawUnsafe<{ day: Date; hours: number | null; cost: string | null }[]>(
          `SELECT DATE_TRUNC('day', b.work_date) AS day,
                  SUM(b.hours)::float AS hours,
                  COALESCE(SUM(b.total_cost_snapshot), 0)::text AS cost
           FROM backlogs b
           JOIN projects p ON p.id = b.project_id
           WHERE p.company_id = $2 AND b.status = 'APPROVED' AND b.work_date >= $1
           GROUP BY 1 ORDER BY 1`,
          since,
          req.user.companyId,
        );

    const [costByProject, budgetUsage] = await Promise.all([
      app.prisma.project.findMany({
        where: req.user.isSuperAdmin ? {} : { companyId: req.user.companyId },
        orderBy: { totalCost: "desc" },
        take: 10,
        select: { id: true, name: true, totalCost: true, budget: true, totalHours: true },
      }),
      app.prisma.project.findMany({
        where: {
          ...(req.user.isSuperAdmin ? {} : { companyId: req.user.companyId }),
          budget: { gt: 0 },
        },
        orderBy: { updatedAt: "desc" },
        take: 10,
        select: { id: true, name: true, totalCost: true, budget: true, status: true },
      }),
    ]);

    return {
      data: {
        hoursByDay: hoursByDayRaw.map(r => ({
          day: r.day,
          hours: Number(r.hours ?? 0),
          cost: Number(r.cost ?? 0),
        })),
        costByProject: costByProject.map(p => ({
          id: p.id,
          name: p.name,
          totalCost: Number(p.totalCost),
          totalHours: p.totalHours,
        })),
        budgetUsage: budgetUsage.map(p => ({
          id: p.id,
          name: p.name,
          budget: Number(p.budget),
          totalCost: Number(p.totalCost),
          usagePct: Number(p.budget) > 0 ? Math.round((Number(p.totalCost) * 100) / Number(p.budget)) : 0,
          status: p.status,
        })),
      },
    };
  });
};

export default dashboardRoutes;
