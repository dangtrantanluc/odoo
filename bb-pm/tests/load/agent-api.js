// k6 load test for the bb-pm agent API surface.
//
// Targets the read-heavy agent endpoints (overdue, digest, audit, audit/stats)
// — these are what the audit dashboard polls and what /agent/run hits in
// most tool calls. /agent/run itself is excluded because it costs LLM
// tokens and is bottlenecked on Qwen, not the API.
//
// Usage:
//   k6 run \
//     -e TARGET=http://localhost:4000/api/v1 \
//     -e AGENT_TOKEN=<token> \
//     bb-pm/tests/load/agent-api.js
//
// Tweak vus / duration via CLI: --vus 50 --duration 30s
//
// SLOs (initial pilot):
//   p95 < 500ms for read endpoints
//   error rate < 1%

import http from "k6/http";
import { check, group, sleep } from "k6";
import { Trend, Rate } from "k6/metrics";

const TARGET = __ENV.TARGET || "http://localhost:4000/api/v1";
const AGENT_TOKEN = __ENV.AGENT_TOKEN || "";

if (!AGENT_TOKEN) {
  throw new Error("Set AGENT_TOKEN env (matches AGENT_API_TOKEN in bb-pm/.env)");
}

const headers = {
  "X-Agent-Token": AGENT_TOKEN,
  "Content-Type": "application/json",
};

const overdueDuration = new Trend("ep_overdue_ms");
const digestDuration = new Trend("ep_digest_ms");
const auditListDuration = new Trend("ep_audit_list_ms");
const auditStatsDuration = new Trend("ep_audit_stats_ms");
const errorRate = new Rate("errors");

export const options = {
  scenarios: {
    read_endpoints: {
      executor: "ramping-vus",
      stages: [
        { duration: "10s", target: 5 },   // warm up
        { duration: "30s", target: 20 },  // ramp to 20 concurrent
        { duration: "30s", target: 20 },  // sustain
        { duration: "10s", target: 0 },   // cool down
      ],
      gracefulRampDown: "5s",
    },
  },
  thresholds: {
    "http_req_failed": ["rate<0.01"],
    "http_req_duration{name:overdue}": ["p(95)<500"],
    "http_req_duration{name:digest}": ["p(95)<500"],
    "http_req_duration{name:audit_list}": ["p(95)<500"],
    "http_req_duration{name:audit_stats}": ["p(95)<800"], // stats does in-memory rollup, slower
    "errors": ["rate<0.01"],
  },
};

export default function () {
  group("overdue", () => {
    const r = http.get(`${TARGET}/tasks/overdue?limit=20`, {
      headers,
      tags: { name: "overdue" },
    });
    overdueDuration.add(r.timings.duration);
    const ok = check(r, {
      "200": (x) => x.status === 200,
      "data array": (x) => Array.isArray(x.json("data")),
    });
    errorRate.add(!ok);
  });

  group("digest", () => {
    const r = http.get(`${TARGET}/projects/digest`, {
      headers,
      tags: { name: "digest" },
    });
    digestDuration.add(r.timings.duration);
    const ok = check(r, {
      "200": (x) => x.status === 200,
      "totals": (x) => !!x.json("data.totals"),
    });
    errorRate.add(!ok);
  });

  group("audit_list", () => {
    const r = http.get(`${TARGET}/agent/audit?limit=50`, {
      headers,
      tags: { name: "audit_list" },
    });
    auditListDuration.add(r.timings.duration);
    const ok = check(r, { "200": (x) => x.status === 200 });
    errorRate.add(!ok);
  });

  group("audit_stats", () => {
    const r = http.get(`${TARGET}/agent/audit/stats?daysBack=7`, {
      headers,
      tags: { name: "audit_stats" },
    });
    auditStatsDuration.add(r.timings.duration);
    const ok = check(r, {
      "200": (x) => x.status === 200,
      "byTool array": (x) => Array.isArray(x.json("data.byTool")),
    });
    errorRate.add(!ok);
  });

  // Each VU pauses 100-500ms between cycles → realistic dashboard polling
  // pattern, not a thundering herd.
  sleep(0.1 + Math.random() * 0.4);
}
