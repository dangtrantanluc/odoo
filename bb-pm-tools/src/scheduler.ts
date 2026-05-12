import cron, { ScheduledTask } from "node-cron";
import { runAgent } from "./orchestrator";
import { notifyAdmin, sendToGapo } from "./channel-out";
import { config } from "./config";
import { bbPm } from "./api-client";
import { runWorkflow } from "./workflows/registry";

type LegacyCronJob = {
  name: string;
  schedule: string;
  prompt: string;
  target: string; // Gapo conversation id
  source: "cron";
};

// Legacy hardcoded jobs (giữ backward compat — sẽ retire khi migration to
// Automation table xong cho tất cả tenant). Active nếu env CRON_*_TARGET set.
function parseLegacyJobs(): LegacyCronJob[] {
  const jobs: LegacyCronJob[] = [];

  if (config.cron.dailyDigest.target && config.cron.dailyDigest.schedule) {
    jobs.push({
      name: "daily-digest-legacy",
      schedule: config.cron.dailyDigest.schedule,
      prompt:
        "Daily standup 9:00 sáng. Gọi generate_daily_digest + list_overdue_tasks " +
        "+ list_stale_tasks. Trình bày tin cho cả team đọc:\n" +
        "1. **Tổng quan hôm nay** (số task active, done hôm qua, sắp deadline).\n" +
        "2. **Task quá hạn** (nhóm theo assignee, ai có nhiều task overdue → highlight).\n" +
        "3. **Task lâu chưa update** (>14 ngày, nhắc owner check).\n" +
        "4. **Task có deadline trong tuần** (ai đang gấp).\n" +
        "5. Mention người được nhắc: dùng tag @<tên>.\n" +
        "Giọng ngắn gọn, dùng bullet, emoji vừa phải. Không quá 1500 chars.",
      target: config.cron.dailyDigest.target,
      source: "cron",
    });
  }

  if (config.cron.weeklyHygiene.target && config.cron.weeklyHygiene.schedule) {
    jobs.push({
      name: "weekly-hygiene-legacy",
      schedule: config.cron.weeklyHygiene.schedule,
      prompt:
        "Thông báo đầu tuần cho cả team. Gọi generate_weekly_report + check_data_hygiene. " +
        "Trình bày ngắn gọn: 1) kết quả tuần qua, 2) task/blocker cần chú ý, " +
        "3) hygiene task thiếu owner/deadline/lâu chưa update, 4) ưu tiên đầu tuần. " +
        "Mention người liên quan bằng @<tên>. Không quá 1500 chars.",
      target: config.cron.weeklyHygiene.target,
      source: "cron",
    });
  }

  return jobs;
}

function registerLegacyJob(job: LegacyCronJob) {
  if (!cron.validate(job.schedule)) {
    console.error(`[bb-pm-tools] invalid cron expr for ${job.name}: ${job.schedule}`);
    return;
  }
  cron.schedule(job.schedule, async () => {
    const startedAt = new Date();
    console.log(`[bb-pm-tools] cron ${job.name} fired at ${startedAt.toISOString()}`);
    try {
      const answer = await runAgent(job.prompt, {
        source: "cron",
        correlationId: `${job.name}-${startedAt.getTime()}`,
      });
      await sendToGapo(job.target, answer);
      console.log(`[bb-pm-tools] cron ${job.name} sent (${answer.length} chars) → ${job.target}`);
    } catch (err: any) {
      console.error(`[bb-pm-tools] cron ${job.name} failed:`, err?.message || err);
      void notifyAdmin(`Cron "${job.name}" failed`, err);
    }
  }, { timezone: config.cron.timezone });
  console.log(`[bb-pm-tools] cron scheduled: ${job.name} = "${job.schedule}" (${config.cron.timezone})`);
}

// Phase 4.1 — hot register/unregister với poll loop.
// Mỗi 60s check DB diff vs registered jobs. New active → schedule(). Inactive
// hoặc deleted → stop().
const DEAD_MAN_FAILS = 3;
const REGISTRY_POLL_MS = Number(process.env.AUTOMATION_POLL_MS ?? 60_000);

type Registered = {
  task: ScheduledTask;
  schedule: string;
  workflow: string;
  target: string | null;
};
const registered = new Map<number, Registered>();

function registerAutomation(a: {
  id: number;
  name: string;
  schedule: string;
  workflow: string;
  target: string | null;
  consecutiveFails: number;
}): boolean {
  if (a.consecutiveFails >= DEAD_MAN_FAILS) {
    console.warn(
      `[bb-pm-tools] automation #${a.id} (${a.name}) skipped — ${a.consecutiveFails} consecutive fails (dead-man).`,
    );
    return false;
  }
  if (!cron.validate(a.schedule)) {
    console.error(`[bb-pm-tools] automation #${a.id} invalid cron: ${a.schedule}`);
    return false;
  }
  const task = cron.schedule(
    a.schedule,
    () => runDbAutomation(a.id, a.name, a.workflow, a.target ?? undefined),
    { timezone: config.cron.timezone },
  );
  registered.set(a.id, { task, schedule: a.schedule, workflow: a.workflow, target: a.target });
  return true;
}

function unregisterAutomation(id: number, reason: string) {
  const r = registered.get(id);
  if (!r) return;
  r.task.stop();
  registered.delete(id);
  console.log(`[bb-pm-tools] DB automation #${id} unregistered (${reason})`);
}

async function syncRegistry() {
  let active: Awaited<ReturnType<typeof bbPm.listAutomations>>["data"];
  try {
    const res = await bbPm.listAutomations({ active: true, limit: 200 });
    active = res.data;
  } catch (err: any) {
    console.warn("[bb-pm-tools] scheduler poll failed:", err?.message ?? err);
    return;
  }

  const seen = new Set<number>();
  for (const a of active) {
    seen.add(a.id);
    const cur = registered.get(a.id);
    if (!cur) {
      const ok = registerAutomation(a);
      if (ok) console.log(`[bb-pm-tools] DB automation #${a.id} (${a.name}) scheduled "${a.schedule}" → ${a.workflow}`);
      continue;
    }
    // Check if schedule/workflow/target changed → re-register
    if (cur.schedule !== a.schedule || cur.workflow !== a.workflow || (cur.target ?? null) !== (a.target ?? null)) {
      unregisterAutomation(a.id, "config changed");
      const ok = registerAutomation(a);
      if (ok) console.log(`[bb-pm-tools] DB automation #${a.id} re-scheduled (config changed)`);
    }
    // Dead-man kicks in via consecutiveFails
    if (a.consecutiveFails >= DEAD_MAN_FAILS) {
      unregisterAutomation(a.id, `dead-man: ${a.consecutiveFails} fails`);
    }
  }
  // Unregister jobs no longer active in DB
  for (const id of registered.keys()) {
    if (!seen.has(id)) unregisterAutomation(id, "no longer active in DB");
  }
}

async function runDbAutomation(id: number, name: string, workflow: string, target: string | undefined) {
  const startedAt = new Date();
  console.log(`[bb-pm-tools] automation #${id} ${name} fired at ${startedAt.toISOString()}`);
  try {
    // Re-fetch latest inputs (in case user updated)
    const list = await bbPm.listAutomations({ limit: 200 });
    const cur = list.data.find((x) => x.id === id);
    if (!cur || !cur.active) {
      console.log(`[bb-pm-tools] automation #${id} skipped (not active or missing)`);
      return;
    }
    const result = await runWorkflow(
      workflow,
      cur.inputs ?? {},
      { source: "cron", target: target ?? cur.target ?? undefined, correlationId: `auto-${id}-${startedAt.getTime()}` },
    );
    await bbPm.patchAutomation(id, {
      lastRunAt: new Date().toISOString(),
      lastRunStatus: result.ok ? "ok" : "error",
      lastRunError: result.ok ? null : (result.error ?? result.message)?.slice(0, 2000),
      consecutiveFails: result.ok ? 0 : (cur.consecutiveFails ?? 0) + 1,
    });
    console.log(`[bb-pm-tools] automation #${id} ${result.ok ? "OK" : "ERROR"}: ${result.message}`);
    if (!result.ok) {
      void notifyAdmin(
        `Automation #${id} "${name}" workflow=${workflow} failed`,
        result.error ?? result.message ?? "unknown",
      );
    }
  } catch (err: any) {
    console.error(`[bb-pm-tools] automation #${id} crashed:`, err?.message ?? err);
    void notifyAdmin(`Automation #${id} "${name}" crashed`, err);
    try {
      await bbPm.patchAutomation(id, {
        lastRunAt: new Date().toISOString(),
        lastRunStatus: "error",
        lastRunError: String(err?.message ?? err).slice(0, 2000),
      });
    } catch {}
  }
}

// Sprint 8 follow-up — audit log retention sweep cron.
// Daily 3 AM (ICT) DELETE rows > AUDIT_RETENTION_DAYS old. Bảo vệ Postgres
// growth tránh bloat khi 40 user × 30 msg/day × 5 tool calls = 6K rows/day.
//
// Disable bằng AUDIT_RETENTION_DAYS=0. Default 90 ngày = ~540K rows max
// (well under partition threshold).
function registerAuditCleanupCron(): void {
  const days = Number(process.env.AUDIT_RETENTION_DAYS ?? 90);
  if (!Number.isFinite(days) || days <= 0) {
    console.log("[bb-pm-tools] audit retention cleanup disabled (AUDIT_RETENTION_DAYS=0)");
    return;
  }
  const schedule = process.env.AUDIT_CLEANUP_SCHEDULE ?? "0 3 * * *"; // 3 AM daily
  cron.schedule(
    schedule,
    async () => {
      try {
        const t0 = Date.now();
        const r = await bbPm.cleanupAudit(days, false);
        console.log(
          `[bb-pm-tools] audit cleanup ok: deleted=${r.data.deletedCount} cutoff=${r.data.cutoff} dur=${Date.now() - t0}ms`,
        );
      } catch (err: any) {
        console.error("[bb-pm-tools] audit cleanup failed:", err?.message ?? err);
        void notifyAdmin("Audit cleanup cron failed", err);
      }
    },
    { timezone: config.cron.timezone },
  );
  console.log(
    `[bb-pm-tools] audit cleanup cron scheduled: "${schedule}" retention=${days}d (${config.cron.timezone})`,
  );
}

export async function startScheduler() {
  // Legacy env-based jobs
  const legacy = parseLegacyJobs();
  for (const j of legacy) registerLegacyJob(j);

  // Audit log retention sweep (independent of legacy/DB jobs)
  registerAuditCleanupCron();

  // DB-backed automations (Phase 4) — initial sync + poll loop
  await syncRegistry();
  console.log(
    `[bb-pm-tools] scheduler: ${registered.size} DB automation(s) registered. Polling every ${REGISTRY_POLL_MS / 1000}s for changes.`,
  );

  // Hot-register poll loop (Phase 4.1)
  setInterval(() => {
    void syncRegistry().catch((err: any) => {
      console.warn("[bb-pm-tools] scheduler poll error:", err?.message ?? err);
    });
  }, REGISTRY_POLL_MS);

  if (legacy.length === 0) {
    console.log("[bb-pm-tools] scheduler: legacy env jobs disabled (set CRON_*_TARGET to enable)");
  }
}
