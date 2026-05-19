#!/usr/bin/env node
// Standalone CLI for smoke testing.
//   pnpm cli "task nào quá hạn?"
//   pnpm cli --digest         # runs the daily digest prompt immediately
//   pnpm cli --hygiene        # runs the weekly hygiene prompt immediately
//   pnpm cli --workflow noon_checkin_reminder

import { runAgent } from "./orchestrator";
import { assertConfig } from "./config";
import { runWorkflow } from "./workflows/registry";

const PRESETS: Record<string, string> = {
  "--digest":
    "Tổng hợp báo cáo sáng: gọi generate_daily_digest + list_overdue_tasks. " +
    "Trình bày: (1) số liệu tổng, (2) top 3 dự án cần chú ý, (3) danh sách task quá hạn nhóm theo dự án.",
  "--hygiene":
    "Gọi check_data_hygiene và báo cáo: bao nhiêu task thiếu owner, thiếu deadline, status không update > 14 ngày. " +
    "Nêu sample tối đa 5 task mỗi nhóm.",
  "--stale": "Task nào lâu chưa update (trên 7 ngày)?",
  "--overdue": "Task nào đang quá hạn?",
};

async function main() {
  const missing = assertConfig();
  if (missing.includes("BB_PM_AGENT_TOKEN")) {
    console.error(`Missing env: ${missing.join(", ")}`);
    process.exit(1);
  }

  const argv = process.argv.slice(2);
  if (argv[0] === "--workflow") {
    const name = argv[1];
    if (!name) {
      console.error("Missing workflow name after --workflow");
      process.exit(1);
    }
    const result = await runWorkflow(name, {}, {
      source: "manual",
      correlationId: `cli-workflow-${Date.now()}`,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const first = argv[0];
  const question =
    first && PRESETS[first] ? PRESETS[first] : argv.join(" ").trim() || "Có task nào quá hạn không?";

  console.log(`→ ${question}\n`);
  const answer = await runAgent(question, { source: "cli" });
  console.log(answer);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
