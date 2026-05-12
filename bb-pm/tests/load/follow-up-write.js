// k6 write-path load test — POST /agent/follow-up.
// Less aggressive than the read test (writes are more expensive) but
// still useful for finding insertion bottlenecks (FK lookups, indexes).
//
// Usage:
//   k6 run \
//     -e TARGET=http://localhost:4000/api/v1 \
//     -e AGENT_TOKEN=<token> \
//     -e TASK_ID=1 \
//     -e USER_ID=3 \
//     bb-pm/tests/load/follow-up-write.js

import http from "k6/http";
import { check } from "k6";
import { Rate } from "k6/metrics";

const TARGET = __ENV.TARGET || "http://localhost:4000/api/v1";
const AGENT_TOKEN = __ENV.AGENT_TOKEN || "";
const TASK_ID = Number(__ENV.TASK_ID || 1);
const USER_ID = Number(__ENV.USER_ID || 3);

const headers = {
  "X-Agent-Token": AGENT_TOKEN,
  "Content-Type": "application/json",
};

const errorRate = new Rate("errors");

export const options = {
  scenarios: {
    follow_up_writes: {
      executor: "constant-vus",
      vus: 5,
      duration: "20s",
    },
  },
  thresholds: {
    "http_req_failed": ["rate<0.01"],
    "http_req_duration": ["p(95)<400"],
  },
};

export default function () {
  const corr = `load-${__VU}-${__ITER}`;
  const body = JSON.stringify({
    taskId: TASK_ID,
    userId: USER_ID,
    question: `Load test ping ${corr}`,
    correlationId: corr,
  });
  const r = http.post(`${TARGET}/agent/follow-up`, body, { headers });
  const ok = check(r, {
    "201": (x) => x.status === 201,
    "has id": (x) => !!x.json("data.id"),
  });
  errorRate.add(!ok);
}
