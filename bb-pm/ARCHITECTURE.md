# BB-PM Architecture

Tái triển khai module `bb_project_management` của Odoo thành SPA React + Node API, **dùng database độc lập** (clone cấu trúc từ 11 bảng `bb_*`). Odoo không còn là dependency runtime.

---

## 1. High-level diagram

```
┌──────────────────┐    HTTPS / JSON     ┌──────────────────┐    Prisma     ┌──────────────────┐
│   React (Vite)   │ ──────────────────► │  Fastify API     │ ────────────► │  PostgreSQL 16   │
│   apps/web       │   Bearer JWT        │  apps/api        │               │  bb_pm (5433)    │
│   :5173 / :80    │                     │  :4000           │               │                  │
└──────────────────┘                     └────────┬─────────┘               └──────────────────┘
                                                  │
                                                  │ S3 SDK
                                                  ▼
                                         ┌──────────────────┐
                                         │  MinIO           │
                                         │  bucket:         │
                                         │  bb-pm-avatars   │
                                         └──────────────────┘
```

- **Network**: tất cả service chạy trong một Docker network `bb_pm_net`. MinIO dùng chung instance của Odoo stack qua external network `pm_network` (không phải dependency bắt buộc).
- **Port mapping**: API `4000`, Web `5173` (dev) / `80` (prod container), DB `5433` (khác `5432` để không đụng Odoo DB).
- **Persistence**: Postgres volume `bb_pm_pgdata` tách biệt hoàn toàn với volume của Odoo.

---

## 2. Monorepo layout

```
bb-pm/
├── apps/
│   ├── api/                     # Fastify + Prisma backend
│   │   ├── prisma/
│   │   │   ├── schema.prisma    # Nguồn sự thật cho DB
│   │   │   ├── seed.ts          # Tạo admin + 2 currency + demo
│   │   │   └── migrate-from-odoo.ts   # Copy dữ liệu từ DB Odoo sang bb_pm
│   │   └── src/
│   │       ├── server.ts
│   │       ├── plugins/         # prisma, auth, errorHandler, cors
│   │       ├── modules/         # Mỗi resource 1 folder (routes + service)
│   │       ├── services/        # recompute (project/task/milestone totals)
│   │       └── lib/             # jwt, password, rbac, minio
│   └── web/                     # React SPA
│       └── src/
│           ├── app/             # Router + providers
│           ├── pages/           # Login, Register, Dashboard, Projects...
│           ├── components/
│           ├── features/        # Slice per domain (auth, projects...)
│           ├── lib/             # apiClient, auth store, permissions
│           └── i18n/            # vi.json, en.json
├── packages/
│   └── shared/                  # Zod schemas + TS types shared FE↔BE
├── docker-compose.yaml
├── pnpm-workspace.yaml
├── ARCHITECTURE.md              # File này
├── WALKTHROUGH.md               # Hướng dẫn run/dev/migrate
└── README.md
```

---

## 3. Database — 15 bảng

**4 bảng support** (thay thế Odoo core):

| Bảng | Thay cho | Ghi chú |
|---|---|---|
| `companies` | `res_company` | Multi-company giữ lại; `currencyId` là default currency |
| `users` | `res_users` | `passwordHash` bcrypt; `role` enum (ADMIN/MANAGER/MEMBER/VIEWER) |
| `customers` | `res_partner` | Chỉ giữ field liên quan khách hàng dự án |
| `currencies` | `res_currency` | Seed `VND` + `USD` |

**11 bảng domain** (clone từ `bb_*`, rename cho idiomatic):

```
projects             ←  bb_project
tasks                ←  bb_project_task
backlogs             ←  bb_project_backlog
members              ←  bb_project_member
member_rates         ←  bb_project_member_rate
milestones           ←  bb_project_milestone
scopes               ←  bb_project_scope
tags                 ←  bb_project_tag
project_tags         ←  bb_project_tag_rel
task_tags            ←  bb_project_task_tag_rel
gapo_user_maps       ←  bb_gapo_user_map
```

### 3.1 Quan hệ chính

```
Company ─┬─< User ─┬─< Project(owner)
         │         ├─< Task(assignee)
         │         ├─< Backlog(logger/approver)
         │         └─< Member
         └─< Project ─┬─< Task ─┬─< Backlog
                     │         └─< TaskTag
                     ├─< Member ─< MemberRate
                     ├─< Milestone
                     ├─< Scope
                     └─< ProjectTag
Customer ─< Project
Currency ─< Company/Project/Task/Backlog
Tag ─┬─< ProjectTag
     └─< TaskTag
```

### 3.2 Computed fields

Các cột cache (`totalCost`, `totalHours`, `taskCount`, `completionPct`…) được **recompute ở service layer**, gói trong Prisma transaction:

- `recomputeTaskTotals(taskId)` — SUM over `backlogs WHERE status=APPROVED`.
- `recomputeProjectTotals(projectId)` — rollup từ tasks + backlogs.
- `recomputeMilestoneProgress(milestoneId)` — `done_count / task_count`.

Trigger points:
- Backlog `approve` / `reject` / `reset` / update hours.
- Task status đổi sang `DONE` → milestone recompute.
- Backlog delete / undelete.

> Không dùng Postgres trigger để giữ logic tập trung ở TS, dễ test.

---

## 4. Authentication & RBAC

- **JWT**: access token (15 phút) + refresh token (7 ngày). Access token payload: `{ sub, role, companyId }`.
- **Register**: công khai (`POST /auth/register`) — user mới mặc định role `MEMBER`, thuộc `Company` được chọn khi đăng ký (dropdown công ty có sẵn) hoặc tạo mới.
- **Password**: bcrypt (10 rounds).
- **RBAC**: 4 role như module gốc.

| Role | Projects | Tasks | Backlogs | Members/Rates | Settings |
|---|---|---|---|---|---|
| ADMIN | CRUD | CRUD | CRUD + approve/reject | CRUD | CRUD |
| MANAGER | CRUD | CRUD | CRUD own | CRUD | R |
| MEMBER | R (là member) | R + update own status | CRUD own (pending-only) | R | — |
| VIEWER | R | R | R | R | — |

Ràng buộc "member chỉ sửa backlog mình":
- BE filter `WHERE userId = currentUser.id` khi update.
- Frontend ẩn nút edit/delete nếu không match.

Multi-company: mỗi query tự động scope theo `companyId` của user đăng nhập (trừ khi user là super-admin toàn hệ thống — field `isSuperAdmin` trên `User`).

---

## 5. State machines

**Project status:**
```
planned ─► in_progress ─┬─► on_hold ─► in_progress
                        ├─► completed
                        └─► cancelled
(completed/cancelled) ─► in_progress  (reopen, ADMIN only)
```

**Task status:**
```
todo ↔ in_progress ↔ review ↔ done    (fully reversible)
```

**Backlog status:**
```
pending ─► approved     (ADMIN)
pending ─► rejected     (ADMIN)
approved/rejected ─► pending  (reset, ADMIN)
```

Endpoint chuyên biệt: `POST /:resource/:id/transition { status }` — server validate transition hợp lệ trước khi update.

---

## 6. Frontend patterns

- **Routing**: React Router v6, nested — `/projects/:id` có các tab `overview | tasks | backlogs | members | scope | milestones`.
- **Data**: TanStack Query cho server state, Zustand cho `authStore` (accessToken, user).
- **Form**: React Hook Form + Zod (schema import từ `@bb-pm/shared`).
- **UI kit**: shadcn/ui (Radix primitives) + Tailwind — dễ clone look & feel card/kanban Odoo.
- **Kanban**: `@dnd-kit/core` cho drag-drop task board theo status.
- **Table**: TanStack Table.
- **i18n**: `react-i18next`, default `vi_VN`. File `apps/web/src/i18n/vi.json` được port từ `odoo/.../i18n/vi_VN.po`.
- **Charts**: Recharts cho dashboard KPI + timeseries.

---

## 7. API conventions

- Base path `/api/v1`.
- Response shape:
  ```json
  { "data": <payload>, "meta": { "page": 1, "total": 42 } }
  ```
  Lỗi:
  ```json
  { "error": { "code": "PROJECT_NOT_FOUND", "message": "...", "details": {...} } }
  ```
- Pagination: `?page=1&pageSize=20` (default 20, max 100).
- Filter: `?status=IN_PROGRESS&tag=5&q=keyword`.
- Sort: `?sort=-updatedAt,name`.
- Validation: mọi body/query đều qua Zod; schema share với FE trong `packages/shared`.

---

## 8. Data migration (Odoo → bb_pm)

Script `apps/api/prisma/migrate-from-odoo.ts`:

1. Connect tới Odoo DB (`postgres://admin@project_management_db:5432/odoo`).
2. Lấy mapping Odoo group → role mới:
   - `group_bb_pm_admin` → `ADMIN`
   - `group_bb_pm_manager` → `MANAGER`
   - `group_bb_pm_member` → `MEMBER`
   - khác / viewer → `VIEWER`
3. Copy theo đúng thứ tự (để FK hợp lệ):
   ```
   res_currency     → currencies
   res_company      → companies
   res_users        → users       (password bcrypt reuse nếu còn dùng được; nếu không, set temp password + gửi email reset)
   res_partner      → customers   (chỉ partner được dùng làm customer của ít nhất 1 project)
   bb_project_tag   → tags
   bb_project       → projects
   bb_project_milestone → milestones
   bb_project_scope     → scopes
   bb_project_member    → members
   bb_project_member_rate → member_rates
   bb_project_task      → tasks
   bb_project_backlog   → backlogs
   bb_project_tag_rel, bb_project_task_tag_rel → project_tags, task_tags
   bb_gapo_user_map     → gapo_user_maps
   ```
4. Mỗi bước build `Map<oldId, newId>` để rewrite FK.
5. Sau khi migrate xong, chạy recompute toàn bộ project/task/milestone totals để dữ liệu cache đúng.
6. Verify: so khớp `SELECT COUNT(*)` 2 side.

Chạy idempotent: có flag `--reset` để truncate DB mới trước khi import.

---

## 9. Deployment

**Dev (local)**:
```bash
docker compose up bb_pm_db -d
pnpm install
pnpm --filter @bb-pm/api prisma migrate dev
pnpm --filter @bb-pm/api prisma db seed
pnpm dev    # chạy parallel api + web
```

**Production**:
```bash
docker compose up -d --build
```

Health checks:
- `GET /api/v1/health` → `{ status: "ok", db: "ok" }`.
- Web container nginx `/healthz`.

---

## 10. Roadmap (6 sprints)

| Sprint | Focus | Deliverable |
|---|---|---|
| 1 | Foundation | Monorepo, Docker, Prisma schema, auth (login/register), shell FE, migrate script skeleton |
| 2 | Projects + Tags + Customers | Project CRUD, list/kanban, tag M2M, customer CRUD |
| 3 | Tasks + Milestones | Task CRUD, Kanban board dnd-kit, milestone progress |
| 4 | Backlogs + Cost engine | Backlog CRUD với snapshot, approval queue, recompute service |
| 5 | Scope + Dashboard + Profile | Scope CRUD, KPI cards, charts, avatar upload, i18n switcher |
| 6 | Polish | Settings (users/company/currencies), notifications, E2E tests, performance pass |

Mỗi sprint kết thúc bằng 1 demo có thể chạy được.
