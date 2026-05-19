import assert from "node:assert/strict";
import { normalizeLooseText, normalizeVietnameseText } from "../src/shared/text";

assert.equal(normalizeVietnameseText("  Dự Án Đặng  "), "du an dang");
assert.equal(normalizeLooseText("Task của tôi, hôm nay?"), "task cua toi hom nay");
console.log("shared-text tests passed");
