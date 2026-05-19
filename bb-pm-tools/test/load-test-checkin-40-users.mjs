// Stateful check-in load test — 40 synthetic users across a 10-minute window.
// Run:
//   node test/load-test-checkin-40-users.mjs
// Optional:
//   WINDOW_MS=600000 GATEWAY_URL=http://localhost:18789 node test/load-test-checkin-40-users.mjs

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:18789";
const AGENT_RUN = `${GATEWAY_URL}/api/plugins/bb-pm/agent/run`;
const USERS = Number(process.env.USERS ?? 40);
const WINDOW_MS = Number(process.env.WINDOW_MS ?? 10 * 60 * 1000);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 240_000);

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

function summarize(values) {
  return {
    count: values.length,
    min: values.length ? Math.min(...values) : 0,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: values.length ? Math.max(...values) : 0,
    avg: values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0,
  };
}

async function post(body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(AGENT_RUN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, ms: Date.now() - started, json };
  } catch (err) {
    return { ok: false, status: 0, ms: Date.now() - started, error: err?.message ?? String(err), json: {} };
  } finally {
    clearTimeout(timer);
  }
}

function user(i) {
  return {
    idx: i,
    externalId: `load-user-${i}`,
    threadId: `load-thread-${i}`,
    conversationId: `gapo:load-thread-${i}`,
  };
}

function ctx(u, suffix, text, extraMetadata = {}) {
  return {
    source: "chat",
    conversationId: u.conversationId,
    externalId: u.externalId,
    correlationId: `checkin-load-${u.idx}-${suffix}-${Date.now()}`,
    text,
    metadata: { threadId: u.threadId, messageId: `${suffix}-${u.idx}`, ...extraMetadata },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const runStartedAt = new Date();
  const users = Array.from({ length: USERS }, (_, i) => user(i + 1));

  // Phase 1: send all project-selection prompts concurrently.
  const starts = await Promise.all(users.map((u) => post(ctx(u, "start", "/checkin"))));

  // Deterministic spread across the configured 10-minute window.
  const step = USERS > 1 ? WINDOW_MS / (USERS - 1) : 0;
  const flows = await Promise.all(users.map(async (u, idx) => {
    const plannedOffsetMs = Math.round(idx * step);
    await sleep(plannedOffsetMs);
    const selected = await post(
      ctx(u, "project", "BBSW x MTL Logistics Project", { payload: "SELECT_PROJECT:1" }),
    );
    const updated = await post(
      ctx(u, "update", `Hôm nay tôi hoàn thành mock checkin task ${u.idx}, làm 2h.`),
    );
    return { user: u.idx, plannedOffsetMs, selected, updated };
  }));

  const startLats = starts.map((r) => r.ms);
  const selectLats = flows.map((f) => f.selected.ms);
  const updateLats = flows.map((f) => f.updated.ms);
  const updateOk = flows.filter((f) => f.updated.ok);
  const completed = flows.filter((f) => f.updated.json?.fastPath === "checkin:completed");
  const failures = [
    ...starts.map((r, i) => ({ phase: "start", user: i + 1, ...r })).filter((r) => !r.ok),
    ...flows.map((f) => ({ phase: "select", user: f.user, ...f.selected })).filter((r) => !r.ok),
    ...flows.map((f) => ({ phase: "update", user: f.user, ...f.updated })).filter((r) => !r.ok),
  ];

  const result = {
    meta: {
      startedAt: runStartedAt.toISOString(),
      users: USERS,
      configuredWindowMs: WINDOW_MS,
      gatewayUrl: GATEWAY_URL,
    },
    summary: {
      startSuccess: starts.filter((r) => r.ok).length,
      selectSuccess: flows.filter((f) => f.selected.ok).length,
      updateSuccess: updateOk.length,
      completedCount: completed.length,
      failureCount: failures.length,
      elapsedMs: Date.now() - runStartedAt.getTime(),
    },
    latencyMs: {
      startProjectPrompt: summarize(startLats),
      selectProject: summarize(selectLats),
      submitUpdate: summarize(updateLats),
    },
    failures,
    flows: flows.map((f) => ({
      user: f.user,
      plannedOffsetMs: f.plannedOffsetMs,
      selectMs: f.selected.ms,
      selectPattern: f.selected.json?.fastPath ?? null,
      updateMs: f.updated.ms,
      updatePattern: f.updated.json?.fastPath ?? null,
      updateStatus: f.updated.status,
    })),
  };
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
