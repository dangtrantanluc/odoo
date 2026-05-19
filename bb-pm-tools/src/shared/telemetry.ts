import type { AgentLlmTrace, AgentToolTrace, AgentTimingTrace } from "./types";

type RunMode =
  | "fast_path"
  | "action_router"
  | "text_to_sql"
  | "keyword_fallback"
  | "ambiguous_read"
  | "no_match"
  | "llm"
  | "dedup"
  | "rate_limited"
  | "overloaded"
  | "error";

export type AgentRunSample = {
  requestId: string;
  source: string;
  mode: RunMode;
  totalMs: number;
  replyBytes?: number;
  queueWaitMs?: number;
  callerResolveMs?: number;
  memoryRecallMs?: number;
  schemaDocMs?: number;
  fastPathMs?: number;
  llmCalls: AgentLlmTrace[];
  toolCalls: AgentToolTrace[];
  toolCount: number;
  toolMsTotal: number;
  timestamp: string;
  error?: string;
};

type Aggregate = {
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
};

const MAX_SAMPLES = Number(process.env.BB_PM_TELEMETRY_MAX_SAMPLES ?? 50);
const samples: AgentRunSample[] = [];

function pushSample(sample: AgentRunSample) {
  samples.push(sample);
  while (samples.length > MAX_SAMPLES) samples.shift();
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx];
}

function aggregate(values: number[]): Aggregate {
  if (values.length === 0) {
    return { count: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
  }
  return {
    count: values.length,
    p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95),
    maxMs: Math.max(...values),
  };
}

export function recordAgentRunSample(args: {
  requestId: string;
  source: string | undefined;
  mode: RunMode;
  totalMs: number;
  replyBytes?: number;
  timings?: AgentTimingTrace;
  toolCalls?: AgentToolTrace[];
  error?: string;
}) {
  const toolCalls = args.toolCalls ?? [];
  const toolMsTotal = toolCalls.reduce((sum, t) => sum + (t.durationMs ?? 0), 0);
  pushSample({
    requestId: args.requestId,
    source: args.source ?? "unknown",
    mode: args.mode,
    totalMs: args.totalMs,
    replyBytes: args.replyBytes,
    queueWaitMs: args.timings?.queueWaitMs,
    callerResolveMs: args.timings?.callerResolveMs,
    memoryRecallMs: args.timings?.memoryRecallMs,
    schemaDocMs: args.timings?.schemaDocMs,
    fastPathMs: args.timings?.fastPathMs,
    llmCalls: args.timings?.llmCalls ?? [],
    toolCalls,
    toolCount: toolCalls.length,
    toolMsTotal,
    timestamp: new Date().toISOString(),
    error: args.error,
  });
}

export function getTelemetrySnapshot() {
  const totalMs = samples.map((s) => s.totalMs);
  const queueWaitMs = samples.map((s) => s.queueWaitMs ?? 0).filter((x) => x > 0);
  const fastPathMs = samples.map((s) => s.fastPathMs ?? 0).filter((x) => x > 0);
  const llmCallMs = samples.flatMap((s) => s.llmCalls.map((c) => c.latencyMs));

  const byMode = Object.fromEntries(
    Array.from(new Set(samples.map((s) => s.mode))).map((mode) => {
      const modeValues = samples.filter((s) => s.mode === mode).map((s) => s.totalMs);
      return [mode, aggregate(modeValues)];
    }),
  );

  return {
    sampleSize: samples.length,
    totalMs: aggregate(totalMs),
    queueWaitMs: aggregate(queueWaitMs),
    fastPathMs: aggregate(fastPathMs),
    llmCallMs: aggregate(llmCallMs),
    byMode,
    recent: samples.slice(-10),
  };
}
