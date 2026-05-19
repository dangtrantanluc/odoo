// Pre-classifier unit tests — fast-path pattern matching boundary.
// Run với `tsx test/pre-classifier.test.ts`.

import {
  detectIntentWithScore,
  normalizeFastPathText,
  tryFastPath,
} from "../src/pre-classifier";

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
for (const t of ["ok làm cho tôi", "thanks, list nốt task", "tôi đang làm gì", "có project nào"]) {
  check(t, t === "có project nào" ? "list_projects" : t === "có project nào active" ? "list_projects" : null);
}

// ─── greeting ───
console.log("\n─── greeting ───");
for (const t of ["hi", "hello", "chào", "xin chào", "hi b", "hello b"]) {
  check(t, "greeting");
}

// ─── my_tasks ───
console.log("\n─── my_tasks ───");
for (const t of ["task của tôi", "task của mình", "my tasks", "những việc của tôi"]) {
  check(t, "my_tasks");
}

console.log("\n─── slot intent detector ───");
const intentCases: Array<[string, string, string]> = [
  ["task của tôi hôm nay là gì vậy", "my_tasks_today", "intent:my_tasks_today"],
  ["hôm nay em có task gì không", "my_tasks_today", "intent:my_tasks_today"],
  ["chiều nay mình có việc gì", "my_tasks_today", "intent:my_tasks_today"],
  ["today my tasks", "my_tasks_today", "intent:my_tasks_today"],
  ["project tôi đang làm", "my_projects", "intent:my_projects"],
  ["dự án của em là gì", "my_projects", "intent:my_projects"],
  ["task nào quá hạn", "overdue_tasks", "intent:overdue_tasks"],
  ["có việc nào trễ deadline không", "overdue_tasks", "intent:overdue_tasks"],
  ["task nào bị block", "blocked_tasks", "intent:blocked_tasks"],
  ["báo cáo hôm nay", "daily_digest", "intent:daily_digest"],
  ["deadline tuần này của tôi", "my_tasks_week", "intent:my_tasks_week"],
];
for (const [input, expectedIntent, expectedPattern] of intentCases) {
  const detected = detectIntentWithScore(normalizeFastPathText(input));
  if (detected.intent !== expectedIntent) {
    fail++;
    failures.push(`✗ intent ${JSON.stringify(input)}\n    got=${detected.intent}, expect=${expectedIntent}`);
  } else {
    pass++;
  }
  check(input, expectedPattern);
}

// ─── overdue ───
console.log("\n─── overdue ───");
for (const t of ["task quá hạn", "có task nào quá hạn?", "overdue", "task trễ deadline"]) {
  check(t, t === "overdue" ? "slash:overdue" : "intent:overdue_tasks");
}

// ─── person_tasks ───
console.log("\n─── person_tasks ───");
for (const t of ["task của phương thảo", "task của Phương Thảo là gì", "Phương Thảo có task gì"]) {
  check(t, "person_tasks");
}
check("tiến độ công việc của Trường hôm nay thế nào", "person_daily_progress");
check("tiến độ của Lực", "person_daily_progress");
check("tiến độ hiện tại cuar MTL", "project_daily_progress");

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
  check(t, t === "who am i" ? "my_role" : "intent:my_role");
}

// ─── list_projects ───
console.log("\n─── list_projects ───");
for (const t of ["có dự án nào active?", "list project", "dự án đang chạy", "có project nào"]) {
  check(t, "list_projects");
}

// ─── blocked_tasks ───
console.log("\n─── blocked_tasks ───");
for (const t of ["có task nào đang block?", "blocker", "task nào bị blocked", "blockers hiện tại"]) {
  check(t, t === "blocker" ? "slash:blocker" : t === "blockers hiện tại" ? "blocked_tasks" : "intent:blocked_tasks");
}

// ─── stale_tasks ───
console.log("\n─── stale_tasks ───");
for (const t of ["task lâu chưa update", "task stale"]) {
  check(t, "intent:stale_tasks");
}

// ─── daily_digest, weekly_report, list_automations ───
console.log("\n─── digest / weekly / automations ───");
check("digest", "slash:digest");
check("báo cáo hôm nay", "intent:daily_digest");
check("weekly report", "intent:weekly_report");
check("báo cáo tuần", "intent:weekly_report");
check("list automations", "list_automations");

// ─── Negative: random questions không nên match bất kỳ pattern ───
console.log("\n─── negative ───");
for (const t of [
  "tạo task mới cho team A",
  "toi muon tao project moi",
  "task #42 trạng thái gì",
  "gửi DM cho Lực",
  "đổi deadline task 5",
]) {
  check(t, null);
}
check("[GAPO_USER: Unknown] hi\n\n--- Context ---\nUser: Dự án này có 70 task đang mở\nUser: project của tôi là gì", "greeting");
check("ai làm task #42", "task_owner_lookup");

// ─── Caller-required pattern (no callerUserId → fall back) ───
console.log("\n─── no callerUserId → my_tasks/my_role fall back ───");
const noCaller = { source: "chat" as const };
check("task của tôi", "my_tasks:no_caller", noCaller);
check("tôi có quyền gì?", "intent:my_role:no_caller", noCaller);
check("task của tôi hôm nay là gì vậy", "intent:my_tasks_today:no_caller", noCaller);

// ─── Summary ───
console.log(`\n${pass} pass · ${fail} fail (${pass + fail} total)`);
if (fail > 0) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(f));
  process.exit(1);
}
console.log("✅ All pre-classifier tests pass");
