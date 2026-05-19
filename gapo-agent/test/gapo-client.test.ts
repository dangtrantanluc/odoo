import assert from "node:assert/strict";
import {
  buildGapoRequest,
  buildQuickRepliesBody,
  buildTextBody,
  parseConversationTarget,
} from "../src/gapo-client";

assert.deepEqual(parseConversationTarget("123"), { thread_id: "123" });
assert.deepEqual(parseConversationTarget("gapo:123"), { thread_id: "123" });
assert.deepEqual(parseConversationTarget("dm:456"), { receiver_id: "456" });
assert.deepEqual(parseConversationTarget("collab:789"), { collab_id: "789" });

const textReq = buildGapoRequest("gapo:123", buildTextBody("hello"));
assert.equal(textReq?.thread_id, "123");
assert.deepEqual(textReq?.body, { type: "text", text: "hello", is_markdown_text: true });

const quickReq = buildGapoRequest(
  "dm:456",
  buildQuickRepliesBody("Chon task", [{ title: "Task A", payload: "SELECT_TASK:1" }]),
);
assert.equal(quickReq?.receiver_id, "456");
assert.deepEqual(quickReq?.body, {
  type: "quick_replies",
  text: "Chon task",
  metadata: { options: [{ title: "Task A", payload: "SELECT_TASK:1" }] },
});

for (const req of [textReq, quickReq]) {
  const targets = ["thread_id", "receiver_id", "collab_id"].filter((key) => key in (req ?? {}));
  assert.equal(targets.length, 1);
}

console.log("gapo client tests passed");
