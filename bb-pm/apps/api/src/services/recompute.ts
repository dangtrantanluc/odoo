import type { PrismaClient, Prisma } from "@prisma/client";

type Tx = PrismaClient | Prisma.TransactionClient;

export async function recomputeTaskTotals(tx: Tx, taskId: number) {
  const agg = await tx.backlog.aggregate({
    where: { taskId, status: "APPROVED" },
    _sum: { hours: true, totalCostSnapshot: true },
  });
  await tx.task.update({
    where: { id: taskId },
    data: {
      totalHours: Number(agg._sum.hours ?? 0),
      totalCost: agg._sum.totalCostSnapshot ?? 0,
    },
  });
}

export async function recomputeProjectTotals(tx: Tx, projectId: number) {
  const [worklogAgg, counts, budget] = await Promise.all([
    tx.backlog.aggregate({
      where: { projectId, status: "APPROVED" },
      _sum: { hours: true, totalCostSnapshot: true },
    }),
    (async () => ({
      tasks:      await tx.task.count({ where: { projectId } }),
      members:    await tx.member.count({ where: { projectId } }),
      backlogs:   await tx.backlog.count({ where: { projectId } }),
      scopes:     await tx.scope.count({ where: { projectId } }),
      milestones: await tx.milestone.count({ where: { projectId } }),
    }))(),
    tx.project.findUnique({ where: { id: projectId }, select: { budget: true } }),
  ]);
  const totalCost = worklogAgg._sum.totalCostSnapshot ?? 0;
  await tx.project.update({
    where: { id: projectId },
    data: {
      totalHours: Number(worklogAgg._sum.hours ?? 0),
      totalCost,
      taskCount: counts.tasks,
      memberCount: counts.members,
      backlogCount: counts.backlogs,
      scopeCount: counts.scopes,
      milestoneCount: counts.milestones,
      budgetRemaining: budget?.budget
        ? (Number(budget.budget) - Number(totalCost)).toFixed(2) as any
        : undefined,
    },
  });
}

export async function recomputeMilestoneProgress(tx: Tx, milestoneId: number) {
  const [taskCount, doneCount] = await Promise.all([
    tx.task.count({ where: { milestoneId } }),
    tx.task.count({ where: { milestoneId, status: "DONE" } }),
  ]);
  const pct = taskCount === 0 ? 0 : Math.round((doneCount * 100) / taskCount);
  await tx.milestone.update({
    where: { id: milestoneId },
    data: { taskCount, doneCount, completionPct: pct },
  });
}
