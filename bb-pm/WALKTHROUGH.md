# BB-PM Walkthrough

Hướng dẫn setup dev từ đầu.

---

## 0. Yêu cầu

- **Docker** + **Docker Compose** v2
- **Node.js 20+** và **pnpm 9+** (`npm i -g pnpm`)

---

## 1. Khởi tạo monorepo

```bash
cd /home/bbsw/pm/bb-pm
pnpm install
cp .env.example .env
# chỉnh JWT_SECRET, POSTGRES_PASSWORD, AGENT_API_TOKEN nếu muốn
```

## 2. Khởi tạo DB

```bash
# Khởi chạy Postgres :5433
docker compose up bb_pm_db -d

# Apply migrations (bao gồm agent_audit_log + task_blockers)
pnpm --filter @bb-pm/api prisma migrate deploy

# Seed: company mặc định "BlueBolt", admin, pm-agent service user, VND/USD
pnpm --filter @bb-pm/api prisma db seed
```

Sau bước này, login được với:
- Email: `admin@bluebolt.local`
- Password: `admin123` (đổi ngay sau login thật)

Agent service user (không login trực tiếp, chỉ qua `X-Agent-Token`):
- Email: `pm-agent@bluebolt.local`
- Role: `MANAGER`

## 3. Chạy API + Web (dev)

```bash
# Chạy song song cả hai
pnpm dev
```

Hoặc riêng:

```bash
# Terminal 1
pnpm --filter @bb-pm/api dev        # http://localhost:4000

# Terminal 2
pnpm --filter @bb-pm/web dev        # http://localhost:5173
```

Kiểm tra API:
```bash
curl http://localhost:4000/api/v1/health
# { "status":"ok","db":"ok","uptime":12 }
```

## 4. Test luồng auth

**Register (public):**
```bash
curl -X POST http://localhost:4000/api/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"dat@bluebolt.local","password":"secret123","fullName":"Dat Le","companyId":1}'
```

**Login:**
```bash
curl -X POST http://localhost:4000/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@bluebolt.local","password":"admin123"}'
# → { "data": { "accessToken":"eyJ...", "refreshToken":"...", "user":{...} } }
```

**Me (authorized):**
```bash
TOKEN="eyJ..."
curl http://localhost:4000/api/v1/me -H "authorization: Bearer $TOKEN"
```

## 5. Test agent endpoints (X-Agent-Token)

```bash
TOKEN="$(grep AGENT_API_TOKEN .env | cut -d= -f2)"
curl -H "X-Agent-Token: $TOKEN" http://localhost:4000/api/v1/tasks/overdue
curl -H "X-Agent-Token: $TOKEN" http://localhost:4000/api/v1/projects/digest
curl -H "X-Agent-Token: $TOKEN" http://localhost:4000/api/v1/agent/audit?limit=10
```

## 6. Chạy production (Docker)

```bash
docker compose up -d --build
# Web: http://localhost:5173
# API: http://localhost:4000
# DB:  localhost:5433
```

Logs:
```bash
docker compose logs -f bb_pm_api
docker compose logs -f bb_pm_web
```

## 7. Làm việc với Prisma

```bash
# Sửa schema.prisma → tạo migration mới
pnpm --filter @bb-pm/api prisma migrate dev --name add_something

# Chỉ generate client (không tạo migration)
pnpm --filter @bb-pm/api prisma generate

# Mở Prisma Studio
pnpm --filter @bb-pm/api prisma studio
```

## 8. Common tasks

**Tạo 1 module mới (vd `invoices`):**
1. Thêm model vào `prisma/schema.prisma` → `prisma migrate dev`.
2. Tạo folder `apps/api/src/modules/invoices/` với `routes.ts` + `service.ts`.
3. Register plugin trong `src/server.ts`.
4. Thêm Zod schema vào `packages/shared/src/schemas/invoice.ts`.
5. Tạo page trong `apps/web/src/pages/invoices/`.

**Reset DB hoàn toàn:**
```bash
pnpm --filter @bb-pm/api prisma migrate reset
pnpm --filter @bb-pm/api prisma db seed
```

**Chạy tests:**
```bash
pnpm --filter @bb-pm/api test
pnpm --filter @bb-pm/web test
```

## 9. Troubleshooting

| Triệu chứng | Cách fix |
|---|---|
| `ECONNREFUSED 127.0.0.1:5433` | Chưa chạy `docker compose up bb_pm_db -d` |
| Prisma client outdated | `pnpm --filter @bb-pm/api prisma generate` |
| CORS error từ FE | Check `CORS_ORIGIN` trong `.env` của API |
| `X-Agent-Token` 401 | Token trong bb-pm/.env khác bb-pm-tools/.env |
| Port 4000/5173 bị chiếm | Sửa trong `docker-compose.yaml` hoặc `.env` |

## 10. Cấu trúc file quan trọng

| File | Mục đích |
|---|---|
| `apps/api/prisma/schema.prisma` | Nguồn sự thật cho DB |
| `apps/api/prisma/seed.ts` | Dữ liệu khởi tạo |
| `apps/api/src/server.ts` | Fastify bootstrap, đăng ký plugin/route |
| `apps/api/src/plugins/auth.ts` | JWT + X-Agent-Token middleware |
| `apps/api/src/modules/*/routes.ts` | REST endpoints |
| `apps/api/src/modules/agent/routes.ts` | PM Agent endpoints (audit, gapo-thread) |
| `apps/api/src/services/recompute.ts` | Rollup totals |
| `apps/web/src/app/router.tsx` | SPA routes |
| `apps/web/src/lib/apiClient.ts` | Axios wrapper + interceptor auto refresh |
| `apps/web/src/features/auth/store.ts` | Zustand auth state |
| `packages/shared/src/schemas/*` | Zod schemas dùng chung |
