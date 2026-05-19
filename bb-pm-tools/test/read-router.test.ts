import assert from "node:assert/strict";
import { classifyReadTurn, tryTextToSqlRead } from "../src/read-router";
import { toolsByName } from "../src/tools";

assert.equal(classifyReadTurn("ai đang nhận nhiều task nhất"), "read");
assert.equal(classifyReadTurn("người nào có nhiều task quá hạn nhất"), "read");
assert.equal(classifyReadTurn("dự án nào còn nhiều blocker"), "read");
assert.equal(classifyReadTurn("tuần này có bao nhiêu task done"), "read");
assert.equal(classifyReadTurn("workload team software thế nào"), "read");
assert.equal(classifyReadTurn("task nào sắp đến hạn"), "read");
assert.equal(classifyReadTurn("tạo task mới cho Thảo"), "action");
assert.equal(classifyReadTurn("đổi deadline task X sang mai"), "action");
assert.equal(classifyReadTurn("assign task X cho Kỳ"), "action");
assert.equal(classifyReadTurn("Đình Thanh"), "ambiguous");
assert.equal(classifyReadTurn("workload"), "ambiguous");
assert.equal(classifyReadTurn("project MTL"), "ambiguous");

const reportQuery = toolsByName.get("report.query")!;
const origHandler = reportQuery.handler;
(async () => {
  (reportQuery as any).handler = async () => ({ rows: [{ name: "A", total: 3 }], rowCount: 1, _translated: true });
  assert.equal((await tryTextToSqlRead("ai đang nhận nhiều task nhất"))?.pattern, "read:text_to_sql");
  (reportQuery as any).handler = async () => [{ fullName: "A", openTasks: 3 }];
  assert.equal((await tryTextToSqlRead("ai đang nhận nhiều task nhất"))?.pattern, "read:keyword_fallback");
  assert.equal((await tryTextToSqlRead("Đình Thanh"))?.pattern, "read:ambiguous_clarified");
  assert.equal(await tryTextToSqlRead("tạo task mới cho Thảo"), null);
  (reportQuery as any).handler = origHandler;
  console.log("read-router tests passed");
})();
