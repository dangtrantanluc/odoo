import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const includeValues = [
  "overview",
  "overdue",
  "blocked",
  "stale",
  "milestones",
  "pending_backlogs",
  "cost",
  "hygiene",
] as const;

const roleBasedQuery = z.object({
  userId: z.coerce.number().int().positive(),
  projectIds: z
    .string()
    .optional()
    .transform((value) =>
      value
        ? value
            .split(",")
            .map((x) => Number(x.trim()))
            .filter((x) => Number.isInteger(x) && x > 0)
        : undefined,
    ),
  include: z
    .string()
    .optional()
    .transform((value) =>
      value
        ? value
            .split(",")
            .map((x) => x.trim())
            .filter((x): x is (typeof includeValues)[number] =>
              (includeValues as readonly string[]).includes(x),
            )
        : undefined,
    ),
  detailLevel: z.enum(["brief", "normal", "detailed"]).optional().default("normal"),
  daysAhead: z.coerce.number().int().positive().max(30).optional().default(7),
  staleDays: z.coerce.number().int().positive().max(90).optional().default(14),
});

const DEFAULT_INCLUDE = ["overview", "overdue", "blocked", "milestones"] as const;

const digestsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/role-based", { schema: { querystring: roleBasedQuery } }, async (req, reply) => {
    const q = req.query as z.infer<typeof roleBasedQuery>;
    const include = q.include?.length ? q.include : [...DEFAULT_INCLUDE];
    const now = new Date();
    const upcomingEnd = new Date(now.getTime() + q.daysAhead * 86_400_000);
    const staleCutoff = new Date(now.getTime() - q.staleDays * 86_400_000);

    const recipient = await app.prisma.user.findFirst({
      where: req.user.isSuperAdmin
        ? { id: q.userId, active: true }
        : { id: q.userId, companyId: req.user.companyId, active: true },
      select: {
        id: true,
        fullName: true,
        email: true,
        role: true,
        companyId: true,
        isSuperAdmin: true,
      },
    });
    if (!recipient) {
      return reply.code(404).send({ error: { code: "USER_NOT_FOUND" } });
    }

    const projectWhere = buildProjectScope({
      companyId: recipient.companyId,
      role: recipient.role,
      userId: recipient.id,
      requestedProjectIds: q.projectIds,
      isSuperAdmin: recipient.isSuperAdmin,
    });

    const projects = await app.prisma.project.findMany({
      where: projectWhere,
      take: 100,
      orderBy: [{ status: "asc" }, { endDate: "asc" }],
      select: {
        id: true,
        name: true,
        code: true,
        status: true,
        endDate: true,
        budget: true,
        totalCost: true,
        budgetRemaining: true,
        taskCount: true,
        totalHours: true,
        _count: { select: { tasks: { where: { status: "DONE" } } } },
      },
    });
    const projectIds = projects.map((p) => p.id);
    const taskWhereBase: any = { projectId: { in: projectIds } };
    if (recipient.role === "MEMBER") taskWhereBase.assigneeId = recipient.id;

    const emptyTaskList: any[] = [];
    const [
      openTasks,
      overdueTasks,
      upcomingTasks,
      staleTasks,
      blockers,
      pendingBacklogs,
      hygieneMissingOwner,
      hygieneMissingDeadline,
      milestones,
    ] = projectIds.length
      ? await Promise.all([
          app.prisma.task.count({ where: { ...taskWhereBase, status: { not: "DONE" } } }),
          include.includes("overdue")
            ? app.prisma.task.findMany({
                where: {
                  ...taskWhereBase,
                  status: { not: "DONE" },
                  deadline: { not: null, lt: now },
                },
                take: limitFor(q.detailLevel),
                orderBy: [{ deadline: "asc" }],
                include: digestTaskInclude(),
              })
            : Promise.resolve(emptyTaskList),
          app.prisma.task.findMany({
            where: {
              ...taskWhereBase,
              status: { not: "DONE" },
              deadline: { gte: now, lte: upcomingEnd },
            },
            take: limitFor(q.detailLevel),
            orderBy: [{ deadline: "asc" }],
            include: digestTaskInclude(),
          }),
          include.includes("stale") || include.includes("hygiene")
            ? app.prisma.task.findMany({
                where: {
                  ...taskWhereBase,
                  status: { not: "DONE" },
                  updatedAt: { lt: staleCutoff },
                },
                take: limitFor(q.detailLevel),
                orderBy: [{ updatedAt: "asc" }],
                include: digestTaskInclude(),
              })
            : Promise.resolve(emptyTaskList),
          include.includes("blocked")
            ? app.prisma.taskBlocker.findMany({
                where: { resolvedAt: null, task: taskWhereBase },
                take: limitFor(q.detailLevel),
                orderBy: [{ severity: "desc" }, { createdAt: "asc" }],
                include: { task: { include: digestTaskInclude() } },
              })
            : Promise.resolve(emptyTaskList),
          include.includes("pending_backlogs")
            ? app.prisma.backlog.findMany({
                where: {
                  status: "PENDING",
                  projectId: { in: projectIds },
                  ...(recipient.role === "MEMBER" ? { userId: recipient.id } : {}),
                },
                take: limitFor(q.detailLevel),
                orderBy: [{ workDate: "asc" }],
                include: {
                  project: { select: { id: true, name: true, code: true } },
                  task: { select: { id: true, name: true } },
                  user: { select: { id: true, fullName: true } },
                },
              })
            : Promise.resolve(emptyTaskList),
          include.includes("hygiene")
            ? app.prisma.task.findMany({
                where: { ...taskWhereBase, status: { not: "DONE" }, assigneeId: null },
                take: limitFor(q.detailLevel),
                include: digestTaskInclude(),
              })
            : Promise.resolve(emptyTaskList),
          include.includes("hygiene")
            ? app.prisma.task.findMany({
                where: { ...taskWhereBase, status: { not: "DONE" }, deadline: null },
                take: limitFor(q.detailLevel),
                include: digestTaskInclude(),
              })
            : Promise.resolve(emptyTaskList),
          include.includes("milestones")
            ? app.prisma.milestone.findMany({
                where: {
                  projectId: { in: projectIds },
                  dueDate: { not: null, lte: upcomingEnd },
                },
                take: limitFor(q.detailLevel),
                orderBy: [{ dueDate: "asc" }],
                include: { project: { select: { id: true, name: true, code: true } } },
              })
            : Promise.resolve(emptyTaskList),
        ])
      : [0, [], [], [], [], [], [], [], []];

    return {
      data: {
        generatedAt: now.toISOString(),
        recipient,
        options: {
          include,
          detailLevel: q.detailLevel,
          daysAhead: q.daysAhead,
          staleDays: q.staleDays,
          requestedProjectIds: q.projectIds ?? null,
        },
        scope: {
          projectIds,
          projectCount: projectIds.length,
        },
        overview: {
          activeProjects: projects.filter((p) => ["PLANNED", "IN_PROGRESS"].includes(p.status)).length,
          openTasks,
          overdueTasks: overdueTasks.length,
          upcomingTasks: upcomingTasks.length,
          blockedTasks: blockers.length,
          staleTasks: staleTasks.length,
          pendingBacklogs: pendingBacklogs.length,
        },
        projects: projects.map((p) => ({
          id: p.id,
          name: p.name,
          code: p.code,
          status: p.status,
          endDate: p.endDate,
          taskCount: p.taskCount,
          doneTaskCount: p._count.tasks,
          completionPct: p.taskCount > 0 ? Math.round((100 * p._count.tasks) / p.taskCount) : null,
          totalHours: Number(p.totalHours),
          totalCost: Number(p.totalCost),
          budget: p.budget == null ? null : Number(p.budget),
          budgetRemaining: p.budgetRemaining == null ? null : Number(p.budgetRemaining),
        })),
        overdue: overdueTasks.map(simplifyTask(now)),
        upcoming: upcomingTasks.map(simplifyTask(now)),
        stale: staleTasks.map(simplifyTask(now)),
        blocked: blockers.map((b: any) => ({
          id: b.id,
          severity: b.severity,
          description: b.description,
          createdAt: b.createdAt,
          task: simplifyTask(now)(b.task),
        })),
        pendingBacklogs: pendingBacklogs.map((b: any) => ({
          id: b.id,
          workDate: b.workDate,
          hours: Number(b.hours),
          project: b.project,
          task: b.task,
          user: b.user,
        })),
        hygiene: {
          missingOwner: hygieneMissingOwner.map(simplifyTask(now)),
          missingDeadline: hygieneMissingDeadline.map(simplifyTask(now)),
          stale: staleTasks.map(simplifyTask(now)),
        },
        milestones: milestones.map((m: any) => ({
          id: m.id,
          name: m.name,
          status: m.status,
          dueDate: m.dueDate,
          taskCount: m.taskCount,
          doneCount: m.doneCount,
          completionPct: m.completionPct,
          project: m.project,
        })),
      },
    };
  });
};

function buildProjectScope(args: {
  companyId: number;
  role: string;
  userId: number;
  requestedProjectIds?: number[];
  isSuperAdmin?: boolean;
}) {
  const where: any = { companyId: args.companyId };
  if (args.requestedProjectIds?.length) where.id = { in: args.requestedProjectIds };
  if (args.isSuperAdmin || args.role === "ADMIN") return where;

  const accessOr = [
    { ownerId: args.userId },
    { accountManagerId: args.userId },
    { members: { some: { userId: args.userId } } },
  ];
  if (args.role === "MEMBER") accessOr.push({ tasks: { some: { assigneeId: args.userId } } } as any);
  where.OR = accessOr;
  return where;
}

function digestTaskInclude() {
  return {
    project: { select: { id: true, name: true, code: true } },
    assignee: { select: { id: true, fullName: true, email: true } },
  };
}

function simplifyTask(now: Date) {
  return (t: any) => ({
    id: t.id,
    name: t.name,
    status: t.status,
    priority: t.priority,
    deadline: t.deadline,
    updatedAt: t.updatedAt,
    project: t.project,
    assignee: t.assignee,
    daysOverdue:
      t.deadline && new Date(t.deadline).getTime() < now.getTime()
        ? Math.floor((now.getTime() - new Date(t.deadline).getTime()) / 86_400_000)
        : null,
    daysSinceUpdate: Math.floor((now.getTime() - new Date(t.updatedAt).getTime()) / 86_400_000),
  });
}

function limitFor(detailLevel: "brief" | "normal" | "detailed") {
  if (detailLevel === "brief") return 5;
  if (detailLevel === "detailed") return 20;
  return 10;
}

export default digestsRoutes;
