import assert from "node:assert/strict";
import { buildOutboundPlan, buildQuickReplyFallbackText } from "../src/index";

const quick = {
  type: "quick_replies" as const,
  text: "Bạn đang làm project nào?",
  metadata: {
    options: [
      { title: "Project A", payload: "SELECT_PROJECT:1" },
      { title: "Project B", payload: "SELECT_PROJECT:2" },
    ],
  },
};

const quickPlan = buildOutboundPlan("plain duplicate", quick);
assert.equal(quickPlan.kind, "quick_replies");
assert.equal(quickPlan.body, quick);
assert.equal(quickPlan.text, quick.text);

const textPlan = buildOutboundPlan("hello");
assert.equal(textPlan.kind, "text");
assert.equal(textPlan.body, undefined);

const fallback = buildQuickReplyFallbackText(quick);
assert.match(fallback, /trả lời bằng số/i);
assert.match(fallback, /1\. Project A/);

const alreadyFallback = {
  ...quick,
  text: "Bạn đang làm project nào?\nNếu không thấy nút, trả lời bằng số:\n1. Project A",
};
assert.equal(buildQuickReplyFallbackText(alreadyFallback), alreadyFallback.text);

console.log("outbound tests passed");
