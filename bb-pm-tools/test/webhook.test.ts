import assert from "node:assert/strict";
import { isSlashCommand } from "../src/webhook";

assert.equal(isSlashCommand("/checkin"), true);
assert.equal(isSlashCommand(" /projects"), true);
assert.equal(isSlashCommand("/mytasks now"), true);
assert.equal(isSlashCommand("hello"), false);
assert.equal(isSlashCommand("not/a/command"), false);

console.log("webhook tests passed");
