import cron from "node-cron";
import { runAgent } from "./orchestrator";
import { sendToGapo } from "./channel-out";
import { config } from "./config";

type CronJob = {
  name: string;
  schedule: string;
  prompt: string;
  target: string; // Gapo conversation id
  source: "cron";
};

function parseJobs(): CronJob[] {
  const jobs: CronJob[] = [];

  if (config.cron.dailyDigest.target && config.cron.dailyDigest.schedule) {
    jobs.push({
      name: "daily-digest",
      schedule: config.cron.dailyDigest.schedule,
      prompt:
        "Tổng hợp báo cáo sáng: gọi generate_daily_digest + list_overdue_tasks. " +
        "Trình bày: (1) số liệu tổng, (2) top 3 dự án cần chú ý, (3) danh sách task quá hạn nhóm theo dự án.",
      target: config.cron.dailyDigest.target,
      source: "cron",
    });
  }

  if (config.cron.weeklyHygiene.target && config.cron.weeklyHygiene.schedule) {
    jobs.push({
      name: "weekly-hygiene",
      schedule: config.cron.weeklyHygiene.schedule,
      prompt:
        "Gọi check_data_hygiene và báo cáo: bao nhiêu task thiếu owner, " +
        "thiếu deadline, status không update > 14 ngày. Nêu sample tối đa 5 task mỗi nhóm.",
      target: config.cron.weeklyHygiene.target,
      source: "cron",
    });
  }

  return jobs;
}

export function startScheduler() {
  const jobs = parseJobs();
  if (!jobs.length) {
    console.log("[bb-pm-tools] scheduler: no jobs configured (set CRON_* env to enable)");
    return;
  }

  for (const job of jobs) {
    if (!cron.validate(job.schedule)) {
      console.error(`[bb-pm-tools] invalid cron expr for ${job.name}: ${job.schedule}`);
      continue;
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
      } catch (err: any) {
        console.error(`[bb-pm-tools] cron ${job.name} failed:`, err?.message || err);
      }
    }, { timezone: config.cron.timezone });
    console.log(`[bb-pm-tools] cron scheduled: ${job.name} = "${job.schedule}" (${config.cron.timezone})`);
  }
}
