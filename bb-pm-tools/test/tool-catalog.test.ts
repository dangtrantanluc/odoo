import assert from "node:assert/strict";
import { tools, toolsByName } from "../src/tools/catalog";

assert.ok(tools.length > 0, "catalog should not be empty");
assert.equal(toolsByName.size, tools.length, "tool names should stay unique");
for (const name of ["report.query", "workflow.run", "task.create", "message.send"]) {
  assert.ok(toolsByName.has(name), `missing canonical tool ${name}`);
}
console.log("tool-catalog tests passed");
