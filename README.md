# BB-PM / PM Operations Agent

BB-PM là hệ thống quản lý vận hành dự án nội bộ, gồm web app, API backend và PM Agent chạy qua GapoWork. Production path hiện tại:

```text
GapoWork -> gapo-agent -> bb-pm-tools -> bb-pm API -> PostgreSQL
```

## Thành phần chính

| Thành phần | Vai trò |
| --- | --- |
| `bb-pm/` | Monorepo React + Fastify + Prisma cho nghiệp vụ project/task/backlog |
| `bb-pm-tools/` | OpenClaw plugin điều phối agent, slash command, workflow, LLM, fast-path |
| `gapo-agent/` | Channel adapter nhận webhook GapoWork và gửi outbound message |
| `docker-compose.yaml` | Stack local/prod-like gồm Postgres, Redis, API, Web, OpenClaw |
| `agent/` | Prototype Python cũ để thử nghiệm, không nằm trong production path |

## Bắt đầu nhanh

```bash
cp .env.docker.example .env
docker compose up -d --build
cd bb-pm
pnpm --filter @bb-pm/api prisma db seed
```

Health check chuẩn:

```bash
curl http://localhost:4000/api/v1/health
curl http://localhost:18789/api/plugins/gapo-agent/health
curl http://localhost:18789/api/plugins/bb-pm/health
```

## Tài liệu nên đọc

- [RUNBOOK.md](./RUNBOOK.md) — deploy, smoke test, cron, rollback, debug production.
- [ARCHITECTURE.md](./ARCHITECTURE.md) — kiến trúc hệ thống end-to-end.
- [INTERNAL_TECHNICAL_DOCUMENTATION.md](./INTERNAL_TECHNICAL_DOCUMENTATION.md) — tài liệu bàn giao sâu cho developer/maintainer.
- [PROCESS.md](./PROCESS.md) — trạng thái hiện tại, changelog và các mốc tiến hóa của hệ thống.
- [bb-pm/README.md](./bb-pm/README.md) — vào nhanh phần web/API.
- [bb-pm-tools/README.md](./bb-pm-tools/README.md) — chi tiết plugin agent hiện tại.

## Flow `/checkin` hiện tại

Khi user gửi `/checkin`, bot không show một danh sách project dài nữa mà ưu tiên 3 project gần đây:

```text
Hôm nay bạn làm project nào?

Gần đây:
1. AI PM Agent
2. Logistics Dashboard
3. CRM Internal

Hoặc nhập tên project khác.
```

Người dùng có thể chọn bằng quick reply, gõ số, hoặc nhập tên project khác. Session đi qua `AWAITING_PROJECT -> AWAITING_UPDATE -> COMPLETED`; sau khi hoàn tất, backend tạo backlog `GAPO_CHECKIN` để report và tổng hợp trong ngày.
