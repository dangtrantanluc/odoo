#!/usr/bin/env node
// Standalone CLI for smoke testing workflows.
//   pnpm cli --workflow noon_checkin_reminder
//   pnpm cli --workflow eod_checkin_reminder
//   pnpm cli --workflow missing_checkin_followup
//   pnpm cli --workflow daily_digest

import { assertConfig } from "./config";
import { runWorkflow } from "./workflows/registry";

async function main() {
  const missing = assertConfig();
  if (missing.includes("BB_PM_AGENT_TOKEN")) {
    console.error(`Missing env: ${missing.join(", ")}`);
    process.exit(1);
  }

  const argv = process.argv.slice(2);
  if (argv[0] !== "--workflow") {
    console.error("Usage: cli --workflow <name>  (vd: noon_checkin_reminder)");
    process.exit(1);
  }
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
