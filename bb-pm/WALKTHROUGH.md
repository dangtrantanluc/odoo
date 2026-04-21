# BB-PM Walkthrough

Hướng dẫn setup dev từ đầu, migrate data từ Odoo, và chạy Sprint 1.

---

## 0. Yêu cầu

- **Docker** + **Docker Compose** v2
- **Node.js 20+** và **pnpm 9+** (`npm i -g pnpm`)
- Odoo stack hiện tại (`/home/bbsw/uchiha_itachi_36/odoo`) **đang chạy** — cần cho bước migrate

---

## 1. Khởi tạo monorepo

```bash
cd /home/bbsw/uchiha_itachi_36/bb-pm
pnpm install
cp .env.example .env
# chỉnh JWT_SECRET, POSTGRES_PASSWORD nếu muốn
```

## 2. Khởi tạo DB

```bash
# Khởi chạy Postgres riêng (port 5433 để không đụng Odoo 5432)
docker compose up bb_pm_db -d

# Generate Prisma client & apply migration đầu tiên
pnpm --filter @bb-pm/api prisma migrate dev --name init

# Seed: tạo company mặc định "BlueBolt", admin user, VND/USD
pnpm --filter @bb-pm/api prisma db seed
```

Sau bước này, login được với:
- Email: `admin@bluebolt.local`
- Password: `admin123` (đổi ngay sau khi login thật)

## 3. Migrate data từ Odoo (optional)

Yêu cầu: Odoo DB `odoo` đang sống trong container `project_management_db`.

```bash
# Từ máy host, expose Odoo DB qua network bb_pm (đã khai báo external: pm_network)
docker network connect pm_network bb_pm_db || true

# Chạy script migrate
pnpm --filter @bb-pm/api migrate:odoo -- --reset   # --reset = truncate DB mới trước
```

Script sẽ:
1. Đọc từ `postgres://admin:admin123@project_management_db:5432/odoo`.
2. Map group Odoo → role `ADMIN/MANAGER/MEMBER/VIEWER`.
3. Copy theo thứ tự: currencies → companies → users → customers → tags → projects → milestones → scopes → members → member_rates → tasks → backlogs → tag_rel → gapo_user_map.
4. Recompute toàn bộ `totalCost/totalHours/completionPct`.
5. Verify count 2 side, in report.

> Note: mật khẩu Odoo nếu dùng passlib bcrypt sẽ không verify được bởi `bcrypt` Node. Script sẽ set tạm `changeme123` cho từng user migrate; user cần reset qua luồng "Forgot password" ở app mới.

## 4. Chạy API + Web (dev)

```bash
# Chạy song song cả hai bằng turborepo/concurrently
pnpm dev
```

Hoặc chạy riêng từng service:

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

## 5. Test luồng auth (Sprint 1)

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

Trên browser: `http://localhost:5173` → form login/register → sau login sẽ vào placeholder Dashboard.

## 6. Chạy production (Docker)

```bash
docker compose up -d --build
# Web: http://localhost:5173
# API: http://localhost:4000
# DB:  localhost:5433  (user bbpm / pass ở .env)
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

# Mở Prisma Studio để xem/sửa data
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
| Login fail sau migrate | Dùng "Forgot password" — password Odoo không tương thích |
| Port 4000/5173 bị chiếm | Sửa trong `docker-compose.yaml` hoặc `.env` |

## 10. Cấu trúc file quan trọng — cheat sheet

| File | Mục đích |
|---|---|
| `apps/api/prisma/schema.prisma` | Nguồn sự thật cho DB |
| `apps/api/prisma/seed.ts` | Dữ liệu khởi tạo |
| `apps/api/prisma/migrate-from-odoo.ts` | Copy từ Odoo |
| `apps/api/src/server.ts` | Fastify bootstrap, đăng ký plugin/route |
| `apps/api/src/plugins/auth.ts` | JWT verify middleware |
| `apps/api/src/modules/*/routes.ts` | REST endpoints |
| `apps/api/src/services/recompute.ts` | Rollup totals |
| `apps/web/src/app/router.tsx` | SPA routes |
| `apps/web/src/lib/apiClient.ts` | Axios wrapper + interceptor auto refresh |
| `apps/web/src/features/auth/store.ts` | Zustand auth state |
| `packages/shared/src/schemas/*` | Zod schemas dùng chung |
