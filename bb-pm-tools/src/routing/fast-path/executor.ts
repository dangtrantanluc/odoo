import { toolsByName } from "../../tools";
import type { AgentContext } from "../../shared/types";
import type { FastPathResult } from "./index";

// ── Fast path executor ────────────────────────────────────────────────────
/**
 * Execute fast path result. Returns string reply hoặc throws nếu tool fail.
 */
// F3 fix (2026-05-07) — Circuit breaker per pattern.
// Nếu 1 pattern fail ≥ 3 lần trong 60s → disable 5 phút → fall through LLM.
// Tránh case backend bug làm fast-path liên tục throw → cascade log spam.
// Reset window 60s rolling.
const CB_FAIL_THRESHOLD = Number(process.env.FASTPATH_CB_THRESHOLD ?? 3);
const CB_WINDOW_MS = Number(process.env.FASTPATH_CB_WINDOW_MS ?? 60_000);
const CB_DISABLE_MS = Number(process.env.FASTPATH_CB_DISABLE_MS ?? 5 * 60_000);
const cbFails = new Map<string, number[]>(); // pattern → array of fail timestamps
const cbDisabled = new Map<string, number>(); // pattern → disable-until timestamp

function isCircuitOpen(pattern: string): boolean {
  const until = cbDisabled.get(pattern);
  if (!until) return false;
  if (Date.now() > until) {
    cbDisabled.delete(pattern);
    cbFails.delete(pattern);
    return false;
  }
  return true;
}

function recordFail(pattern: string): void {
  const now = Date.now();
  const arr = (cbFails.get(pattern) ?? []).filter((t) => now - t < CB_WINDOW_MS);
  arr.push(now);
  cbFails.set(pattern, arr);
  if (arr.length >= CB_FAIL_THRESHOLD) {
    cbDisabled.set(pattern, now + CB_DISABLE_MS);
    console.warn(
      `[fast-path] CIRCUIT OPEN pattern=${pattern} fails=${arr.length}/${CB_WINDOW_MS / 1000}s — disable ${CB_DISABLE_MS / 1000}s`,
    );
  }
}

export async function executeFastPath(
  fp: FastPathResult,
  ctx: AgentContext,
): Promise<string> {
  // Direct reply (cheapest path — no tool, no DB, no logging needed)
  if (fp.directReply !== undefined) return fp.directReply;

  if (!fp.toolName) throw new Error("FastPath missing toolName + directReply");

  // Circuit breaker check — nếu pattern đang disabled, throw để fall through LLM
  if (isCircuitOpen(fp.pattern)) {
    throw new Error(`fast-path circuit open: ${fp.pattern}`);
  }

  const tool = toolsByName.get(fp.toolName);
  if (!tool) throw new Error(`FastPath backing tool ${fp.toolName} not found`);

  const t0 = Date.now();
  let result: any;
  try {
    result = await tool.handler(fp.toolArgs ?? {});
  } catch (err: any) {
    const dur = Date.now() - t0;
    recordFail(fp.pattern);
    console.warn(
      `[fast-path] FAIL pattern=${fp.pattern} tool=${fp.toolName} dur=${dur}ms err="${(err?.message ?? err).slice(0, 120)}"`,
    );
    throw err;
  }

  // Success log — include row count khi available (giúp distinguish "no data"
  // vs "data missing" debug). "No data" KHÔNG count fail (case bình thường).
  const dur = Date.now() - t0;
  const rowCount = result?.rows?.length ?? result?.tasks?.length ?? result?.projects?.length ?? null;
  console.log(
    `[fast-path] OK pattern=${fp.pattern} tool=${fp.toolName} dur=${dur}ms rows=${rowCount ?? "?"}`,
  );

  if (!fp.formatReply) {
    return JSON.stringify(result).slice(0, 1000);
  }
  return fp.formatReply(result, ctx);
}

/** Test/debug helper — clear circuit breaker state (used by tests). */
export function _resetFastPathCircuit(): void {
  cbFails.clear();
  cbDisabled.clear();
}
