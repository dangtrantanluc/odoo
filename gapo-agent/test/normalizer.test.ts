import assert from "node:assert/strict";
import { normalizeGapoPayload } from "../src/normalizer";

const direct = normalizeGapoPayload({
  text: " test ",
  conversationId: "gapo:123",
  sender: { id: "456", name: "Tester" },
});
assert.equal(direct.text, "test");
assert.equal(direct.shouldProcess, true);
assert.equal(direct.conversationId, "gapo:123");
assert.equal(direct.threadId, "123");
assert.equal(direct.externalId, "456");
assert.equal(direct.senderName, "Tester");
assert.equal(direct.correlationId, "gapo-123");

const messageShape = normalizeGapoPayload({
  event: "message_created",
  from_user_id: 1193582742,
  to_bot_id: 5828367940457829000,
  message: {
    id: "3",
    text: "hello",
    type: "text",
    thread: { id: 789 },
    sender: { id: 321, display_name: "Display Name" },
  },
});
assert.equal(messageShape.text, "hello");
assert.equal(messageShape.conversationId, "gapo:789");
assert.equal(messageShape.externalId, "1193582742");
assert.equal(messageShape.fromUserId, "1193582742");
assert.equal(messageShape.toBotId, "5828367940457829000");
assert.equal(messageShape.messageId, "3");
assert.equal(messageShape.messageType, "text");
assert.equal(messageShape.shouldProcess, true);
assert.equal(messageShape.senderName, "Display Name");

const dataShape = normalizeGapoPayload({
  data: {
    text: "from data",
    conversationId: "collab:7001",
  },
  senderId: "999",
});
assert.equal(dataShape.text, "from data");
assert.equal(dataShape.conversationId, "gapo:collab:7001");
assert.equal(dataShape.threadId, "collab:7001");
assert.equal(dataShape.externalId, "999");

const threadCreated = normalizeGapoPayload({
  event: "thread_created",
  thread_id: 1664252906628,
  from_user_id: 1147591,
  to_bot_id: 5828463533626526000,
});
assert.equal(threadCreated.shouldProcess, false);
assert.equal(threadCreated.text, null);
assert.equal(threadCreated.externalId, "1147591");

const quickReply = normalizeGapoPayload({
  event: "message_created",
  thread_id: 1663642842110,
  from_user_id: 1147591,
  message: { id: "100", text: "Option 1", type: "quick_reply", payload: "TASK:42" },
});
assert.equal(quickReply.messageType, "quick_reply");
assert.equal(quickReply.payload, "TASK:42");

const image = normalizeGapoPayload({
  event: "message_created",
  thread_id: 1664241127733,
  from_user_id: 1193582742,
  message: { id: "6", text: "caption", type: "image" },
});
assert.equal(image.shouldProcess, false);

const groupIgnored = normalizeGapoPayload({
  event: "message_created",
  thread_id: 7001,
  to_bot_id: 99,
  message: {
    id: "7",
    text: "mọi người update nhé",
    type: "text",
    thread: { id: 7001, type: "group" },
    metadata: { mentions: [] },
  },
});
assert.equal(groupIgnored.isGroupMessage, true);
assert.equal(groupIgnored.shouldProcess, false);

const groupMentioned = normalizeGapoPayload({
  event: "message_created",
  thread_id: 7001,
  to_bot_id: 99,
  message: {
    id: "8",
    text: "@bot báo cáo giúp",
    type: "text",
    thread: { id: 7001, type: "group" },
    metadata: { mentions: [{ target: 99, length: 0, offset: 0 }] },
  },
});
assert.equal(groupMentioned.shouldProcess, true);

console.log("normalizer tests passed");
