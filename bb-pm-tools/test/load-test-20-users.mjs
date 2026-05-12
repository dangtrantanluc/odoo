// Load test — 20 concurrent users, mixed query patterns.
// Run: node test/load-test-20-users.mjs
//
// Mục tiêu:
//   - Đo latency p50/p95/p99 cho từng tier (slash / fast-path / LLM)
//   - Xác minh concurrency limiter (Sprint 8) chịu được peak burst
//   - Detect rate-limit hit / 503 agent_overloaded / formatter timeout
//   - Verify dedup không nhầm requests từ user khác (unique cid mỗi user)
//
// Output: JSON metrics → stdout (parse vào test.md)

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:18789";
const AGENT_RUN = `${GATEWAY_URL}/api/plugins/bb-pm/agent/run`;
const METRICS = `${GATEWAY_URL}/api/plugins/bb-pm/agent/metrics`;
const HEALTH = `${GATEWAY_URL}/api/plugins/bb-pm/health`;

// 20 user scenarios — mix realistic patterns
const SCENARIOS = [
  // 8 slash commands (40% — power user shortcuts, instant)
  { user: 1, text: "/help", expectTier: "slash" },
  { user: 2, text: "/digest", expectTier: "slash" },
  { user: 3, text: "/mytasks", expectTier: "slash" },
  { user: 4, text: "/overdue", expectTier: "slash" },
  { user: 5, text: "/projects", expectTier: "slash" },
  { user: 6, text: "/role", expectTier: "slash" },
  { user: 7, text: "/blocked", expectTier: "slash" },
  { user: 8, text: "/stale", expectTier: "slash" },

  // 6 Vietnamese fast-path (30% — typical user gõ tự nhiên, fast-path catch)
  { user: 9, text: "task quá hạn?", expectTier: "fastpath" },
  { user: 10, text: "tôi có quyền gì?", expectTier: "fastpath" },
  { user: 11, text: "có dự án nào active?", expectTier: "fastpath" },
  { user: 12, text: "task của tôi", expectTier: "fastpath" },
  { user: 13, text: "blocker", expectTier: "fastpath" },
  { user: 14, text: "task lâu chưa update", expectTier: "fastpath" },

  // 3 end_session (15% — user đóng phiên)
  { user: 15, text: "ok cảm ơn", expectTier: "end_session" },
  { user: 16, text: "thanks", expectTier: "end_session" },
  { user: 17, text: "👍", expectTier: "end_session" },

  // 3 real LLM (15% — câu Qwen phải xử lý, slow)
  { user: 18, text: "tóm tắt tình hình project Test1", expectTier: "llm" },
  { user: 19, text: "ai đang làm task #42", expectTier: "llm" },
  { user: 20, text: "list user nào department AI", expectTier: "llm" },
];

const TIMEOUT_MS = 240_000; // 4 min — Qwen có thể chậm

async function fetchWithTimeout(url, opts = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function runScenario(scenario) {
  const t0 = Date.now();
  const cid = `gapo:loadtest-${scenario.user}-${Date.now()}`;
  const body = {
    text: scenario.text,
    source: "chat",
    conversationId: cid,
    correlationId: `loadtest-${scenario.user}-${Date.now()}`,
  };

  try {
    const res = await fetchWithTimeout(AGENT_RUN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const dur = Date.now() - t0;
    const status = res.status;
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = { error: "non-json response" };
    }
    return {
      user: scenario.user,
      text: scenario.text,
      expectTier: scenario.expectTier,
      status,
      latencyMs: dur,
      reply: typeof json?.reply === "string" ? json.reply.slice(0, 300) : null,
      replyLen: typeof json?.reply === "string" ? json.reply.length : 0,
      error: json?.error ?? null,
      dedup: json?.dedup ?? false,
    };
  } catch (err) {
    return {
      user: scenario.user,
      text: scenario.text,
      expectTier: scenario.expectTier,
      status: 0,
      latencyMs: Date.now() - t0,
      reply: null,
      replyLen: 0,
      error: err.message ?? String(err),
      dedup: false,
    };
  }
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function snapshotMetrics() {
  try {
    const r = await fetch(METRICS);
    return await r.json();
  } catch (e) {
    return { error: e.message };
  }
}

async function snapshotHealth() {
  try {
    const r = await fetch(HEALTH);
    return await r.json();
  } catch (e) {
    return { error: e.message };
  }
}

async function main() {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`Load Test — 20 concurrent users, mixed pattern`);
  console.log(`Started:   ${new Date().toISOString()}`);
  console.log(`Gateway:   ${GATEWAY_URL}`);
  console.log(`Scenarios: ${SCENARIOS.length}`);
  console.log(`${"=".repeat(70)}\n`);

  // Pre-test snapshot
  const healthBefore = await snapshotHealth();
  const metricsBefore = await snapshotMetrics();
  console.log(`Pre-test health: ${JSON.stringify(healthBefore.checks ?? healthBefore, null, 0)}`);
  console.log(`Pre-test metrics: ${JSON.stringify(metricsBefore.metrics ?? metricsBefore, null, 0)}\n`);

  // Fire ALL 20 in parallel — true concurrent burst
  const startedAt = Date.now();
  console.log("Firing 20 requests in parallel...\n");
  const results = await Promise.all(SCENARIOS.map(runScenario));
  const totalDur = Date.now() - startedAt;

  // Post-test snapshot
  const metricsAfter = await snapshotMetrics();
  const healthAfter = await snapshotHealth();

  // Aggregate
  const ok = results.filter((r) => r.status === 200);
  const fail = results.filter((r) => r.status !== 200);
  const overloaded = results.filter((r) => r.status === 503);
  const ratelimited = results.filter((r) => r.status === 429);
  const dedup = results.filter((r) => r.dedup);

  // Per-tier breakdown
  const byTier = {};
  for (const r of results) {
    const tier = r.expectTier;
    if (!byTier[tier]) byTier[tier] = [];
    byTier[tier].push(r);
  }
  const tierStats = {};
  for (const [tier, list] of Object.entries(byTier)) {
    const okList = list.filter((r) => r.status === 200);
    const lats = okList.map((r) => r.latencyMs);
    tierStats[tier] = {
      total: list.length,
      ok: okList.length,
      fail: list.length - okList.length,
      p50: percentile(lats, 50),
      p95: percentile(lats, 95),
      max: lats.length > 0 ? Math.max(...lats) : 0,
      avgReplyLen: okList.length > 0 ? Math.round(okList.reduce((s, r) => s + r.replyLen, 0) / okList.length) : 0,
    };
  }

  const allLats = ok.map((r) => r.latencyMs);
  const summary = {
    total: results.length,
    ok: ok.length,
    fail: fail.length,
    overloaded: overloaded.length,
    ratelimited: ratelimited.length,
    dedup: dedup.length,
    successRate: ((ok.length / results.length) * 100).toFixed(1) + "%",
    wallClockMs: totalDur,
    throughput: (results.length / (totalDur / 1000)).toFixed(2) + " req/s",
    latency: {
      p50: percentile(allLats, 50),
      p95: percentile(allLats, 95),
      p99: percentile(allLats, 99),
      max: allLats.length > 0 ? Math.max(...allLats) : 0,
      min: allLats.length > 0 ? Math.min(...allLats) : 0,
    },
  };

  console.log("\n" + "=".repeat(70));
  console.log("RESULTS");
  console.log("=".repeat(70));
  console.log(JSON.stringify(summary, null, 2));
  console.log("\nPer-tier:");
  console.log(JSON.stringify(tierStats, null, 2));
  console.log("\nIndividual results:");
  for (const r of results) {
    const status = r.status === 200 ? "✓" : "✗";
    const tail = r.error ? ` ERR: ${JSON.stringify(r.error).slice(0, 80)}` : "";
    console.log(
      `${status} u${String(r.user).padStart(2, "0")} [${r.expectTier.padEnd(11, " ")}] ` +
        `${String(r.latencyMs).padStart(6, " ")}ms ${String(r.status)} ` +
        `(reply=${r.replyLen}c) "${r.text.slice(0, 35)}"${tail}`,
    );
  }

  // Output JSON cuối cho parse vào test.md
  console.log("\n" + "=".repeat(70));
  console.log("JSON_RESULT_BEGIN");
  console.log(
    JSON.stringify(
      {
        meta: {
          startedAt: new Date(startedAt).toISOString(),
          totalUsers: results.length,
          gatewayUrl: GATEWAY_URL,
        },
        summary,
        tierStats,
        results,
        healthBefore,
        healthAfter,
        metricsBefore: metricsBefore.metrics ?? metricsBefore,
        metricsAfter: metricsAfter.metrics ?? metricsAfter,
      },
      null,
      2,
    ),
  );
  console.log("JSON_RESULT_END");
}

main().catch((err) => {
  console.error("Load test crashed:", err);
  process.exit(1);
});
