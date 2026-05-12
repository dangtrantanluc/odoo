// Formatter unit tests — run với `tsx test/formatter.test.ts`.
// Không dùng vitest/jest để tránh thêm dep. Plain assertion + exit code 0/1.
//
// Cover:
//   - classifyTemplate keyword matching (8 templates + edge cases)
//   - shouldSkipFormatter (clean / markdown / DB-leak / JSON-like / oversized)
//   - USER_IS_ACK_RE boundary (real ack vs greeting vs question vs ack-with-suffix)
//   - formatResponse end-to-end (template / skip / wrong-marker strip)

import {
  classifyTemplate,
  shouldSkipFormatter,
  formatResponse,
  templates,
  type TemplateKey,
} from "../src/formatter";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function expect(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
  } else {
    fail++;
    failures.push(`✗ ${label}\n    actual:   ${JSON.stringify(actual)}\n    expected: ${JSON.stringify(expected)}`);
  }
}

function expectTrue(label: string, actual: boolean) {
  expect(label, actual, true);
}
function expectFalse(label: string, actual: boolean) {
  expect(label, actual, false);
}

// ─── classifyTemplate ──────────────────────────────────────────────────

console.log("─── classifyTemplate ───");

const classifyCases: Array<{ raw: string; expectKey: TemplateKey | null }> = [
  // missingSalary
  { raw: "Hệ thống không có rate hourly cho user", expectKey: "missingSalary" },
  { raw: "Chưa cấu hình lương cho task này", expectKey: "missingSalary" },
  // noTask
  { raw: "Hiện tại không có task nào của bạn", expectKey: "noTask" },
  { raw: "0 task", expectKey: "noTask" },
  // permissionDenied
  { raw: "Bạn cần quyền MANAGER. Hiện là MEMBER, không thể duyệt", expectKey: "permissionDenied" },
  { raw: "MEMBER không thể tạo project", expectKey: "permissionDenied" },
  // endSession marker
  { raw: "OK [END_SESSION]", expectKey: "endSession" },
  { raw: "[end_session]", expectKey: "endSession" },
  // toolError
  { raw: "Error: ECONNREFUSED while calling bb-pm API", expectKey: "toolError" },
  { raw: "[ERROR] prisma error: connection lost", expectKey: "toolError" },
  // No match
  { raw: "Bạn đang ở project Test1", expectKey: null },
  { raw: "MEMBER. Cập nhật task", expectKey: null },
  { raw: "", expectKey: null },
];

for (const c of classifyCases) {
  const r = classifyTemplate(c.raw);
  expect(`classify: ${JSON.stringify(c.raw.slice(0, 40))}`, r?.key ?? null, c.expectKey);
}

// ─── shouldSkipFormatter ──────────────────────────────────────────────

console.log("\n─── shouldSkipFormatter ───");

// Clean → SKIP=true
expectTrue("skip: short clean", shouldSkipFormatter("MEMBER. Cập nhật task của mình."));
expectTrue("skip: digest fact", shouldSkipFormatter("✓ Digest đã gửi. 3 dự án · 18 task mở."));
expectTrue("skip: tiny", shouldSkipFormatter("4 task quá hạn"));

// Has markdown → don't skip
expectFalse("no-skip: markdown bold", shouldSkipFormatter("**MEMBER** trong hệ thống"));
expectFalse("no-skip: markdown header", shouldSkipFormatter("## Heading\nbody"));
expectFalse("no-skip: backtick", shouldSkipFormatter("Code: `console.log` here"));

// JSON-like → don't skip
expectFalse("no-skip: JSON object", shouldSkipFormatter('{"id": 1, "name": "x"}'));
expectFalse("no-skip: JSON array", shouldSkipFormatter("[1, 2, 3]"));

// DB leak → don't skip
expectFalse("no-skip: user_id leak", shouldSkipFormatter("Bạn có user_id: 24, company_id: 1"));
expectFalse("no-skip: SQL leak", shouldSkipFormatter("SELECT * FROM users WHERE id = 1"));
expectFalse("no-skip: prisma leak", shouldSkipFormatter("prisma.user.findMany returned 5 rows"));
expectFalse("no-skip: stack trace", shouldSkipFormatter("Stack at /home/.../node_modules"));

// Oversized → don't skip
expectFalse("no-skip: > 350 chars", shouldSkipFormatter("a".repeat(400)));

// Empty → skip
expectTrue("skip: empty", shouldSkipFormatter(""));

// ─── formatResponse end-to-end ────────────────────────────────────────

console.log("\n─── formatResponse ───");

(async () => {
  // 1. cli/eval source → pass through always
  const cli = await formatResponse("**bold raw**", { source: "cli" }, "anything");
  expect("cli pass-through", cli, "**bold raw**");

  // 2. clean text + chat → pass through
  const clean = await formatResponse("MEMBER. Cập nhật task.", { source: "chat" }, "tôi có quyền gì?");
  expect("clean chat pass-through", clean, "MEMBER. Cập nhật task.");

  // 3. template match — noTask
  const noTask = await formatResponse(
    "Hiện không có task nào của bạn",
    { source: "chat" },
    "task của tôi?",
  );
  expectTrue("noTask template applied", noTask.includes("Mình chưa thấy task"));

  // 4. wrong END_SESSION strip — user said "hi" (greeting)
  const wrongEnd = await formatResponse(
    "Chào bạn! [END_SESSION]",
    { source: "chat" },
    "hi",
  );
  expectFalse("hi: marker stripped", wrongEnd.includes("[END_SESSION]"));
  expectTrue("hi: real reply preserved", wrongEnd.includes("Chào bạn"));

  // 5. wrong END_SESSION strip — user asked real question
  const questionEnd = await formatResponse(
    "Bạn ở project Test1. [END_SESSION]",
    { source: "chat" },
    "tôi đang làm project gì?",
  );
  expectFalse("question: marker stripped", questionEnd.includes("[END_SESSION]"));
  expectTrue("question: real reply preserved", questionEnd.includes("Test1"));

  // 6. real ack + END_SESSION → keep marker (template endSession used)
  const realAck = await formatResponse("OK [END_SESSION]", { source: "chat" }, "ok bạn");
  expectTrue("real ack: marker preserved via template", realAck.includes("[END_SESSION]"));
  expectTrue("real ack: friendly template", realAck.includes("OK bạn"));

  // 7. real ack other variants
  for (const userAck of ["ok", "cảm ơn", "thanks", "tks", "👍"]) {
    const r = await formatResponse(`Reply [END_SESSION]`, { source: "chat" }, userAck);
    expectTrue(`ack "${userAck}" preserves marker`, r.includes("[END_SESSION]"));
  }

  // 8. permissionDenied with vars extraction
  const perm = await formatResponse(
    "Bạn cần MANAGER. Hiện bạn là MEMBER không thể tạo project",
    { source: "chat" },
    "tạo project mới",
  );
  expectTrue("permission template MANAGER", perm.includes("MANAGER"));
  expectTrue("permission template MEMBER", perm.includes("MEMBER"));

  // 9. tool error masked
  const err = await formatResponse(
    "Error: ECONNREFUSED at /home/.../node_modules/prisma",
    { source: "chat" },
    "task quá hạn?",
  );
  expectFalse("toolError: stack hidden", err.includes("ECONNREFUSED"));
  expectTrue("toolError: friendly message", err.includes("lỗi tạm thời"));

  // ─── Summary ──────────────────────────────────────────────────────────
  console.log(`\n${pass} pass · ${fail} fail (${pass + fail} total)`);
  if (fail > 0) {
    console.log("\nFailures:");
    failures.forEach((f) => console.log(f));
    process.exit(1);
  }
  console.log("✅ All formatter tests pass");
})();
