# CLAUDE.md

Tài liệu này hướng dẫn agent/cộng tác viên khi làm việc trong repo BB-PM hiện tại.

## 1. Hiện trạng dự án

BB-PM không còn là module Odoo active. Kiến trúc production hiện tại là:

```text
GapoWork -> gapo-agent -> bb-pm-tools -> bb-pm API -> PostgreSQL
```

- `bb-pm/`: React SPA + Fastify API + Prisma.
- `bb-pm-tools/`: OpenClaw orchestrator cho PM Agent.
- `gapo-agent/`: channel adapter GapoWork.
- `agent/`: prototype Python cũ, không phải production path.

## 2. Nguyên tắc kiến trúc

| Layer | Sở hữu | Không sở hữu |
| --- | --- | --- |
| `gapo-agent` | Parse webhook, gửi message, credential Gapo | PM logic, DB, prompt |
| `bb-pm-tools` | LLM orchestration, fast-path, workflow, check-in turn handling | Schema DB, Gapo credential |
| `bb-pm API` | Business rule, state machine, tenant scope, persistence | Chat rendering, prompt |

Nếu một logic dùng chung cho web UI và agent chat, đặt ở `bb-pm API`.

## 3. Stack chạy thật

- PostgreSQL 16: dữ liệu domain và agent.
- Redis 7: cooldown/rate-limit/runtime support.
- Fastify + Prisma: API.
- React + Nginx: web app.
- OpenClaw: host `gapo-agent` + `bb-pm-tools`.
- LLM mặc định: `Qwen/Qwen3.6-27B-FP8` qua OpenAI-compatible endpoint.

## 4. Những file nên xem trước khi sửa

- `docker-compose.yaml` — topology, env, service dependency.
- `bb-pm-tools/src/checkin.ts` — flow `/checkin`.
- `bb-pm-tools/src/pre-classifier.ts` — slash command/fast-path.
- `bb-pm-tools/src/workflows/registry.ts` — cron/workflow registry.
- `bb-pm/apps/api/src/modules/agent/routes.ts` — check-in session API và report endpoint.

## 5. Flow `/checkin`

Prompt đầu phiên chỉ hiển thị 3 project gần đây và vẫn cho nhập tên project khác. State machine:

```text
AWAITING_PROJECT -> AWAITING_UPDATE -> COMPLETED
```

Các endpoint liên quan:

- `POST /agent/checkin-sessions/start`
- `GET /agent/checkin-sessions/current`
- `PATCH /agent/checkin-sessions/:id`
- `POST /agent/checkin-sessions/:id/complete`
- `POST /agent/checkins/import`
- `GET /agent/checkins/status`
- `GET /agent/checkins/missing`
- `GET /agent/checkins/project-daily-summary`

## 6. Tài liệu đọc tiếp

- [README.md](./README.md)
- [RUNBOOK.md](./RUNBOOK.md)
- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [INTERNAL_TECHNICAL_DOCUMENTATION.md](./INTERNAL_TECHNICAL_DOCUMENTATION.md)
