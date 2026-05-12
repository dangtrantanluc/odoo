// Pre-classifier unit tests — fast-path pattern matching boundary.
// Run với `tsx test/pre-classifier.test.ts`.

import { tryFastPath } from "../src/pre-classifier";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(text: string, expectPattern: string | null, ctx: any = { source: "chat", callerUserId: 24 }) {
  const r = tryFastPath(text, ctx);
  const got = r?.pattern ?? null;
  const ok = got === expectPattern;
  if (ok) {
    pass++;
  } else {
    fail++;
    failures.push(`✗ ${JSON.stringify(text)}\n    got=${got}, expect=${expectPattern}`);
  }
}

// ─── end_session ───
console.log("─── end_session ───");
for (const t of ["ok", "ok bạn", "ok cảm ơn", "cảm ơn", "cám ơn", "thanks", "tks", "👍", "👌", "bye", "tạm biệt", "rõ", "hiểu rồi"]) {
  check(t, "end_session");
}
// Negative — must NOT match end_session
for (const t of ["hi", "hello", "chào", "ok làm cho tôi", "thanks, list nốt task", "tôi đang làm gì", "có project nào"]) {
  check(t, t === "có project nào" ? "list_projects" : t === "có project nào active" ? "list_projects" : null);
}

// ─── my_tasks ───
console.log("\n─── my_tasks ───");
for (const t of ["task của tôi", "task của mình", "my tasks", "những việc của tôi"]) {
  check(t, "my_tasks");
}

// ─── overdue ───
console.log("\n─── overdue ───");
for (const t of ["task quá hạn", "có task nào quá hạn?", "overdue", "task trễ deadline"]) {
  check(t, "overdue");
}

// ─── my_role ───
console.log("\n─── my_role ───");
for (const t of [
  "tôi có quyền gì?",
  "mình có quyền gì trong hệ thống này?",
  "tôi là ai",
  "who am i",
  "role của tôi",
  "role của tôi là gì",
  "quyền của mình",
]) {
  check(t, "my_role");
}

// ─── list_projects ───
console.log("\n─── list_projects ───");
for (const t of ["có dự án nào active?", "list project", "dự án đang chạy", "có project nào"]) {
  check(t, "list_projects");
}

// ─── blocked_tasks ───
console.log("\n─── blocked_tasks ───");
for (const t of ["có task nào đang block?", "blocker", "task nào bị blocked", "blockers hiện tại"]) {
  check(t, "blocked_tasks");
}

// ─── stale_tasks ───
console.log("\n─── stale_tasks ───");
for (const t of ["task lâu chưa update", "task stale"]) {
  check(t, "stale_tasks");
}

// ─── daily_digest, weekly_report, list_automations ───
console.log("\n─── digest / weekly / automations ───");
check("digest", "daily_digest");
check("báo cáo hôm nay", "daily_digest");
check("weekly report", "weekly_report");
check("báo cáo tuần", "weekly_report");
check("list automations", "list_automations");

// ─── Negative: random questions không nên match bất kỳ pattern ───
console.log("\n─── negative ───");
for (const t of [
  "tạo task mới cho team A",
  "ai làm task #42",
  "task #42 trạng thái gì",
  "gửi DM cho Lực",
  "đổi deadline task 5",
]) {
  check(t, null);
}

// ─── Caller-required pattern (no callerUserId → fall back) ───
console.log("\n─── no callerUserId → my_tasks/my_role fall back ───");
const noCaller = { source: "chat" as const };
check("task của tôi", null, noCaller);
check("tôi có quyền gì?", null, noCaller);

// ─── Summary ───
console.log(`\n${pass} pass · ${fail} fail (${pass + fail} total)`);
if (fail > 0) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(f));
  process.exit(1);
}
console.log("✅ All pre-classifier tests pass");
