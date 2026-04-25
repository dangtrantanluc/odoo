# Load tests — bb-pm agent API

[k6](https://k6.io) scripts for finding throughput / latency bottlenecks in
the agent endpoints before they go live.

## Setup

1. Install k6 (if not already):
   ```sh
   # Linux:  https://github.com/grafana/k6/releases
   # macOS:  brew install k6
   ```
2. Make sure bb-pm API is running and reachable:
   ```sh
   curl http://localhost:4000/api/v1/health
   ```
3. Export the agent token:
   ```sh
   export AGENT_TOKEN=$(grep AGENT_API_TOKEN /home/bbsw/pm/bb-pm/.env | cut -d= -f2)
   ```

## Read endpoints

```sh
k6 run \
  -e TARGET=http://localhost:4000/api/v1 \
  -e AGENT_TOKEN=$AGENT_TOKEN \
  bb-pm/tests/load/agent-api.js
```

Default profile:
- 10s warm up to 5 VUs
- 30s ramp to 20 VUs
- 30s sustain at 20 VUs
- 10s cool down

SLO thresholds:
- `http_req_failed`     — error rate < 1%
- `overdue`             — p95 < 500 ms
- `digest`              — p95 < 500 ms
- `audit_list`          — p95 < 500 ms
- `audit_stats`         — p95 < 800 ms (in-memory rollup is heavier)

Override VUs / duration:
```sh
k6 run --vus 50 --duration 60s ...
```

## Write endpoints (follow-up creation)

Lower concurrency by design — writes are 5-10× more expensive than reads.

```sh
k6 run \
  -e TARGET=http://localhost:4000/api/v1 \
  -e AGENT_TOKEN=$AGENT_TOKEN \
  -e TASK_ID=1 \
  -e USER_ID=3 \
  bb-pm/tests/load/follow-up-write.js
```

## Interpreting results

- `http_req_duration` — request time (server + network).
- `iteration_duration` — per-VU loop including sleep; ignore if you sleep.
- `vus_max` — peak concurrency seen; should match the `target` stage.
- `checks` — % of in-script assertions that passed.

If thresholds fail, the run exits non-zero (for CI gating).

## What's NOT covered

- `POST /agent/run` — bottleneck is LLM (Qwen), not the API. Test
  separately with a script that paces according to LLM TPS.
- `POST /meetings` LLM ingest — same reason.
- Browser-driven flows (S3.5) — Playwright load is a different shape;
  use Playwright's own runner.
