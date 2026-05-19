# BB Project Management

`bb-pm` là phần web + API của hệ thống BB-PM. Nó sở hữu business rule, state machine, RBAC, multi-tenant scope và persistence; PM Agent chỉ gọi vào qua HTTP.

```text
GapoWork -> gapo-agent -> bb-pm-tools -> bb-pm API -> PostgreSQL
```

## Quick start

```bash
docker compose up bb_pm_db bb_pm_redis -d
pnpm install
pnpm --filter @bb-pm/api prisma migrate deploy
pnpm --filter @bb-pm/api prisma db seed
pnpm dev
```

- Web: `http://localhost:5173`
- API: `http://localhost:4000`
- DB: `localhost:5433`
- Login mặc định: `admin@bluebolt.local` / `admin123`

## Những gì backend đang phục vụ

- CRUD project/task/backlog/member/milestone/scope.
- Auth JWT cho người dùng và `X-Agent-Token` cho service agent.
- Digest, weekly report, blocker, automation, memory, channel identity.
- Check-in API cho bot:
  - `/agent/checkin-sessions/*`
  - `/agent/checkins/import`
  - `/agent/checkins/status`
  - `/agent/checkins/missing`
  - `/agent/checkins/project-daily-summary`

## Đọc tiếp

- [ARCHITECTURE.md](./ARCHITECTURE.md) — kiến trúc backend/web chi tiết.
- [WALKTHROUGH.md](./WALKTHROUGH.md) — setup từng bước.
- [../README.md](../README.md) — toàn cảnh repo.
- [../RUNBOOK.md](../RUNBOOK.md) — deploy và vận hành production.
- [../INTERNAL_TECHNICAL_DOCUMENTATION.md](../INTERNAL_TECHNICAL_DOCUMENTATION.md) — tài liệu bàn giao sâu.
