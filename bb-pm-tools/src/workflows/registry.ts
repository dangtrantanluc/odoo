// Phase 4 — Workflow registry. Mỗi workflow là 1 named function khả thi
// re-execute bởi:
//   - workflow.run tool (one-shot, user-triggered)
//   - scheduler tick (recurring, từ Automation row)
//
// Workflow nhận inputs + ctx, trả về { ok, result?, error? }. Workflow KHÔNG
// gọi LLM trực tiếp — chỉ dispatch tools/HTTP. Composability cao.

import { bbPm } from "../api-client";
import { sendToGapo } from "../channel-out";
import type { RoleBasedDigest } from "../api-client";
import type { AgentContext } from "../types";

export type WorkflowResult = {
  ok: boolean;
  message: string;
  meta?: any;
  error?: string;
};

export type WorkflowFn = (
  inputs: Record<string, any>,
  ctx: { source: "manual" | "cron"; target?: string; correlationId?: string },
) => Promise<WorkflowResult>;

export type WorkflowDef = {
  name: string;
  description: string;
  inputsSchema?: Record<string, { type: string; required?: boolean; description?: string }>;
  run: WorkflowFn;
};

// ── daily_digest ────────────────────────────────────────────────────────
const dailyDigest: WorkflowDef = {
  name: "daily_digest",
  description:
    "Tổng hợp digest ngày — gọi /projects/digest API, format text VN, " +
    "push ra target (Gapo collab/dm). Inputs: {} (target từ ctx).",
  run: async (_inputs, ctx) => {
    if (!ctx.target) return { ok: false, message: "missing target", error: "no Gapo cid" };
    try {
      const res = await bbPm.digest();
      const d = res.data;
      const lines: string[] = [];
      lines.push(`📊 *Digest hôm nay (${new Date().toLocaleDateString("vi-VN")})*`);
      lines.push("");
      lines.push(`• Dự án active: *${d.totals.activeProjects}*`);
      lines.push(`• Task mở: *${d.totals.openTasks}* | Quá hạn: *${d.totals.overdueTasks}* | Lâu chưa update: *${d.totals.staleTasks}* | Chưa gán: *${d.totals.unassignedTasks}*`);
      lines.push("");
      const top = d.projects.slice(0, 5);
      if (top.length) {
        lines.push("*Dự án:*");
        for (const p of top) {
          const pct = p.completionPct != null ? `${Math.round(p.completionPct)}%` : "—";
          lines.push(`• ${p.name} (${p.code}): ${p.doneTaskCount}/${p.taskCount} (${pct})`);
        }
      }
      const text = lines.join("\n");
      await sendToGapo(ctx.target, text);
      return { ok: true, message: "digest sent", meta: { totals: d.totals, projectCount: d.projects.length } };
    } catch (err: any) {
      return { ok: false, message: "digest workflow failed", error: err?.message ?? String(err) };
    }
  },
};

// ── weekly_report ───────────────────────────────────────────────────────
const weeklyReport: WorkflowDef = {
  name: "weekly_report",
  description:
    "Báo cáo tuần — gọi /projects/weekly-report (default 7d), format VN, push. " +
    "Inputs: { days?: number, projectId?: number }. target từ ctx.",
  run: async (inputs, ctx) => {
    if (!ctx.target) return { ok: false, message: "missing target", error: "no Gapo cid" };
    try {
      const res = await bbPm.weeklyReport({ days: inputs.days ?? 7, projectId: inputs.projectId });
      const r = res.data;
      const lines: string[] = [];
      lines.push(`📆 *Weekly Report (${r.window.start.slice(0, 10)} → ${r.window.end.slice(0, 10)})*`);
      lines.push("");
      lines.push(`• Tasks done: *${r.totals.tasksDone}* | New: ${r.totals.newTasks} | Blockers: ${r.totals.newBlockers}`);
      lines.push(`• Hours approved: *${r.totals.hoursApproved.toFixed(1)}h* | Cost: ${r.totals.costApproved}`);
      lines.push("");
      const top = r.projects.slice(0, 5);
      if (top.length) {
        lines.push("*Theo dự án:*");
        for (const p of top) {
          const pct = p.completionPct != null ? `${Math.round(p.completionPct)}%` : "—";
          lines.push(`• ${p.name}: ${p.doneTaskCount}/${p.taskCount} (${pct}), ${p.totalHours.toFixed(1)}h`);
        }
      }
      const upcoming = r.upcomingDeadlines?.slice(0, 5) ?? [];
      if (upcoming.length) {
        lines.push("");
        lines.push("*Deadline sắp tới:*");
        for (const t of upcoming) {
          lines.push(`• ${t.name} (${t.project?.name ?? "?"}) — ${t.deadline?.slice(0, 10) ?? "n/a"}`);
        }
      }
      await sendToGapo(ctx.target, lines.join("\n"));
      return { ok: true, message: "weekly report sent", meta: r.totals };
    } catch (err: any) {
      return { ok: false, message: "weekly_report workflow failed", error: err?.message ?? String(err) };
    }
  },
};

// ── hygiene_check ───────────────────────────────────────────────────────
const hygieneCheck: WorkflowDef = {
  name: "hygiene_check",
  description:
    "Quét data hygiene — task thiếu owner / deadline / lâu chưa update. " +
    "Inputs: { staleDays?: number }. target từ ctx.",
  run: async (inputs, ctx) => {
    if (!ctx.target) return { ok: false, message: "missing target", error: "no Gapo cid" };
    try {
      const res = await bbPm.checkHygiene({ staleDays: inputs.staleDays ?? 14 });
      const r = res.data;
      const lines: string[] = [];
      lines.push(`🧹 *Data Hygiene Check*`);
      lines.push("");
      lines.push(`• Thiếu owner: *${r.missingOwner.length}*`);
      lines.push(`• Thiếu deadline: *${r.missingDeadline.length}*`);
      lines.push(`• Stale (≥ ${inputs.staleDays ?? 14}d): *${r.staleStatus.length}*`);
      const sample = (arr: any[], label: string) => {
        if (!arr.length) return;
        lines.push("");
        lines.push(`*${label} (top ${Math.min(arr.length, 3)}):*`);
        for (const t of arr.slice(0, 3)) {
          lines.push(`• ${t.name} — ${t.project?.name ?? "?"}`);
        }
      };
      sample(r.missingOwner, "Thiếu owner");
      sample(r.missingDeadline, "Thiếu deadline");
      sample(r.staleStatus, "Stale");
      await sendToGapo(ctx.target, lines.join("\n"));
      const total = r.missingOwner.length + r.missingDeadline.length + r.staleStatus.length;
      return { ok: true, message: `hygiene reported (${total} issues)`, meta: { total } };
    } catch (err: any) {
      return { ok: false, message: "hygiene_check workflow failed", error: err?.message ?? String(err) };
    }
  },
};

// ── role_based_digest ──────────────────────────────────────────────────
const roleBasedDigest: WorkflowDef = {
  name: "role_based_digest",
  description:
    "Digest theo role + project scope. Inputs: { userId, projectIds?, include?, " +
    "detailLevel?, daysAhead?, staleDays? }. Backend enforce company/project scope.",
  inputsSchema: {
    userId: { type: "number", required: true, description: "BB-PM user id người nhận." },
    projectIds: { type: "number[]", description: "Optional project ids để scope digest." },
    include: {
      type: "string[]",
      description:
        "overview, overdue, blocked, stale, milestones, pending_backlogs, cost, hygiene.",
    },
    detailLevel: { type: "string", description: "brief | normal | detailed." },
    daysAhead: { type: "number", description: "Window deadline/milestone sắp tới." },
    staleDays: { type: "number", description: "Ngưỡng stale task." },
  },
  run: async (inputs, ctx) => {
    if (!ctx.target) return { ok: false, message: "missing target", error: "no Gapo cid" };
    if (!Number.isInteger(inputs.userId)) {
      return { ok: false, message: "missing userId", error: "inputs.userId is required" };
    }
    try {
      const res = await bbPm.roleBasedDigest({
        userId: Number(inputs.userId),
        projectIds: Array.isArray(inputs.projectIds) ? inputs.projectIds.map(Number) : undefined,
        include: Array.isArray(inputs.include) ? inputs.include.map(String) : undefined,
        detailLevel: inputs.detailLevel,
        daysAhead: inputs.daysAhead,
        staleDays: inputs.staleDays,
      });
      const d = res.data;
      await sendToGapo(ctx.target, renderRoleDigest(d));
      return {
        ok: true,
        message: `role_based_digest sent to ${d.recipient.fullName}`,
        meta: {
          userId: d.recipient.id,
          role: d.recipient.role,
          projectCount: d.scope.projectCount,
          overview: d.overview,
        },
      };
    } catch (err: any) {
      return { ok: false, message: "role_based_digest failed", error: err?.message ?? String(err) };
    }
  },
};

// ── overdue_ping_round (placeholder cho Phase 4.1) ──────────────────────
// Quét overdue → ping mỗi assignee 1 lần (cooldown 24h via cooldown module).
// Hold off until cooldown.ts được expose ở module level + decide UX.

export const workflows: Record<string, WorkflowDef> = {
  daily_digest: dailyDigest,
  weekly_report: weeklyReport,
  hygiene_check: hygieneCheck,
  role_based_digest: roleBasedDigest,
};

export function listWorkflows(): Array<{ name: string; description: string }> {
  return Object.values(workflows).map((w) => ({ name: w.name, description: w.description }));
}

export async function runWorkflow(
  name: string,
  inputs: Record<string, any>,
  ctx: { source: "manual" | "cron"; target?: string; correlationId?: string },
): Promise<WorkflowResult> {
  const wf = workflows[name];
  if (!wf) {
    return {
      ok: false,
      message: `Workflow not found: ${name}`,
      error: `Available: ${Object.keys(workflows).join(", ")}`,
    };
  }
  return await wf.run(inputs, ctx);
}

// AgentContext compatibility — ctx adapter cho callers dùng AgentContext
export function ctxFromAgent(ac: AgentContext, target?: string) {
  return {
    source: (ac.source === "cron" ? "cron" : "manual") as "manual" | "cron",
    target,
    correlationId: ac.correlationId,
  };
}

function renderRoleDigest(d: RoleBasedDigest): string {
  switch (d.recipient.role) {
    case "ADMIN":
      return renderAdminDigest(d);
    case "MANAGER":
      return renderManagerDigest(d);
    case "MEMBER":
      return renderMemberDigest(d);
    case "VIEWER":
      return renderViewerDigest(d);
    default:
      return renderViewerDigest(d);
  }
}

function renderAdminDigest(d: RoleBasedDigest): string {
  const lines = header("Admin Ops Digest", d);
  lines.push(
    `Tong quan: ${d.overview.activeProjects} project active, ${d.overview.openTasks} task open, ${d.overview.overdueTasks} overdue, ${d.overview.blockedTasks} blocker.`,
  );
  if (d.pendingBacklogs.length) {
    lines.push("");
    lines.push(`Can duyet backlog: ${d.pendingBacklogs.length}`);
    for (const b of d.pendingBacklogs.slice(0, 5)) {
      lines.push(`- ${b.user.fullName}: ${b.hours}h - ${b.task.name} (${b.project?.name ?? "?"})`);
    }
  }
  pushCostRisks(lines, d);
  pushHygiene(lines, d);
  pushAutomationHint(lines);
  return lines.join("\n");
}

function renderManagerDigest(d: RoleBasedDigest): string {
  const lines = header("PM Daily Digest", d);
  lines.push(
    `Scope: ${d.scope.projectCount} project, ${d.overview.openTasks} task open, ${d.overview.overdueTasks} overdue, ${d.overview.blockedTasks} blocker.`,
  );
  pushTaskSection(lines, "Can xu ly hom nay", d.overdue, (t) =>
    `${t.name} (${t.project?.name ?? "?"}) - ${t.assignee?.fullName ?? "chua gan"} overdue ${t.daysOverdue ?? "?"}d`,
  );
  pushBlockers(lines, d);
  pushMilestones(lines, d);
  if (d.pendingBacklogs.length) {
    lines.push("");
    lines.push(`Can review: ${d.pendingBacklogs.length} backlog pending trong scope.`);
  }
  return lines.join("\n");
}

function renderMemberDigest(d: RoleBasedDigest): string {
  const lines = header("Work Digest cua ban", d);
  lines.push(
    `Hom nay: ${d.overview.openTasks} task open, ${d.overview.overdueTasks} overdue, ${d.overview.upcomingTasks} deadline sap toi.`,
  );
  pushTaskSection(lines, "Uu tien", [...d.overdue, ...d.upcoming], (t) => {
    const due = t.deadline ? String(t.deadline).slice(0, 10) : "chua co deadline";
    const overdue = t.daysOverdue ? ` - overdue ${t.daysOverdue}d` : "";
    return `${t.name} (${t.project?.name ?? "?"}) - deadline ${due}${overdue}`;
  });
  pushTaskSection(lines, "Can cap nhat", d.stale, (t) =>
    `${t.name} - chua update ${t.daysSinceUpdate}d`,
  );
  pushBlockers(lines, d);
  if (d.pendingBacklogs.length) {
    lines.push("");
    lines.push(`Backlog cua ban dang pending: ${d.pendingBacklogs.length}.`);
  }
  return lines.join("\n");
}

function renderViewerDigest(d: RoleBasedDigest): string {
  const lines = header("Project Summary", d);
  lines.push(
    `Scope: ${d.scope.projectCount} project, ${d.overview.openTasks} task open, ${d.overview.overdueTasks} overdue.`,
  );
  if (d.projects.length) {
    lines.push("");
    lines.push("Tien do project:");
    for (const p of d.projects.slice(0, 6)) {
      const pct = p.completionPct == null ? "n/a" : `${p.completionPct}%`;
      lines.push(`- ${p.name}: ${p.doneTaskCount}/${p.taskCount} (${pct})`);
    }
  }
  pushMilestones(lines, d);
  return lines.join("\n");
}

function header(title: string, d: RoleBasedDigest): string[] {
  return [
    `${title} - ${new Date(d.generatedAt).toLocaleDateString("vi-VN")}`,
    `Nguoi nhan: ${d.recipient.fullName} (${d.recipient.role})`,
    "",
  ];
}

function pushTaskSection<T>(
  lines: string[],
  title: string,
  tasks: T[],
  format: (task: T) => string,
) {
  const top = tasks.slice(0, 5);
  if (!top.length) return;
  lines.push("");
  lines.push(`${title}:`);
  for (const task of top) lines.push(`- ${format(task)}`);
}

function pushBlockers(lines: string[], d: RoleBasedDigest) {
  if (!d.blocked.length) return;
  lines.push("");
  lines.push("Blocker:");
  for (const b of d.blocked.slice(0, 5)) {
    lines.push(`- [${b.severity}] ${b.task.name} (${b.task.project?.name ?? "?"})`);
  }
}

function pushMilestones(lines: string[], d: RoleBasedDigest) {
  if (!d.milestones.length) return;
  lines.push("");
  lines.push("Milestone sap toi:");
  for (const m of d.milestones.slice(0, 5)) {
    const due = m.dueDate ? String(m.dueDate).slice(0, 10) : "n/a";
    lines.push(`- ${m.name} (${m.project.name}) - ${m.completionPct}% - due ${due}`);
  }
}

function pushHygiene(lines: string[], d: RoleBasedDigest) {
  const total =
    d.hygiene.missingOwner.length + d.hygiene.missingDeadline.length + d.hygiene.stale.length;
  if (!total) return;
  lines.push("");
  lines.push(
    `Data hygiene: ${d.hygiene.missingOwner.length} thieu owner, ${d.hygiene.missingDeadline.length} thieu deadline, ${d.hygiene.stale.length} stale.`,
  );
}

function pushCostRisks(lines: string[], d: RoleBasedDigest) {
  const risks = d.projects.filter(
    (p) => p.budget != null && p.budget > 0 && p.budgetRemaining != null && p.budgetRemaining / p.budget <= 0.2,
  );
  if (!risks.length) return;
  lines.push("");
  lines.push("Cost risk:");
  for (const p of risks.slice(0, 5)) {
    lines.push(`- ${p.name}: budget remaining ${p.budgetRemaining}/${p.budget}`);
  }
}

function pushAutomationHint(lines: string[]) {
  lines.push("");
  lines.push("Agent/automation: xem lastRunStatus neu can kiem tra job loi.");
}
