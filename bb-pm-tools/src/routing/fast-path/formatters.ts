import { NO_CALLER_REPLY } from "./constants";

// ── Format helpers ────────────────────────────────────────────────────────

export function cleanTaskLookupQuery(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[\?.!]+$/g, "")
    .trim();
}

export function normalizeLookupLabel(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function pickBestTaskMatch(rows: any[], query: string): any | null {
  if (!rows?.length) return null;
  const q = normalizeLookupLabel(query);
  const exact = rows.find((r) => normalizeLookupLabel(String(r?.name ?? "")) === q);
  if (exact) return exact;
  const startsWith = rows.find((r) => normalizeLookupLabel(String(r?.name ?? "")).startsWith(q));
  if (startsWith) return startsWith;
  return rows[0] ?? null;
}

export function formatTaskOwnerLookup(rows: any[], query: string): string {
  if (!rows?.length) return `Không thấy task "${query}".`;
  const task = pickBestTaskMatch(rows, query);
  if (!task) return `Không thấy task "${query}".`;
  return task.assignee
    ? `${task.name} đang giao cho @${task.assignee}.`
    : `${task.name} hiện chưa có người phụ trách.`;
}

export function formatTaskDeadlineLookup(rows: any[], query: string): string {
  if (!rows?.length) return `Không thấy task "${query}".`;
  const task = pickBestTaskMatch(rows, query);
  if (!task) return `Không thấy task "${query}".`;
  return task.deadline
    ? `${task.name} có deadline ${String(task.deadline).slice(0, 10)}.`
    : `${task.name} hiện chưa có deadline.`;
}

export function formatTaskStatusLookup(rows: any[], query: string): string {
  if (!rows?.length) return `Không thấy task "${query}".`;
  const task = pickBestTaskMatch(rows, query);
  if (!task) return `Không thấy task "${query}".`;
  const assignee = task.assignee ? ` · @${task.assignee}` : "";
  return `${task.name} đang ở trạng thái ${task.status}${assignee}.`;
}

export function formatTaskProgressLookup(rows: any[], query: string): string {
  if (!rows?.length) return `Không thấy task "${query}".`;
  const task = pickBestTaskMatch(rows, query);
  if (!task) return `Không thấy task "${query}".`;
  const assignee = task.assignee ? ` · @${task.assignee}` : " · chưa assign";
  const deadline = task.deadline ? ` · hạn ${String(task.deadline).slice(0, 10)}` : "";
  return `${task.name} đang ${task.status}${assignee}${deadline}.`;
}

export function formatProjectSnapshotLookup(result: any, query: string): string {
  if (!result?.found || !result?.snapshot) return `Không thấy dự án "${query}".`;
  const snap = result.snapshot;
  const tasks: Array<{
    name?: string;
    status?: string;
    priority?: string;
    deadline?: string | null;
    assignee?: { fullName?: string | null } | null;
  }> = Array.isArray(snap.tasks) ? snap.tasks : [];
  const summary = snap.taskSummary ?? {};
  const open = Number.isFinite(Number(summary.open))
    ? Number(summary.open)
    : tasks.filter((t) => t?.status !== "DONE").length;
  const done = Number.isFinite(Number(summary.done))
    ? Number(summary.done)
    : tasks.filter((t) => t?.status === "DONE").length;
  const overdue = Number.isFinite(Number(summary.overdueOpen))
    ? Number(summary.overdueOpen)
    : tasks.filter((t) => t?.status !== "DONE" && t?.deadline && new Date(t.deadline).getTime() < Date.now()).length;
  const omitted = Number(summary.omittedTasks ?? 0);
  const top = tasks
    .filter((t) => t?.status !== "DONE")
    .sort((a, b) => {
      const pa = priorityRank(a?.priority);
      const pb = priorityRank(b?.priority);
      if (pa !== pb) return pb - pa;
      const da = a?.deadline ? new Date(a.deadline).getTime() : Number.MAX_SAFE_INTEGER;
      const db = b?.deadline ? new Date(b.deadline).getTime() : Number.MAX_SAFE_INTEGER;
      return da - db;
    })
    .slice(0, 3)
    .map((t) => {
      const assignee = t?.assignee?.fullName ? `@${t.assignee.fullName}` : "chưa assign";
      const deadline = t?.deadline ? String(t.deadline).slice(0, 10) : "chưa có hạn";
      return `${t?.name} · ${assignee} · ${deadline}`;
    });
  const headline =
    `${snap.name} đang ${snap.status}. ${open} task mở · ${done} task done` +
    (overdue > 0 ? ` · ${overdue} quá hạn.` : ".");
  if (!top.length) return headline;
  return `${headline}\n${top.join("\n")}${omitted > 0 ? `\n... còn ${omitted} task mở khác.` : ""}`;
}

export function formatProjectDailyProgress(rows: any[], query: string): string {
  if (!rows?.length) return `Không thấy dự án "${query}".`;
  const row = rows[0];
  const projectName = row.project_name ?? row.projectName ?? query;
  const checkinCount = Number(row.checkin_count ?? 0);
  if (!checkinCount) return `${projectName} hôm nay chưa có worklog/check-in nào.`;
  const hours = Number(row.total_hours ?? 0);
  const blockerCount = Number(row.blocker_count ?? 0);
  const updates = String(row.updates ?? "").trim();
  const blockerText = blockerCount ? ` Có ${blockerCount} blocker.` : "";
  return `${projectName} hôm nay có ${checkinCount} worklog, tổng ${hours}h.${blockerText}${updates ? `\n${updates}` : ""}`;
}

export function priorityRank(priority: string | null | undefined): number {
  switch (priority) {
    case "URGENT":
      return 4;
    case "HIGH":
      return 3;
    case "MEDIUM":
      return 2;
    case "LOW":
      return 1;
    default:
      return 0;
  }
}

export function formatPersonTasks(result: any, targetName: string): string {
  if (result?.kind === "no_caller") return NO_CALLER_REPLY;
  if (result?.kind === "forbidden") return "Bạn chỉ có thể xem task của chính mình.";
  if (result?.kind === "not_found") return `Không thấy người dùng "${targetName}".`;
  if (result?.kind === "ambiguous") {
    const names = (result.matches ?? []).slice(0, 3).map((u: any) => u.name).join(" · ");
    return `Có nhiều người khớp tên này: ${names}. Bạn nói rõ hơn nhé.`;
  }
  const name = result?.target?.name ?? targetName;
  const tasks = Array.isArray(result?.tasks) ? result.tasks : [];
  if (!tasks.length) return `${name} hiện không có task open nào.`;
  const top = tasks.slice(0, 5).map((t: any) => t.name);
  const suffix = tasks.length > 5 ? ` · và ${tasks.length - 5} task khác` : "";
  return `${name} có ${tasks.length} task open: ${top.join(" · ")}${suffix}.`;
}

export function formatPersonDailyProgress(rows: any[], targetName: string): string {
  if (!rows?.length) return `Không thấy người dùng "${targetName}".`;
  const row = rows[0];
  const name = row.full_name ?? row.fullName ?? targetName;
  const checkinCount = Number(row.checkin_count ?? 0);
  const openTasks = Number(row.open_tasks ?? 0);
  if (!checkinCount) {
    return `${name} chưa có update worklog hôm nay. Hiện đang có ${openTasks} task open.`;
  }
  const hours = Number(row.total_hours ?? 0);
  const updates = String(row.updates ?? "").trim();
  const taskText = openTasks ? ` Hiện còn ${openTasks} task open.` : "";
  return `${name} đã update hôm nay: ${hours}h.${updates ? `\n${updates}` : ""}${taskText}`;
}

export function formatTaskList(rows: any[], title: string): string {
  if (!rows?.length) return `${title}: không có ✅`;
  const lines = [`**${title}** (${rows.length}):`];
  for (const t of rows.slice(0, 10)) {
    const proj = t.project ?? t.project_name ?? "?";
    const deadline = t.deadline ? ` — hạn ${String(t.deadline).slice(0, 10)}` : "";
    const priority = t.priority && t.priority !== "MEDIUM" ? ` [${t.priority}]` : "";
    lines.push(`• ${t.name} (${proj})${priority}${deadline} — ${t.status}`);
  }
  if (rows.length > 10) lines.push(`_... và ${rows.length - 10} task khác_`);
  return lines.join("\n");
}

export function formatOverdueList(tasks: any[], total: number): string {
  if (!tasks?.length) return "Không có task quá hạn ✅";
  const lines = [`**${total} task quá hạn**:`];
  // Group by project
  const byProj = new Map<string, any[]>();
  for (const t of tasks) {
    const p = t.project ?? "(không xác định)";
    if (!byProj.has(p)) byProj.set(p, []);
    byProj.get(p)!.push(t);
  }
  for (const [proj, list] of byProj) {
    lines.push(`\n**${proj}:**`);
    for (const t of list.slice(0, 5)) {
      const days = t.daysOverdue != null ? ` — trễ ${t.daysOverdue} ngày` : "";
      const assignee = t.assignee ? ` (${t.assignee})` : " (chưa gán)";
      lines.push(`• ${t.name}${days}${assignee}`);
    }
    if (list.length > 5) lines.push(`  _+${list.length - 5} task nữa_`);
  }
  return lines.join("\n");
}

export function formatDigest(d: any): string {
  if (!d) return "Không có data digest.";
  const t = d.totals ?? {};
  const lines = [
    `📊 **Digest hôm nay (${new Date().toLocaleDateString("vi-VN")})**`,
    "",
    `• Dự án active: **${t.activeProjects ?? "?"}**`,
    `• Task mở: **${t.openTasks ?? "?"}** | Quá hạn: **${t.overdueTasks ?? "?"}** | Stale: **${t.staleTasks ?? "?"}** | Chưa gán: **${t.unassignedTasks ?? "?"}**`,
  ];
  const projects = (d.projects ?? []).slice(0, 5);
  if (projects.length) {
    lines.push("", "**Dự án:**");
    for (const p of projects) {
      const pct = p.completionPct != null ? ` (${Math.round(p.completionPct)}%)` : "";
      lines.push(`• ${p.name}: ${p.doneTaskCount}/${p.taskCount}${pct}`);
    }
  }
  return lines.join("\n");
}

export function formatWeekly(r: any): string {
  if (!r) return "Không có data weekly report.";
  const t = r.totals ?? {};
  const w = r.window ?? {};
  return [
    `📆 **Báo cáo tuần (${(w.start ?? "").slice(0, 10)} → ${(w.end ?? "").slice(0, 10)})**`,
    "",
    `• Task hoàn thành: **${t.tasksDone ?? 0}** | Task mới: ${t.newTasks ?? 0} | Blocker mới: ${t.newBlockers ?? 0}`,
    `• Hours approved: **${(t.hoursApproved ?? 0).toFixed?.(1) ?? "?"}h** | Cost: ${t.costApproved ?? "?"}`,
  ].join("\n");
}

export function formatAutomations(list: any[], total: number): string {
  if (!list?.length) return "Không có automation nào đang chạy.";
  const lines = [`**${total} automation đang chạy**:`];
  for (const a of list) {
    const lr = a.lastRunStatus
      ? ` | last: ${a.lastRunStatus}${a.lastRunAt ? " " + String(a.lastRunAt).slice(0, 16).replace("T", " ") : ""}`
      : "";
    const target = a.target ? ` | target: ${a.target}` : "";
    const fails = a.consecutiveFails ? ` | fails: ${a.consecutiveFails}` : "";
    const err = a.lastRunError ? ` | lỗi: ${String(a.lastRunError).slice(0, 140)}` : "";
    lines.push(`• #${a.id} **${a.name}** — \`${a.schedule}\` → ${a.workflow}${target}${lr}${fails}${err}`);
  }
  return lines.join("\n");
}

// Pattern 7: my_role
export function formatRole(user: any): string {
  if (!user) return "Mình chưa nhận diện được bạn trong hệ thống.";
  const role = user.role ?? "MEMBER";
  // Capabilities theo role — concise inline format (đúng style mới).
  const caps: Record<string, string> = {
    ADMIN: "cấu hình project · duyệt task · quản lý user · xem audit",
    MANAGER: "duyệt task · phân công · quản lý project mình sở hữu",
    MEMBER: "cập nhật task của mình · báo blocker · đọc digest",
    VIEWER: "xem dashboard · đọc digest (read-only)",
  };
  const cap = caps[role] ?? caps.MEMBER;
  return `${role}. ${cap}.`;
}

// Pattern 8: list_projects
export function formatProjectList(rows: any[], total?: number): string {
  if (!rows?.length) return "Không có dự án nào đang hoạt động.";
  const t = total ?? rows.length;
  const lines = [`**${t} dự án active**:`];
  for (const p of rows.slice(0, 15)) {
    const status = p.status && p.status !== "ACTIVE" ? ` [${p.status}]` : "";
    const owner = p.owner ?? p.ownerName ?? p.owner_name;
    const ownerStr = owner ? ` · @${owner}` : "";
    const deadline = p.endDate || p.end_date;
    const dl = deadline ? ` · hạn ${String(deadline).slice(0, 10)}` : "";
    lines.push(`• #${p.id ?? "?"} ${p.name ?? "(không tên)"}${status}${ownerStr}${dl}`);
  }
  if (rows.length > 15) lines.push(`_... và ${rows.length - 15} dự án khác_`);
  return lines.join("\n");
}

// Pattern 9: blocked_tasks
export function formatBlockedList(tasks: any[], total?: number): string {
  if (!tasks?.length) return "Không có task nào bị block ✅";
  const t = total ?? tasks.length;
  const lines = [`**${t} task đang block**:`];
  for (const task of tasks.slice(0, 15)) {
    const sev = task.severity ? ` [${task.severity}]` : "";
    const proj = task.project ?? task.projectName ?? task.project_name;
    const projStr = proj ? ` (${proj})` : "";
    const reason = task.reason ?? task.blockerReason ?? task.blocker_reason;
    const reasonStr = reason ? ` — ${String(reason).slice(0, 60)}` : "";
    lines.push(`• ${task.name ?? "?"}${projStr}${sev}${reasonStr}`);
  }
  if (tasks.length > 15) lines.push(`_... và ${tasks.length - 15} task khác_`);
  return lines.join("\n");
}

// Pattern 10: stale_tasks
export function formatStaleList(tasks: any[], total?: number): string {
  if (!tasks?.length) return "Không có task nào stale ✅";
  const t = total ?? tasks.length;
  const lines = [`**${t} task lâu chưa update**:`];
  for (const task of tasks.slice(0, 15)) {
    const days = task.daysSinceUpdate ?? task.days_since_update;
    const daysStr = days != null ? ` — ${days}d không update` : "";
    const proj = task.project ?? task.projectName ?? task.project_name;
    const projStr = proj ? ` (${proj})` : "";
    const assignee = task.assignee ?? task.assigneeName;
    const aStr = assignee ? ` · @${assignee}` : "";
    lines.push(`• ${task.name ?? "?"}${projStr}${aStr}${daysStr}`);
  }
  if (tasks.length > 15) lines.push(`_... và ${tasks.length - 15} task khác_`);
  return lines.join("\n");
}
