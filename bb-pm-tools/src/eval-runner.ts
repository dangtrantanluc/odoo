#!/usr/bin/env node
// Golden-eval runner — chạy test/golden-eval.json qua runAgent() và assert
// (a) tool đúng được gọi, (b) args match pattern, (c) reply chứa expected
// substring. Mục tiêu: regression-test mỗi khi đổi prompt / LLM / tool list.
//
// Cách chạy:
//   pnpm --filter @openclaw/bb-pm-tools eval
//
// Hoặc chỉ run 1 category:
//   EVAL_FILTER=READ pnpm eval
//   EVAL_FILTER=action-001 pnpm eval     # match by id substring
//
// Output:
//   - Per-case PASS/PARTIAL/FAIL với reason
//   - Summary table: total / pass / fail / per-category
//   - Exit code 0 nếu pass rate >= EVAL_PASS_THRESHOLD (default 0.8)

import "./env";
import * as fs from "fs";
import * as path from "path";
import { runAgent } from "./orchestrator";
import type { AgentContext, AgentToolTrace } from "./types";

type Case = {
  id: string;
  category: "READ" | "ACTION" | "AUTOMATION" | "MISSING" | "END_SESSION";
  question: string;
  expected_mode: string;
  expected_tool: string | null;
  expected_args_pattern: any;
  expected_fields_in_answer: string[];
  notes?: string;
};

type CaseResult = {
  case: Case;
  status: "PASS" | "PARTIAL" | "FAIL" | "ERROR";
  reasons: string[];
  reply: string;
  trace: AgentToolTrace[];
  durationMs: number;
};

const FILTER = process.env.EVAL_FILTER ?? "";
const PASS_THRESHOLD = Number(process.env.EVAL_PASS_THRESHOLD ?? 0.8);
const EVAL_FILE = path.join(__dirname, "..", "test", "golden-eval.json");

// ── pattern matcher ──────────────────────────────────────────────────────
// Strings → regex (auto fallback to literal). Numbers/bools → exact match.
// Objects → recursive subset match (only keys in pattern checked).
// Arrays → if pattern is array, each pattern[i] must match some actual[j].
function matchesPattern(actual: any, pattern: any): { ok: boolean; reason?: string } {
  if (pattern === null || pattern === undefined) return { ok: true };
  if (typeof pattern === "string") {
    const s = String(actual ?? "");
    try {
      // Translate inline flags `(?i)foo` → `new RegExp("foo", "i")` (JS không support inline)
      const m = pattern.match(/^\(\?([imsuxy]+)\)([\s\S]*)$/);
      const re = m ? new RegExp(m[2], m[1]) : new RegExp(pattern);
      if (!re.test(s)) return { ok: false, reason: `regex /${pattern}/ không match "${s.slice(0, 80)}"` };
      return { ok: true };
    } catch {
      if (s !== pattern) return { ok: false, reason: `expected "${pattern}", got "${s.slice(0, 80)}"` };
      return { ok: true };
    }
  }
  if (typeof pattern === "number" || typeof pattern === "boolean") {
    if (actual !== pattern) return { ok: false, reason: `expected ${pattern}, got ${actual}` };
    return { ok: true };
  }
  if (Array.isArray(pattern)) {
    if (!Array.isArray(actual)) return { ok: false, reason: "expected array" };
    for (const want of pattern) {
      const found = actual.some((a) => matchesPattern(a, want).ok);
      if (!found) return { ok: false, reason: `array missing match for ${JSON.stringify(want).slice(0, 60)}` };
    }
    return { ok: true };
  }
  if (typeof pattern === "object") {
    if (!actual || typeof actual !== "object") return { ok: false, reason: "expected object" };
    for (const [k, v] of Object.entries(pattern)) {
      const sub = matchesPattern(actual[k], v);
      if (!sub.ok) return { ok: false, reason: `field "${k}": ${sub.reason}` };
    }
    return { ok: true };
  }
  return { ok: true };
}

// ── runner ───────────────────────────────────────────────────────────────
async function runCase(c: Case): Promise<CaseResult> {
  const ctx: AgentContext = {
    source: "eval",
    correlationId: `eval-${c.id}-${Date.now()}`,
    conversationId: `eval:${c.id}`,
    trace: { toolCalls: [] },
  };

  const t0 = Date.now();
  let reply = "";
  const reasons: string[] = [];

  try {
    reply = await runAgent(c.question, ctx);
  } catch (err: any) {
    return {
      case: c,
      status: "ERROR",
      reasons: [`runAgent threw: ${err?.message ?? err}`],
      reply: "",
      trace: ctx.trace?.toolCalls ?? [],
      durationMs: Date.now() - t0,
    };
  }

  const trace = ctx.trace?.toolCalls ?? [];
  let critFails = 0;
  let critTotal = 0;

  // Criterion 1: expected tool was called (or null = expect no tool)
  critTotal++;
  if (c.expected_tool === null) {
    if (trace.length > 0) {
      reasons.push(`expected NO tool, but ${trace.length} called: ${trace.map((t) => t.name).join(", ")}`);
      critFails++;
    }
  } else {
    const matched = trace.find((t) => t.name === c.expected_tool);
    if (!matched) {
      reasons.push(
        `expected tool "${c.expected_tool}" not called. Actually called: ${trace.map((t) => t.name).join(", ") || "(none)"}`,
      );
      critFails++;
    }
  }

  // Criterion 2: at least 1 tool call's args match expected_args_pattern
  if (c.expected_args_pattern) {
    critTotal++;
    const anyMatch = trace.some((t) => matchesPattern(t.args, c.expected_args_pattern).ok);
    if (!anyMatch) {
      const example = trace[0] ? JSON.stringify(trace[0].args).slice(0, 120) : "(no calls)";
      reasons.push(
        `args pattern not matched in any call. Pattern: ${JSON.stringify(c.expected_args_pattern).slice(0, 120)}. Sample actual: ${example}`,
      );
      critFails++;
    }
  }

  // Criterion 3: reply contains all expected_fields_in_answer
  if (c.expected_fields_in_answer && c.expected_fields_in_answer.length) {
    critTotal++;
    const lower = reply.toLowerCase();
    const missing = c.expected_fields_in_answer.filter((f) => !lower.includes(f.toLowerCase()));
    if (missing.length) {
      reasons.push(`reply missing substrings: ${missing.join(", ")}`);
      critFails++;
    }
  }

  let status: CaseResult["status"];
  if (critFails === 0) status = "PASS";
  else if (critFails < critTotal) status = "PARTIAL";
  else status = "FAIL";

  return { case: c, status, reasons, reply, trace, durationMs: Date.now() - t0 };
}

function fmtTrace(trace: AgentToolTrace[]): string {
  if (!trace.length) return "(no tool calls)";
  return trace
    .map((t) => `${t.name}(${JSON.stringify(t.args).slice(0, 60)})${t.error ? ` ❌${t.error.slice(0, 40)}` : ""}`)
    .join(" → ");
}

function statusIcon(s: CaseResult["status"]): string {
  return { PASS: "✓", PARTIAL: "≈", FAIL: "✗", ERROR: "💥" }[s];
}

(async () => {
  if (!fs.existsSync(EVAL_FILE)) {
    console.error(`Eval file không tồn tại: ${EVAL_FILE}`);
    process.exit(2);
  }

  const data = JSON.parse(fs.readFileSync(EVAL_FILE, "utf-8"));
  let cases: Case[] = data.cases ?? [];
  if (FILTER) {
    // Comma-separated supports: "read-001,action-001,END_SESSION"
    const filters = FILTER.split(",").map((s) => s.trim()).filter(Boolean);
    cases = cases.filter((c) =>
      filters.some((f) => c.id === f || c.id.includes(f) || c.category === f),
    );
    if (cases.length === 0) {
      console.error(`Filter "${FILTER}" không match case nào.`);
      process.exit(2);
    }
  }

  console.log(`\n=== Golden Eval — ${data.version ?? "?"} ===`);
  console.log(`File:   ${EVAL_FILE}`);
  console.log(`Cases:  ${cases.length}${FILTER ? ` (filter: ${FILTER})` : ""}`);
  console.log(`Threshold: ${(PASS_THRESHOLD * 100).toFixed(0)}% pass rate\n`);

  const results: CaseResult[] = [];
  for (const c of cases) {
    process.stdout.write(`[${c.id}] ${c.question.slice(0, 70)}${c.question.length > 70 ? "…" : ""}  `);
    const r = await runCase(c);
    results.push(r);
    process.stdout.write(`${statusIcon(r.status)} ${r.status} (${r.durationMs}ms)\n`);
    if (r.status !== "PASS") {
      for (const reason of r.reasons) console.log(`    · ${reason}`);
      console.log(`    trace: ${fmtTrace(r.trace)}`);
      console.log(`    reply: ${r.reply.slice(0, 160).replace(/\n/g, " ")}`);
    }
  }

  // Summary
  console.log("\n=== Summary ===");
  const counts = { PASS: 0, PARTIAL: 0, FAIL: 0, ERROR: 0 };
  for (const r of results) counts[r.status]++;
  console.log(`Total:    ${results.length}`);
  console.log(`✓ Pass:    ${counts.PASS}`);
  console.log(`≈ Partial: ${counts.PARTIAL}`);
  console.log(`✗ Fail:    ${counts.FAIL}`);
  console.log(`💥 Error:  ${counts.ERROR}`);

  // Per-category breakdown
  const byCategory: Record<string, { pass: number; total: number }> = {};
  for (const r of results) {
    const cat = r.case.category;
    byCategory[cat] = byCategory[cat] ?? { pass: 0, total: 0 };
    byCategory[cat].total++;
    if (r.status === "PASS") byCategory[cat].pass++;
  }
  console.log("\nPer-category:");
  for (const [cat, s] of Object.entries(byCategory)) {
    const pct = ((s.pass / s.total) * 100).toFixed(0);
    console.log(`  ${cat.padEnd(14)} ${s.pass}/${s.total} (${pct}%)`);
  }

  const passRate = counts.PASS / results.length;
  console.log(`\nOverall pass rate: ${(passRate * 100).toFixed(1)}%`);
  if (passRate < PASS_THRESHOLD) {
    console.log(`❌ Below threshold ${(PASS_THRESHOLD * 100).toFixed(0)}%`);
    process.exit(1);
  }
  console.log("✅ Meets threshold");
})().catch((err) => {
  console.error("Eval crashed:", err);
  process.exit(2);
});
