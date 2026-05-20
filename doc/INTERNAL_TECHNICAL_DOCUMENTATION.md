# BB-PM Internal Technical Documentation

> Tài liệu này dành cho developer mới onboard, maintainer, tech lead và các team liên quan cần hiểu nhanh business, architecture, setup, coding flow và system flow của BB Project Management.

## Mục Lục

1. [Project Overview](#1-project-overview)
2. [Tech Stack](#2-tech-stack)
3. [System Architecture](#3-system-architecture)
4. [Repository Structure](#4-repository-structure)
5. [Domain Model & Database Design](#5-domain-model--database-design)
6. [Authentication, Authorization & Multi-Tenant Scope](#6-authentication-authorization--multi-tenant-scope)
7. [Business Flows](#7-business-flows)
8. [API Design & Request Lifecycle](#8-api-design--request-lifecycle)
9. [Frontend Architecture](#9-frontend-architecture)
10. [Agent Runtime Layer](#10-agent-runtime-layer)
11. [Setup & Runbook](#11-setup--runbook)
12. [Development Workflow](#12-development-workflow)
13. [Testing Strategy](#13-testing-strategy)
14. [Deployment & Operations](#14-deployment--operations)
15. [Troubleshooting](#15-troubleshooting)
16. [Maintenance Notes](#16-maintenance-notes)
17. [Python Agent Service — Deep Dive](#17-python-agent-service--deep-dive)
18. [Channel Integration, Deployment & Testing](#18-channel-integration-deployment--testing)
19. [Daily Check-in Deep Dive](#19-daily-check-in-deep-dive)

---

# 1. Project Overview

## 1.1 Project dùng để làm gì

BB-PM là hệ thống quản lý dự án nội bộ được xây dựng theo mô hình web application độc lập:

- Frontend: React SPA cho người dùng thao tác trên trình duyệt.
- Backend: Fastify API cung cấp REST endpoints.
- Database: PostgreSQL lưu dữ liệu vận hành dự án.
- Agent layer: các API riêng cho PM Operations Agent và tooling tự động hóa.

Hệ thống giúp team quản lý vòng đời dự án từ lúc lên kế hoạch, chia scope, tạo task, assign nhân sự, log backlog/time, duyệt công, tính chi phí, theo dõi milestone, đến audit các thao tác của agent.

## 1.2 Business problem giải quyết

Trong vận hành project management, dữ liệu thường bị phân tán ở nhiều nơi:

- Project status nằm trong spreadsheet.
- Task nằm trong tool riêng.
- Time log/backlog nằm trong chat hoặc file.
- Cost/rate tính thủ công.
- Follow-up với member phụ thuộc vào PM nhớ việc.
- Báo cáo tiến độ phải tổng hợp thủ công.

BB-PM gom các luồng đó về một data model thống nhất để:

- PM nắm được dự án nào đang chậm, task nào quá hạn, backlog nào chờ duyệt.
- Management nhìn được tổng cost, total hours, budget remaining.
- Developer/member có nơi log work rõ ràng.
- Agent có API chuẩn để query, audit, follow-up và hỗ trợ vận hành.

## 1.3 Mục tiêu hệ thống

- Tạo một source of truth cho project operation.
- Giảm thao tác thủ công khi tổng hợp báo cáo và follow-up.
- Chuẩn hóa quyền truy cập theo role và công ty.
- Giữ business rules ở backend để frontend và agent không tự diễn giải khác nhau.
- Có cấu trúc monorepo dễ mở rộng module mới.
- Cho phép chạy local nhanh bằng Docker + pnpm.

## 1.4 Core features

- Authentication: register, login, refresh token, logout.
- RBAC: ADMIN, MANAGER, MEMBER, VIEWER.
- Project management: CRUD project, filter, tags, status transition.
- Task management: CRUD task, Kanban, transition, blocker.
- Backlog/time log: log giờ theo task, approve/reject/reset.
- Cost engine: snapshot hourly rate, recompute task/project totals.
- Members & rates: quản lý member theo project và lịch sử cost/hour.
- Milestones: tiến độ milestone dựa trên task done count.
- Scope: breakdown scope, estimate hours/rate/cost.
- Dashboard: KPI và charts.
- Admin settings: users, company, currencies.
- Notifications: read/read-all.
- Uploads: avatar upload.
- Agent APIs: audit log, report query, channel identities, follow-ups, memory, automations, meeting extraction.

## 1.5 Actor chính

| Actor | Mục tiêu | Quyền điển hình |
|---|---|---|
| ADMIN | Quản trị hệ thống, cấu hình user/company/currency, duyệt backlog, reopen project | Full access, có thể là super admin |
| MANAGER | Quản lý dự án, task, member, cost và báo cáo | CRUD phần lớn domain trong company |
| MEMBER | Nhận task, cập nhật task liên quan, log backlog của mình | Read project/task được phân quyền, CRUD backlog own |
| VIEWER | Theo dõi tiến độ và báo cáo | Read-only |
| PM Agent | Query hệ thống, audit tool call, follow-up member, tạo dữ liệu từ automation | Auth bằng `X-Agent-Token`, map sang service user |

## 1.6 Use case chính

### Use case: PM tạo dự án và chia task

1. PM tạo customer hoặc chọn customer có sẵn.
2. PM tạo project với budget, priority, owner, account manager, currency.
3. PM thêm members và hourly rates.
4. PM tạo milestones/scopes.
5. PM tạo tasks, assign member, gắn milestone và tags.
6. Dashboard và project detail tự hiển thị số lượng task/member/scope/milestone sau recompute.

### Use case: Member log work và ADMIN duyệt cost

1. Member tạo backlog theo task, work date, hours, description.
2. Backend snapshot `costPerHourSnapshot` và `totalCostSnapshot`.
3. Backlog ở trạng thái `PENDING`.
4. ADMIN approve backlog.
5. Backend recompute `Task.totalHours`, `Task.totalCost`.
6. Backend recompute `Project.totalHours`, `Project.totalCost`, `budgetRemaining`.

### Use case: Agent kiểm tra task overdue

1. Tooling gọi API với `X-Agent-Token`.
2. Backend xác thực token và resolve service user `pm-agent@bluebolt.local`.
3. Agent gọi endpoints như `/api/v1/tasks/overdue`, `/api/v1/projects/digest`.
4. Tool call được ghi vào `agent_audit_log`.
5. Nếu cần hỏi member, agent tạo `agent_follow_ups`.

---

# 2. Tech Stack

## 2.1 Backend

| Công nghệ | Vai trò | Vì sao chọn |
|---|---|---|
| Node.js 20+ | Runtime backend | Phù hợp TypeScript end-to-end, ecosystem lớn |
| Fastify 5 | HTTP API framework | Nhanh, plugin architecture tốt, schema validation tốt |
| TypeScript | Type safety | Giảm lỗi contract giữa modules |
| Prisma 5 | ORM và migration | Schema rõ ràng, type-safe DB client, migration workflow ổn định |
| Zod | Runtime validation | Dùng chung schema giữa frontend/backend qua `@bb-pm/shared` |
| `fastify-type-provider-zod` | Gắn Zod với Fastify | Validate body/query/params theo schema |
| `@fastify/jwt` | JWT auth | Access token flow đơn giản |
| bcrypt | Password hashing | Hash password trước khi lưu DB |
| Pino/Pino Pretty | Logging | Fastify tích hợp native logger |

## 2.2 Frontend

| Công nghệ | Vai trò | Vì sao chọn |
|---|---|---|
| React 18 | SPA UI | Component model phổ biến, dễ maintain |
| Vite 5 | Dev server/build | Fast HMR, build đơn giản |
| TypeScript | Type safety | Đồng bộ type với shared package |
| React Router v6 | Routing | SPA nested routes rõ ràng |
| TanStack Query | Server state | Cache, refetch, loading/error state chuẩn |
| Zustand | Client state | Nhẹ, phù hợp auth/theme state |
| React Hook Form | Forms | Hiệu năng tốt, dễ tích hợp Zod |
| Tailwind CSS | Styling | Utility-first, nhanh và nhất quán |
| lucide-react | Icons | Icon set nhất quán |
| Recharts | Dashboard charts | Charting đủ dùng cho KPI/timeseries |
| dnd-kit | Kanban drag/drop | Thư viện drag-drop hiện đại, linh hoạt |
| i18next/react-i18next | i18n | Hỗ trợ tiếng Việt/English |

## 2.3 Database

| Công nghệ | Vai trò | Vì sao chọn |
|---|---|---|
| PostgreSQL 16 | Primary relational database | Phù hợp dữ liệu quan hệ: project, task, user, cost, audit |
| Prisma migrations | DB versioning | Migration theo source control, dễ deploy |

## 2.4 Queue

Hiện tại chưa có queue worker riêng trong `bb-pm`. Automation/agent được exposed qua API và tooling bên ngoài. Nếu sau này cần xử lý async nặng, nên thêm worker/service riêng thay vì nhét long-running job vào request lifecycle.

## 2.5 Cache

| Công nghệ | Vai trò hiện tại |
|---|---|
| Redis 7 | Có service trong Docker Compose và health check optional qua `REDIS_URL`; dùng được cho cooldown/cache ở agent ecosystem |

Redis không phải dependency bắt buộc cho API human/web traffic. Health endpoint vẫn trả 200 nếu DB ok và Redis down.

## 2.6 AI/ML

Trong repo `bb-pm`, AI không nằm trực tiếp trong frontend/backend core. Thay vào đó hệ thống cung cấp agent-ready APIs:

- `agent_audit_log` để audit tool calls.
- `agent_memory` để lưu summary lần chạy agent.
- `agent_follow_ups` để theo dõi follow-up.
- `meetings` và `meeting_action_items` cho flow transcript -> action items.
- `automations` để lưu workflow/schedule.

LLM orchestration nằm ở tooling bên ngoài như `bb-pm-tools`/OpenClaw plugin.

## 2.7 Infra/DevOps

| Công nghệ | Vai trò |
|---|---|
| Docker Compose | Chạy Postgres, Redis, API, Web |
| Nginx trong web container | Serve static SPA production |
| pnpm workspace | Monorepo package management |
| Vitest | Unit/e2e tests |

## 2.8 Third-party services / External APIs

| Service | Tình trạng |
|---|---|
| MinIO/S3-compatible storage | Env có cấu hình avatar bucket, current API còn serve local `/uploads` |
| Gapo/Slack/Zalo/Telegram/Email/SMS | Được model hóa qua `ChannelIdentity`; integration thực tế nằm ở agent/tooling ngoài |

---

# 3. System Architecture

## 3.1 Tổng quan architecture

BB-PM hiện là modular monolith theo monorepo:

- Một frontend SPA.
- Một backend API process.
- Một PostgreSQL database.
- Các module domain tách theo folder nhưng deploy cùng một API service.
- Shared package chứa enum/schema dùng chung giữa frontend và backend.

Đây không phải microservice. Lý do hợp lý:

- Domain còn có nhiều transaction liên quan nhau: backlog approval -> task total -> project total.
- Team cần velocity và consistency hơn là distributed complexity.
- Backend API có thể enforce RBAC, tenant scope và business rules tập trung.
- Tách microservice quá sớm sẽ làm tăng chi phí vận hành, schema sync và observability.

## 3.2 High-level architecture diagram

```mermaid
flowchart LR
  U[User Browser] -->|HTTP JSON + Bearer JWT| W[React SPA<br/>apps/web]
  W -->|/api/v1/*| A[Fastify API<br/>apps/api]
  A -->|Prisma Client| DB[(PostgreSQL 16)]
  A -->|Static files| UP[Local uploads<br/>/uploads]
  A -. optional health .-> R[(Redis)]
  AG[PM Agent / bb-pm-tools] -->|X-Agent-Token| A
  A --> AUD[(agent_audit_log)]
```

## 3.3 Runtime services

| Service | Dev port | Docker/prod port | Mục đích |
|---|---:|---:|---|
| Web Vite | 5173 | 6080 -> 80 | React SPA |
| API | 4000 | 4001 -> 4000 by default compose | Fastify REST API |
| PostgreSQL | 5433 | 5433 -> 5432 | Primary DB |
| Redis | 6379 | 6379 -> 6379 | Optional cache/cooldown |

Lưu ý: README nói API ở `4000`, nhưng `docker-compose.yaml` map `${API_PORT:-4001}:4000`. Khi chạy dev bằng `pnpm dev`, API dùng `API_PORT` trong `.env` hoặc default `4000`. Khi chạy full Docker compose, kiểm tra `.env` để biết host port thực tế.

## 3.4 Module structure

Backend module pattern:

```text
apps/api/src/modules/<domain>/routes.ts
```

Mỗi module là Fastify plugin:

- Đăng ký `preHandler` auth nếu endpoint cần login.
- Dùng Zod schema từ `@bb-pm/shared` hoặc schema local.
- Query/mutate bằng `app.prisma`.
- Trả response shape `{ data: ... }`.
- Với mutation có side effect thì gọi service như `recomputeTaskTotals`.

Frontend module pattern:

```text
apps/web/src/features/<domain>/api.ts
apps/web/src/pages/<domain>/*.tsx
```

- `features/*/api.ts`: wrapper gọi API.
- `pages/*`: UI page/tab/modal.
- `lib/apiClient.ts`: axios instance, auth interceptor, refresh token flow.

## 3.5 Service communication

```mermaid
sequenceDiagram
  participant UI as React UI
  participant API as Fastify API
  participant Auth as Auth Plugin
  participant DB as PostgreSQL

  UI->>API: GET /api/v1/projects Authorization: Bearer accessToken
  API->>Auth: app.authenticate()
  Auth->>API: req.user = { id, role, companyId, isSuperAdmin }
  API->>DB: prisma.project.findMany({ where: company scope/filter })
  DB-->>API: rows
  API-->>UI: { data: projects, meta? }
```

## 3.6 Event/data flow

BB-PM không có event bus nội bộ. Các "event flow" quan trọng được implement bằng service calls trong transaction:

- Backlog approve/reject/reset -> recompute task totals -> recompute project totals.
- Task status transition -> recompute milestone progress nếu task thuộc milestone.
- Member/rate changes -> ảnh hưởng snapshot cost cho backlog mới.
- Agent call -> ghi audit log -> tooling ngoài có thể đọc audit/stats.

## 3.7 Request lifecycle

```mermaid
flowchart TD
  A[HTTP Request] --> B[Fastify hooks]
  B --> C[Helmet/CORS/Rate Limit]
  C --> D{Auth required?}
  D -- No --> G[Route handler]
  D -- JWT --> E[Verify Bearer token]
  D -- Agent --> F[Verify X-Agent-Token]
  E --> G
  F --> G
  G --> H[Zod validation]
  H --> I[Prisma query/transaction]
  I --> J[Optional domain services<br/>recompute/notify]
  J --> K[Response { data }]
  H -- invalid --> L[Error handler]
  I -- Prisma error --> L
  L --> M[{ error: code, message, details }]
```

---

# 4. Repository Structure

```text
bb-pm/
├── apps/
│   ├── api/
│   │   ├── prisma/
│   │   │   ├── schema.prisma
│   │   │   ├── seed.ts
│   │   │   └── migrations/
│   │   ├── src/
│   │   │   ├── db/
│   │   │   ├── lib/
│   │   │   ├── modules/
│   │   │   ├── plugins/
│   │   │   ├── services/
│   │   │   └── server.ts
│   │   └── tests/e2e/
│   └── web/
│       ├── src/
│       │   ├── app/
│       │   ├── components/
│       │   ├── features/
│       │   ├── i18n/
│       │   ├── lib/
│       │   ├── pages/
│       │   └── main.tsx
│       └── Dockerfile
├── packages/
│   └── shared/
│       └── src/
│           ├── enums.ts
│           └── schemas/
├── tests/load/
├── docker-compose.yaml
├── docker-compose.test.yaml
├── package.json
├── pnpm-workspace.yaml
├── README.md
├── ARCHITECTURE.md
├── WALKTHROUGH.md
└── INTERNAL_TECHNICAL_DOCUMENTATION.md
```

Repo gốc `/home/bbsw/hakuryu` còn chứa **service Python `agent/`** — PM Agent độc lập đã thay
thế hoàn toàn OpenClaw + 3 plugin TypeScript cũ (`bb-pm-tools/`, `gapo-agent/`, `browser-tools/`
đã bị xoá). Xem chi tiết ở [Section 17](#17-python-agent-service--deep-dive):

```text
agent/
├── app/
│   ├── main.py                 # FastAPI app, lifespan, wire DI, mount routers
│   └── api/
│       ├── routes_agent.py     # POST /api/plugins/bb-pm/agent/run, /metrics, /health
│       ├── routes_gapo.py      # POST /api/plugins/gapo-agent/{webhook,send}, /health
│       └── routes_debug.py     # POST /debug/normalize-gapo
├── core/
│   ├── config.py               # Settings: LLM đa provider, gapo, redis, cron, rate-limit
│   ├── logging.py              # JSON structured logger + truncate
│   └── deps.py                 # Container — DI singletons
├── channel/
│   ├── base.py                 # ChannelAdapter Protocol + TurnHandler type
│   └── gapo/
│       ├── models.py           # GapoNormalizedEvent, GapoMessageBody, GapoSendResult
│       ├── normalizer.py       # normalize_gapo_payload + should_process filter
│       ├── client.py           # GapoClient — gửi tin qua Gapo Bot API
│       └── handler.py          # GapoHandler — webhook handler, event dedup
├── orchestrator/
│   ├── pipeline.py             # Orchestrator — pipeline xử lý 1 turn
│   ├── rate_limit.py           # token-bucket per-caller (Redis / in-mem)
│   ├── dedup.py                # re-send dedup (sha256, TTL)
│   ├── concurrency.py          # asyncio.Semaphore slot limiter
│   ├── caller_cache.py         # cache Gapo external_id -> bb-pm user
│   ├── cooldown.py             # cooldown follow-up (Redis)
│   └── telemetry.py            # counter theo mode
├── routing/
│   ├── fast_path/router.py     # slash command + VN regex pattern
│   ├── action_router.py        # natural-language write + confirm
│   └── read_router.py          # classify read/action/ambiguous
├── checkin/
│   ├── models.py               # ParsedCheckin, CheckinTurnResult
│   ├── parser.py               # parse_checkin (LLM + regex fallback)
│   └── service.py              # CheckinService — state machine
├── reporting/nl_to_sql/translator.py   # NL -> SQL (SELECT-only, company scope)
├── tools/
│   ├── catalog.py              # ToolCatalog — query/action functions
│   └── format.py               # render text tiếng Việt
├── workflows/
│   ├── registry.py             # WorkflowRegistry — 7 workflow
│   └── scheduler.py            # AgentScheduler — APScheduler
├── infrastructure/
│   ├── bbpm_client.py          # BbPmClient — ~45 method gọi bb-pm API
│   ├── llm_client.py           # LlmClient — multi-provider OpenAI-compat
│   └── redis.py                # RedisClient — async pool
├── shared/
│   ├── types.py                # TurnRequest, TurnReply, ReplyBody
│   └── text.py                 # normalize (bỏ dấu), strip_markdown_for_gapo
├── tests/
├── Dockerfile
└── requirements.txt
```

## 4.1 File quan trọng

| File | Ý nghĩa |
|---|---|
| `apps/api/src/server.ts` | Fastify bootstrap, middleware, route registration |
| `apps/api/src/plugins/auth.ts` | JWT và `X-Agent-Token` authentication |
| `apps/api/src/plugins/errorHandler.ts` | Chuẩn hóa lỗi Zod/Prisma/internal |
| `apps/api/src/services/recompute.ts` | Rollup total hours/cost/count/progress |
| `apps/api/src/lib/transitions.ts` | State machine cho project/task/backlog |
| `apps/api/prisma/schema.prisma` | Source of truth cho database |
| `apps/api/prisma/seed.ts` | Seed company, users, currencies, demo project |
| `apps/web/src/app/router.tsx` | SPA route map |
| `apps/web/src/lib/apiClient.ts` | Axios base client + token refresh interceptor |
| `apps/web/src/features/auth/store.ts` | Zustand auth state |
| `packages/shared/src/schemas/*` | Zod schemas dùng chung |

---

# 5. Domain Model & Database Design

## 5.1 Nhóm bảng support

| Model | Mục đích |
|---|---|
| `Company` | Tenant/business entity; user/project/task/backlog thuộc company |
| `User` | Người dùng hệ thống, role, profile, org metadata |
| `RefreshToken` | Refresh token hash, expiry, revoke |
| `Notification` | Notification cho user |
| `Customer` | Khách hàng của project |
| `Currency` | Currency và exchange rate |

## 5.2 Nhóm bảng domain project management

| Model | Mục đích |
|---|---|
| `Project` | Dự án, budget, status, priority, owner, cached rollups |
| `Task` | Công việc trong project, assignee, milestone, cost/hours rollup |
| `Backlog` | Time log/work log theo task, có approval status |
| `Member` | User thuộc project |
| `MemberRate` | Hourly rate theo member/project/effective date |
| `Milestone` | Mốc dự án, progress dựa trên task |
| `Scope` | Breakdown scope và estimate |
| `Tag`, `ProjectTag`, `TaskTag` | Tagging many-to-many |

## 5.3 Nhóm bảng agent/integration

| Model | Mục đích |
|---|---|
| `GapoUserMap` | Mapping cũ user với Gapo |
| `ChannelIdentity` | Mapping mới user với channel ngoài: gapo/slack/zalo/telegram/email/sms |
| `AgentAuditLog` | Audit tool invocation |
| `TaskBlocker` | Blocker có severity/resolvedAt |
| `AgentFollowUp` | Log follow-up agent gửi cho member |
| `AgentMemory` | Memory summary của agent runs |
| `Meeting`, `MeetingActionItem` | Meeting transcript, decisions, action items |
| `Automation` | DB-backed workflow schedule |

## 5.4 ER diagram rút gọn

```mermaid
erDiagram
  Company ||--o{ User : has
  Company ||--o{ Project : owns
  Customer ||--o{ Project : has
  Currency ||--o{ Company : default
  Currency ||--o{ Project : uses
  User ||--o{ Project : owns
  User ||--o{ Task : assigned
  Project ||--o{ Task : contains
  Project ||--o{ Member : has
  Member ||--o{ MemberRate : has
  Project ||--o{ Milestone : has
  Milestone ||--o{ Task : groups
  Task ||--o{ Backlog : has
  User ||--o{ Backlog : logs
  Project ||--o{ Scope : has
  Task ||--o{ TaskBlocker : has
  User ||--o{ ChannelIdentity : maps
  Task ||--o{ AgentFollowUp : tracked
```

## 5.5 Cached rollups

Project và task có các cột cache:

- `Task.totalHours`
- `Task.totalCost`
- `Project.totalHours`
- `Project.totalCost`
- `Project.budgetRemaining`
- `Project.taskCount`
- `Project.memberCount`
- `Project.backlogCount`
- `Project.scopeCount`
- `Project.milestoneCount`
- `Milestone.taskCount`
- `Milestone.doneCount`
- `Milestone.completionPct`

WHY:

- Dashboard/list pages cần đọc nhanh.
- Tránh mỗi request phải aggregate nhiều bảng.
- Cost report cần consistent snapshot sau approval.

Trade-off:

- Mỗi mutation liên quan phải nhớ recompute.
- Nếu thêm endpoint mới mutate task/backlog/member/scope/milestone, cần kiểm tra có làm lệch cache không.

Các service liên quan nằm ở `apps/api/src/services/recompute.ts`:

- `recomputeTaskTotals(tx, taskId)`
- `recomputeProjectTotals(tx, projectId)`
- `recomputeMilestoneProgress(tx, milestoneId)`

## 5.6 Cost model

Backlog lưu snapshot:

- `hours`
- `costPerHourSnapshot`
- `totalCostSnapshot`

WHY snapshot thay vì tính live từ `MemberRate`:

- Rate của member có thể đổi theo thời gian.
- Cost lịch sử đã approve không nên bị thay đổi khi cập nhật rate mới.
- Báo cáo tài chính cần auditability.

Flow:

```mermaid
flowchart TD
  A[Member tạo backlog] --> B[Resolve member rate hiện hành]
  B --> C[Save costPerHourSnapshot + totalCostSnapshot]
  C --> D[Backlog status PENDING]
  D --> E[ADMIN approve]
  E --> F[SUM approved backlog by task]
  F --> G[Update task totalHours/totalCost]
  G --> H[SUM task totals by project]
  H --> I[Update project totalHours/totalCost/budgetRemaining]
```

---

# 6. Authentication, Authorization & Multi-Tenant Scope

## 6.1 Auth flows

### Register

Endpoint: `POST /api/v1/auth/register`

Input từ shared schema:

- `email`
- `password`
- `fullName`
- `companyId` hoặc `companyName`

Behavior:

- Nếu email đã tồn tại -> `409 EMAIL_TAKEN`.
- Nếu `companyId` có nhưng không tồn tại -> `404 COMPANY_NOT_FOUND`.
- Nếu tạo company mới, backend đảm bảo currency `VND` tồn tại.
- User mới mặc định role `MEMBER`.
- Backend issue access token và refresh token.

### Login

Endpoint: `POST /api/v1/auth/login`

Behavior:

- Tìm user theo email.
- Reject nếu user không tồn tại hoặc inactive.
- So sánh password bằng bcrypt.
- Cập nhật `lastLoginAt`.
- Issue access token và refresh token.

### Refresh

Endpoint: `POST /api/v1/auth/refresh`

Behavior:

- Hash refresh token raw.
- Tìm trong `refresh_tokens`.
- Reject nếu revoked/expired.
- Revoke token cũ.
- Issue token mới.

WHY rotate refresh token:

- Giảm rủi ro nếu refresh token bị lộ.
- Cho phép logout/revoke rõ ràng.

### Logout

Endpoint: `POST /api/v1/auth/logout`

Behavior:

- Auth bằng access token.
- Revoke toàn bộ refresh token active của user.

## 6.2 Access token payload

JWT payload gồm:

```ts
{
  sub: number;
  email: string;
  role: Role;
  companyId: number;
  isSuperAdmin: boolean;
}
```

Backend decode payload vào `req.user`.

## 6.3 Agent authentication

Agent không dùng JWT. Agent gửi header:

```http
X-Agent-Token: <AGENT_API_TOKEN>
```

Backend:

1. So sánh với `process.env.AGENT_API_TOKEN`.
2. Resolve service user theo `AGENT_USER_EMAIL` hoặc default `pm-agent@bluebolt.local`.
3. Set `req.user.isAgent = true`.

WHY:

- Tooling/automation cần machine-to-machine auth đơn giản.
- Không cần login UI.
- Agent vẫn có `companyId` và `role` để query theo business scope.

## 6.4 RBAC

Role enum:

- `ADMIN`
- `MANAGER`
- `MEMBER`
- `VIEWER`

Backend helper:

```ts
app.requireRole("ADMIN", "MANAGER")
```

Nếu `req.user.isSuperAdmin = true`, bypass role check.

## 6.5 Multi-tenant scope

Data model có `companyId` ở user/project/task/backlog/automation. Business intent là user chỉ thao tác trong company của mình, trừ super admin.

Khi maintain endpoint, luôn hỏi:

- Query này có filter theo `req.user.companyId` chưa?
- Nếu là `isSuperAdmin`, có được xem cross-company không?
- Mutation có đảm bảo resource thuộc company của user không?
- Agent service user có companyId đúng chưa?

---

# 7. Business Flows

## 7.1 Project lifecycle

State machine trong `apps/api/src/lib/transitions.ts`:

```mermaid
stateDiagram-v2
  [*] --> PLANNED
  PLANNED --> IN_PROGRESS
  PLANNED --> CANCELLED
  IN_PROGRESS --> ON_HOLD
  IN_PROGRESS --> COMPLETED
  IN_PROGRESS --> CANCELLED
  ON_HOLD --> IN_PROGRESS
  ON_HOLD --> CANCELLED
  COMPLETED --> IN_PROGRESS: reopen ADMIN only
  CANCELLED --> IN_PROGRESS: reopen ADMIN only
```

WHY cần state machine:

- Tránh frontend tự update status tùy ý.
- Giữ audit/business logic nhất quán.
- Reopen completed/cancelled là hành vi nhạy cảm nên giới hạn ADMIN.

Endpoint:

```http
POST /api/v1/projects/:id/transition
```

## 7.2 Task lifecycle

```mermaid
stateDiagram-v2
  [*] --> TODO
  TODO --> IN_PROGRESS
  IN_PROGRESS --> TODO
  IN_PROGRESS --> REVIEW
  IN_PROGRESS --> DONE
  REVIEW --> IN_PROGRESS
  REVIEW --> DONE
  DONE --> IN_PROGRESS
  DONE --> REVIEW
```

Khi task thuộc milestone và status thay đổi, backend cần recompute milestone progress.

Endpoint:

```http
POST /api/v1/tasks/:id/transition
```

## 7.3 Backlog approval lifecycle

```mermaid
stateDiagram-v2
  [*] --> PENDING
  PENDING --> APPROVED
  PENDING --> REJECTED
  APPROVED --> PENDING: reset
  REJECTED --> PENDING: reset
```

Endpoints:

```http
POST /api/v1/backlogs/:id/approve
POST /api/v1/backlogs/:id/reject
POST /api/v1/backlogs/:id/reset
```

WHY approval quan trọng:

- Pending backlog chưa được tính vào actual cost.
- Approved backlog mới roll up vào task/project.
- Rejected backlog giữ lịch sử nhưng không ảnh hưởng cost.

## 7.4 Admin currency flow

File active trong IDE: `apps/api/src/modules/admin/currencies/routes.ts`.

Endpoints:

```http
GET    /api/v1/admin/currencies
POST   /api/v1/admin/currencies
PATCH  /api/v1/admin/currencies/:id
DELETE /api/v1/admin/currencies/:id
```

Behavior:

- Tất cả endpoint cần authenticated user.
- Create/update/delete cần role `ADMIN`.
- List trả `_count` số company/project đang dùng currency.

WHY currency là admin module:

- Currency ảnh hưởng estimate, budget, member rate, task/backlog cost.
- Nếu user thường tự sửa rate/symbol/code có thể làm sai báo cáo.
- Delete currency đang được reference có thể bị Prisma/DB reject tùy relation.

## 7.5 Meeting assistant flow

Business intent:

- Lưu transcript cuộc họp.
- Trích xuất summary/decisions/action items.
- Human approve/reject action items.
- Approved item có thể tạo task.

Data model:

- `Meeting`
- `MeetingActionItem`

Flow:

```mermaid
flowchart TD
  A[Transcript] --> B[Create Meeting]
  B --> C[Extract Action Items]
  C --> D[DRAFT items]
  D --> E{Human review}
  E -->|Approve| F[Create/Link Task]
  E -->|Reject| G[Mark REJECTED]
```

---

# 8. API Design & Request Lifecycle

## 8.1 Base path

Tất cả API chính nằm dưới:

```text
/api/v1
```

## 8.2 Response conventions

Thành công:

```json
{
  "data": {}
}
```

List có thể có `meta` tùy module:

```json
{
  "data": [],
  "meta": {
    "page": 1,
    "pageSize": 20,
    "total": 100
  }
}
```

Lỗi:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid input",
    "details": {}
  }
}
```

## 8.3 Error handling

`apps/api/src/plugins/errorHandler.ts` chuẩn hóa:

| Error | HTTP | Response code |
|---|---:|---|
| Zod validation | 400 | `VALIDATION_ERROR` |
| Prisma unique violation `P2002` | 409 | `CONFLICT` |
| Prisma not found `P2025` | 404 | `NOT_FOUND` |
| Unknown error | 500 or `statusCode` | `INTERNAL_ERROR` or `err.code` |

## 8.4 Main route map

| Module | Prefix | Mục đích |
|---|---|---|
| Auth | `/api/v1/auth` | register/login/refresh/logout |
| Users | `/api/v1` | `/me`, `/users`, public companies |
| Projects | `/api/v1/projects` | CRUD, transition, digest, weekly report |
| Tasks | `/api/v1/tasks` | CRUD, transition, overdue/stale/hygiene, blocker |
| Backlogs | `/api/v1/backlogs` | list/create/update/delete/approve/reject/reset |
| Members | `/api/v1/members` | project members and member rates |
| Rates | `/api/v1/rates` | update/delete rates |
| Milestones | `/api/v1/milestones` | by-project CRUD and recompute |
| Scopes | `/api/v1/scopes` | by-project CRUD and reorder |
| Tags | `/api/v1/tags` | CRUD tags |
| Customers | `/api/v1/customers` | CRUD customers |
| Dashboard | `/api/v1/dashboard` | KPIs and charts |
| Uploads | `/api/v1/uploads` | avatar upload |
| Admin Users | `/api/v1/admin/users` | user management |
| Admin Company | `/api/v1/admin/company` | company settings |
| Admin Currencies | `/api/v1/admin/currencies` | currency settings |
| Notifications | `/api/v1/notifications` | list/read/read-all |
| Agent | `/api/v1/agent` | audit, memory, follow-up, channel identity |
| Agent Report | `/api/v1/agent/report` | safe read-only report query |
| Agent Automations | `/api/v1/agent/automations` | DB-backed workflow schedule |
| Meetings | `/api/v1/meetings` | meeting/action item flow |

## 8.5 Validation strategy

WHY shared Zod schemas:

- Frontend form validation và backend validation dùng cùng rules.
- Giảm drift giữa UI và API.
- Typescript infer giúp code ít duplicated type.

Ví dụ pattern:

```ts
import { currencyCreateSchema } from "@bb-pm/shared";

app.post("/", {
  preHandler: [app.requireRole("ADMIN")],
  schema: { body: currencyCreateSchema },
}, async (req, reply) => {
  const c = await app.prisma.currency.create({ data: req.body as any });
  return reply.code(201).send({ data: c });
});
```

## 8.6 Health check

Endpoint:

```http
GET /api/v1/health
```

Behavior:

- Query `SELECT 1` để check DB.
- Nếu DB down -> HTTP 503, `status: degraded`.
- Nếu `REDIS_URL` có set thì ping Redis.
- Redis down không làm API unhealthy nếu DB vẫn ok.

---

# 9. Frontend Architecture

## 9.1 SPA routes

Defined in `apps/web/src/app/router.tsx`:

| Route | Page |
|---|---|
| `/login` | Login |
| `/register` | Register |
| `/dashboard` | Dashboard |
| `/projects` | Project list |
| `/projects/:id` | Project detail |
| `/tasks` | Task page/Kanban |
| `/backlogs` | Backlog page |
| `/profile` | Profile |
| `/settings/users` | Admin users |
| `/settings/company` | Company settings |
| `/settings/currencies` | Currency settings |
| `/settings/agent-audit` | Agent audit |
| `/tags` | Tags |
| `/customers` | Customers |

Protected routes require `accessToken` in Zustand auth store. Nếu không có token, route redirect về `/login`.

## 9.2 API client flow

`apps/web/src/lib/apiClient.ts`:

- Base URL: `VITE_API_BASE` hoặc `/api/v1`.
- Request interceptor thêm `Authorization: Bearer <accessToken>`.
- Response interceptor bắt `401`.
- Nếu có refresh token, gọi `/auth/refresh`.
- Update token trong store.
- Retry original request.
- Nếu refresh fail, clear auth store.

```mermaid
sequenceDiagram
  participant UI as React Query/Component
  participant Axios as apiClient
  participant API as API
  participant Store as Zustand Auth Store

  UI->>Axios: request
  Axios->>Store: read accessToken
  Axios->>API: Authorization Bearer token
  API-->>Axios: 401
  Axios->>Store: read refreshToken
  Axios->>API: POST /auth/refresh
  API-->>Axios: new tokens
  Axios->>Store: setTokens()
  Axios->>API: retry original request
  API-->>UI: data
```

## 9.3 State management

| State type | Library | Ví dụ |
|---|---|---|
| Server state | TanStack Query | projects, tasks, dashboard KPIs |
| Auth/session | Zustand | accessToken, refreshToken, user |
| UI theme | Zustand | theme store |
| Form state | React Hook Form | create/edit project/task/backlog |

WHY phân tách:

- Server state có lifecycle riêng: caching, invalidation, refetch.
- Auth/theme là client state nhỏ và global.
- Form state nên local theo modal/page để tránh state rò rỉ.

## 9.4 UI organization

- `components/AppShell.tsx`: layout shell cho protected app.
- `components/ui/*`: reusable UI primitives.
- `pages/*`: route-level components.
- `features/*/api.ts`: API functions theo domain.
- `i18n/vi.json`, `i18n/en.json`: localization resources.

## 9.5 Frontend coding principles

- Page không nên chứa quá nhiều API details; gọi qua `features/<domain>/api.ts`.
- Form nên dùng schema từ `@bb-pm/shared` nếu có.
- Sau mutation, invalidate query liên quan.
- Không hardcode role logic phức tạp chỉ ở frontend; backend vẫn phải enforce.
- UI có thể hide button theo role để UX tốt hơn, nhưng security nằm ở API.

---

# 10. Agent Runtime Layer

## 10.1 Agent API purpose

Agent layer giúp PM Operations Agent:

- Query dữ liệu PM để trả lời câu hỏi vận hành.
- Ghi audit log tool invocation.
- Tìm user qua channel identity.
- Theo dõi follow-up đã gửi và trạng thái reply.
- Lưu memory summary để lần sau có context.
- Chạy automation theo workflow/schedule.
- Hỗ trợ meeting transcript -> action item.

## 10.2 Agent auth

Header:

```http
X-Agent-Token: <AGENT_API_TOKEN>
```

Seed tạo service user:

```text
pm-agent@bluebolt.local
role: MANAGER
```

## 10.3 Audit log

Model: `AgentAuditLog`

Fields quan trọng:

- `tool`
- `argsJson`
- `resultJson`
- `errorMessage`
- `durationMs`
- `correlationId`
- `source`
- `createdAt`

WHY:

- Debug được agent đã gọi tool nào.
- Có trace theo `correlationId`.
- Có thể cleanup log cũ bằng retention endpoint.

## 10.4 Report query

Module `apps/api/src/modules/agent/report-query.ts` cung cấp:

- `GET /api/v1/agent/report/schema`
- `POST /api/v1/agent/report/query`

Intent:

- Cho agent chạy report SQL/read-only query một cách có guard.
- Tránh agent có quyền write tùy ý vào DB.

Khi maintain module này, ưu tiên:

- Whitelist schema/table/statement type.
- Timeout/limit kết quả.
- Không cho DDL/DML.

## 10.5 Follow-up flow

```mermaid
flowchart TD
  A[Agent phát hiện task cần hỏi] --> B[Resolve assignee channel identity]
  B --> C[Create AgentFollowUp]
  C --> D[External connector gửi message]
  D --> E[User reply]
  E --> F[Patch follow-up REPLIED]
  F --> G[Agent dùng reply cho next action]
```

---

# 11. Setup & Runbook

## 11.1 Requirements

- Docker + Docker Compose v2.
- Node.js `>=20`.
- pnpm `>=9`.
- PostgreSQL client optional nếu muốn query thủ công.

## 11.2 Environment setup

```bash
cd /home/bbsw/pm/bb-pm
cp .env.example .env
pnpm install
```

Các biến quan trọng:

| Env | Mục đích |
|---|---|
| `DATABASE_URL` | Prisma/Postgres connection |
| `JWT_SECRET` | JWT signing secret |
| `JWT_ACCESS_TTL` | Access token TTL |
| `JWT_REFRESH_TTL` | Refresh token TTL |
| `CORS_ORIGIN` | Allowed frontend origins |
| `API_PORT` | API listen/host port tùy mode |
| `POSTGRES_*` | Docker Postgres config |
| `REDIS_URL` | Optional Redis health/cache |
| `AGENT_API_TOKEN` | Machine auth token cho agent |
| `AGENT_USER_EMAIL` | Service user email |
| `UPLOAD_DIR` | Local upload folder |

## 11.3 Start database

```bash
docker compose up bb_pm_db -d
```

## 11.4 Apply migrations and seed

```bash
pnpm --filter @bb-pm/api prisma migrate deploy
pnpm --filter @bb-pm/api prisma db seed
```

Seed tạo:

- Currency `VND`, `USD`.
- Company `BlueBolt`.
- Admin: `admin@bluebolt.local` / `admin123`.
- Demo users: PM, dev1, dev2, viewer.
- Service user: `pm-agent@bluebolt.local`.
- Demo customers, tags, projects, milestones, members, rates, scopes, tasks, backlogs.

## 11.5 Run dev

Chạy API và web cùng lúc:

```bash
pnpm dev
```

Hoặc chạy riêng:

```bash
pnpm --filter @bb-pm/api dev
pnpm --filter @bb-pm/web dev
```

Default dev URLs:

- Web: `http://localhost:5173`
- API: `http://localhost:4000`
- DB: `localhost:5433`

## 11.6 Verify health

```bash
curl http://localhost:4000/api/v1/health
```

Expected:

```json
{
  "status": "ok",
  "checks": {
    "db": {
      "status": "ok"
    }
  }
}
```

## 11.7 Run full Docker stack

```bash
docker compose up -d --build
```

Check ports in `.env` and `docker-compose.yaml`. Current compose defaults:

- Web host: `${WEB_PORT:-6080}`
- API host: `${API_PORT:-4001}`
- DB host: `${POSTGRES_PORT:-5433}`

---

# 12. Development Workflow

## 12.1 Thêm một backend module mới

Ví dụ thêm `invoices`:

1. Cập nhật `apps/api/prisma/schema.prisma`.
2. Tạo migration:

   ```bash
   pnpm --filter @bb-pm/api prisma migrate dev --name add_invoices
   ```

3. Thêm shared schema nếu cần:

   ```text
   packages/shared/src/schemas/invoice.ts
   packages/shared/src/index.ts
   ```

4. Tạo route:

   ```text
   apps/api/src/modules/invoices/routes.ts
   ```

5. Register trong `apps/api/src/server.ts`:

   ```ts
   await app.register(invoicesRoutes, { prefix: "/api/v1/invoices" });
   ```

6. Thêm tests nếu có business rule/permission/rollup.

## 12.2 Thêm frontend page mới

1. Tạo API wrapper:

   ```text
   apps/web/src/features/invoices/api.ts
   ```

2. Tạo page/modal:

   ```text
   apps/web/src/pages/invoices/InvoicesPage.tsx
   ```

3. Register route trong `apps/web/src/app/router.tsx`.
4. Thêm navigation trong `AppShell` nếu cần.
5. Dùng React Query cho list/detail/mutation.
6. Dùng shared Zod schema cho form validation.

## 12.3 Khi nào cần recompute

Luôn kiểm tra recompute khi mutation ảnh hưởng:

| Mutation | Recompute cần cân nhắc |
|---|---|
| Create/update/delete backlog | Task totals, project totals |
| Approve/reject/reset backlog | Task totals, project totals |
| Create/delete task | Project counts, milestone progress |
| Task status transition | Milestone progress |
| Create/delete member | Project member count |
| Create/delete scope | Project scope count |
| Create/delete milestone | Project milestone count |

## 12.4 Coding standards

- Business rules phải nằm ở backend.
- Frontend chỉ tối ưu UX, không thay thế authorization.
- Dùng Zod schema cho body/query/params.
- Dùng Prisma transaction khi một flow cập nhật nhiều bảng liên quan.
- Không tính lại cost lịch sử từ live rate; dùng snapshot.
- Response nên theo `{ data }` hoặc `{ data, meta }`.
- Error nên có `error.code` ổn định để UI/agent xử lý.
- Không thêm dependency mới nếu pattern hiện tại đủ dùng.

---

# 13. Testing Strategy

## 13.1 Commands

Root:

```bash
pnpm test
pnpm lint
pnpm build
```

API:

```bash
pnpm --filter @bb-pm/api test
pnpm --filter @bb-pm/api test:watch
pnpm --filter @bb-pm/api lint
```

Web:

```bash
pnpm --filter @bb-pm/web test
pnpm --filter @bb-pm/web lint
pnpm --filter @bb-pm/web build
```

## 13.2 Current tests observed

API e2e tests:

- `apps/api/tests/e2e/audit.spec.ts`
- `apps/api/tests/e2e/tasks-agent.spec.ts`
- `apps/api/tests/e2e/follow-ups.spec.ts`

API tests use test DB:

```text
postgres://bbpm_test:bbpm_test_pwd@localhost:5434/bb_pm_test
```

See `docker-compose.test.yaml`.

## 13.3 What to test for new work

High priority:

- Auth/permission boundary.
- Multi-company filtering.
- State transition invalid/valid cases.
- Cost recompute accuracy.
- Backlog approval idempotency/edge cases.
- Agent token vs JWT behavior.

Medium priority:

- Pagination/filter/sort.
- UI form validation.
- Query invalidation after mutation.
- Error state rendering.

---

# 14. Deployment & Operations

## 14.1 Production build

```bash
pnpm build
```

Or Docker:

```bash
docker compose up -d --build
```

## 14.2 Migration deployment

Production should run:

```bash
pnpm --filter @bb-pm/api prisma migrate deploy
```

Do not use `migrate dev` in production.

## 14.3 Health and logs

Health:

```bash
curl http://localhost:<api-port>/api/v1/health
```

Logs:

```bash
docker compose logs -f bb_pm_api
docker compose logs -f bb_pm_web
docker compose logs -f bb_pm_db
```

## 14.4 Security notes

- Đổi `JWT_SECRET` trên mọi môi trường thật.
- Đổi default admin password sau seed.
- Set `AGENT_API_TOKEN` đủ mạnh nếu bật agent.
- Không expose DB ra public network.
- Cấu hình CORS chặt theo frontend origin thật.
- Review upload constraints nếu mở rộng file upload ngoài avatar.

## 14.5 Backup notes

Postgres là source of truth. Cần backup:

- DB volume `bb_pm_pgdata`.
- Upload directory nếu dùng local uploads.
- `.env` không commit, nhưng cần lưu secret trong secret manager/password vault.

---

# 15. Troubleshooting

| Triệu chứng | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| `ECONNREFUSED 127.0.0.1:5433` | DB chưa chạy | `docker compose up bb_pm_db -d` |
| Prisma client outdated | Schema/migration mới chưa generate | `pnpm --filter @bb-pm/api prisma generate` |
| Login fail default admin | Chưa seed hoặc DB khác | chạy migrate + seed, kiểm tra `DATABASE_URL` |
| CORS error | Origin frontend không nằm trong `CORS_ORIGIN` | cập nhật `.env` |
| API 401 liên tục | Access token hết hạn, refresh fail | login lại, kiểm tra refresh token store |
| Agent 401 | Sai `X-Agent-Token` | đồng bộ `AGENT_API_TOKEN` giữa API và tool |
| Agent 503 missing user | Chưa seed service user | chạy `pnpm --filter @bb-pm/api prisma db seed` |
| Docker web không gọi được API | Sai `VITE_API_BASE` hoặc port mapping | kiểm tra build arg và nginx/proxy config |
| Currency delete fail | Currency đang được reference | chuyển company/project/task sang currency khác trước |

---

# 16. Maintenance Notes

## 16.1 Technical debt cần để ý

- Một số doc cũ có thể lệch port Docker actual. Khi thay compose/env, update docs cùng PR.
- Multi-company scope cần audit định kỳ trên endpoints mới.
- Some route handlers dùng `req.body as any`; shared schema giảm rủi ro nhưng vẫn nên type tốt hơn khi refactor.
- Agent integration đang mở rộng nhanh; cần giữ audit/permission/report-query guard chặt.
- Redis có trong compose nhưng API core chưa phụ thuộc cứng; tránh viết code khiến Redis down làm web traffic chết nếu không thật sự cần.

## 16.2 Checklist review PR backend

- Endpoint có auth chưa?
- Role check có đúng business không?
- Query có scope company không?
- Body/query/params có Zod validation không?
- Mutation có transaction nếu update nhiều bảng không?
- Có recompute rollup nếu cần không?
- Error code có ổn định không?
- Tests có cover happy path và forbidden/invalid path không?

## 16.3 Checklist review PR frontend

- API wrapper nằm trong `features/<domain>/api.ts` chưa?
- Form có validation chưa?
- Mutation có invalidate query liên quan chưa?
- Button/action có hide/disable theo role để UX tốt chưa?
- Error/loading/empty state có rõ không?
- Text có i18n nếu page hiện dùng i18n không?
- Không hardcode API base URL.

## 16.4 Nguyên tắc kiến trúc dài hạn

Giữ BB-PM là modular monolith cho đến khi có lý do thật sự để tách service. Dấu hiệu có thể cân nhắc tách:

- Agent workload long-running ảnh hưởng latency web/API.
- Report query cần tài nguyên riêng.
- Notification/follow-up cần retry queue và delivery tracking phức tạp.
- Upload/file processing vượt khỏi avatar đơn giản.

Trước khi tách microservice, nên ưu tiên:

- Tách module rõ hơn trong codebase.
- Thêm service layer cho business logic phức tạp.
- Thêm tests cho contract quan trọng.
- Thêm observability theo request id/correlation id.

---

# 17. Python Agent Service — Deep Dive

> Section này thay thế hoàn toàn tài liệu "bb-pm-tools Deep Dive" và "OpenClaw Integration"
> cũ. Từ 2026-05, PM Agent đã được **port sang một service Python độc lập** (`agent/`),
> bỏ hoàn toàn OpenClaw và 3 plugin TypeScript. Section này mô tả **từng module, từng file,
> từng hàm và biến quan trọng** để đọc hiểu codebase `agent/`.

## 17.1 Tổng quan

`agent/` là một **FastAPI service** chạy độc lập (1 process Python, 1 uvicorn worker),
thay cho OpenClaw gateway + plugin `bb-pm-tools` + `gapo-agent`. Nó:

- Nhận webhook GapoWork tại `POST /api/plugins/gapo-agent/webhook`.
- Định tuyến mỗi turn chat qua pipeline nhiều tầng (check-in → action → fast-path → NL-to-SQL).
- Gọi `bb-pm API` (header `X-Agent-Token`) cho mọi nghiệp vụ — không chạm Postgres trực tiếp.
- Gửi tin trả lời qua Gapo Bot API.
- Chạy cron workflow (digest, reminder, automation) bằng APScheduler.

Nguyên tắc kiến trúc: **ranh giới module rõ ràng** — `channel/` (adapter Gapo) tách khỏi
`orchestrator/` (pipeline); hai bên gọi nhau bằng function call trong cùng process (không
còn HTTP inter-plugin như thời OpenClaw).

Stack: FastAPI + uvicorn, httpx (async HTTP), Pydantic v2, APScheduler (cron), redis-py
(async), tenacity (retry LLM).

## 17.2 Luồng tổng thể của một turn

```
GapoWork → POST /api/plugins/gapo-agent/webhook
  → routes_gapo.gapo_webhook()              (app/api/routes_gapo.py)
  → GapoHandler.handle_webhook()            (channel/gapo/handler.py)
       ├─ normalize_gapo_payload()          (channel/gapo/normalizer.py)
       ├─ event dedup (5 phút)
       ├─ should_process filter
       └─ container.run_turn(TurnRequest)   (core/deps.py)
            → Orchestrator.handle()         (orchestrator/pipeline.py)
                 1. rate-limit              (orchestrator/rate_limit.py)
                 2. dedup re-send           (orchestrator/dedup.py)
                 3. resolve caller          (orchestrator/caller_cache.py)
                 4. CheckinService.handle_turn()   (checkin/service.py)
                 5. ActionRouter.handle()          (routing/action_router.py)
                 6. FastPathRouter.try_fast_path() (routing/fast_path/router.py)
                 7. ReadRouter.try_read()          (routing/read_router.py → NL-to-SQL)
                 8. no_match fallback
            ← TurnReply
  → GapoHandler._deliver() → GapoClient.send() → Gapo Bot API
```

Mỗi tầng 4–8 trả `None` nếu không xử lý → pipeline rơi xuống tầng kế tiếp. Tầng nào trả
kết quả thì dừng.

---

## 17.3 `core/` — cấu hình, log, DI

### `core/config.py`

Tải toàn bộ cấu hình từ environment (có nạp `.env` nếu có). Thay thế cơ chế nạp env
per-plugin của OpenClaw.

**Hàm helper đọc env:**

| Hàm | Mô tả |
|---|---|
| `_env(*names, default="")` | Trả giá trị env đầu tiên không rỗng trong danh sách `names` |
| `_int(*names, default)` | Như `_env` nhưng ép `int`, lỗi → `default` |
| `_float(*names, default)` | Như `_env` nhưng ép `float` |
| `_bool(*names, default=False)` | True nếu giá trị ∈ `{1,true,yes,on}` |

**Hằng:** `LLM_PROVIDERS = ("default", "gemini", "openrouter", "9router")`.

**Pydantic models (cấu trúc cấu hình):**

| Model | Field chính |
|---|---|
| `LlmProviderConfig` | `base_url, api_key, model, max_tokens, temperature` |
| `LlmConfig` | `requested_provider, active_provider, providers: dict`; property `.active` trả `LlmProviderConfig` đang dùng |
| `BbPmConfig` | `base_url, agent_token` |
| `GapoConfig` | `api_url, bot_token, bot_id, auth_header, auth_prefix, dry_run, send_token, webhook_path, send_path` |
| `RedisConfig` | `url, follow_up_cooldown_sec` |
| `RateLimitConfig` | `max_per_window` (30), `window_sec` (60) |
| `ConcurrencyConfig` | `max_concurrent` (16), `max_queue` (30), `acquire_timeout_ms` (60000) |
| `CronJob` | `schedule, target` |
| `CronConfig` | `timezone, daily_digest, weekly_hygiene, noon_checkin, eod_checkin, missing_checkin_followup, checkin_enabled, audit_retention_days, audit_cleanup_schedule, automation_poll_sec` |
| `Settings` | gộp tất cả + `admin_alert_target, checkin_session_ttl_sec, dedup_ttl_sec, caller_cache_ttl_sec, action_pending_ttl_sec, port, io_log_enabled, io_log_max_chars` |

**Hàm:**

- `_llm_config()` — dựng `LlmConfig` cho 4 provider; `9router` đọc cả `9ROUTER_*` lẫn `NINE_ROUTER_*`.
- `load_settings()` — dựng `Settings` đầy đủ từ env. Chú ý: các TTL trong env tính bằng **ms**, được chia 1000 thành **giây**.
- `assert_config(settings) -> list[str]` — trả danh sách key thiếu/sai (cảnh báo, không fatal): `LLM_PROVIDER` hợp lệ, `BB_PM_AGENT_TOKEN`, API key của provider, `GAPO_SEND_TOKEN` nếu cron bật.

**Biến module:** `settings = load_settings()` — singleton dùng toàn project.

### `core/logging.py`

Log JSON một dòng, có cắt ngắn — thay `channelLog`/`webhookLog` của bản TS.

| Thành phần | Mô tả |
|---|---|
| `_LOGGER` | `logging.Logger("pm_agent")` |
| `configure_logging(level="INFO")` | Gắn `StreamHandler` ra stdout, format `%(message)s` |
| `_truncate(value, max_chars)` | Cắt chuỗi, thêm `…[truncated N chars]` |
| `log_event(event, level="info", **fields)` | Xuất 1 dòng JSON `{ts, event, ...fields}`, cắt theo `io_log_max_chars` |
| `log_io(event, **fields)` | Như `log_event` nhưng bị tắt nếu `io_log_enabled=False` |

### `core/deps.py`

DI container — các singleton dựng 1 lần lúc startup.

**Class `Container`** — thuộc tính: `bbpm, llm, gapo_client, gapo_handler, catalog, checkin, orchestrator, registry, scheduler, redis`.

| Method | Mô tả |
|---|---|
| `run_turn(request: TurnRequest) -> TurnReply` | Entry point channel-agnostic; uỷ thác `orchestrator.handle()`; trả thông báo tạm nếu orchestrator chưa sẵn sàng |
| `startup()` | Dựng tuần tự: `BbPmClient`, `LlmClient`, `ToolCatalog`, `CheckinService`, `FastPathRouter`, `ActionRouter`, `NlToSqlTranslator`, `ReadRouter`, `Orchestrator`, `GapoClient`, `GapoHandler`; connect Redis; dựng `WorkflowRegistry` + `AgentScheduler` rồi `scheduler.start()` |
| `shutdown()` | Dừng scheduler, đóng các client + Redis |

**Biến module:** `container = Container()`.

---

## 17.4 `infrastructure/` — client ngoài

### `infrastructure/bbpm_client.py`

Client gọi bb-pm API. Mọi đọc/ghi nghiệp vụ đi qua đây — agent không chạm Postgres.

- `_params(**kwargs)` — bỏ các giá trị `None` để query param tuỳ chọn không bị gửi.
- `BbPmApiError(status, body)` — exception khi API trả ≥ 400.
- `BbPmClient`:
  - `__init__` — tạo `httpx.AsyncClient` base_url = `settings.bb_pm.base_url`, header `X-Agent-Token`.
  - `request(method, path, **kwargs)` — gọi HTTP, raise `BbPmApiError` nếu ≥ 400, trả JSON envelope.
  - `_data(method, path, **kwargs)` — như `request` nhưng trả thẳng `data` trong envelope `{success, data}`.
  - **~45 method nghiệp vụ** (mỗi method gói 1 endpoint bb-pm API):

| Nhóm | Method |
|---|---|
| Tasks | `list_tasks, get_task, list_overdue_tasks, list_stale_tasks, check_hygiene, transition_task, create_task, patch_task, create_blocker` |
| Projects | `get_project, list_projects, create_project, patch_project, digest, weekly_report` |
| Users | `list_users, users_workload, user_by_channel, gapo_thread` |
| Digest | `role_based_digest` |
| Audit | `post_audit, cleanup_audit` |
| Automation | `list_automations, create_automation, patch_automation, delete_automation` |
| Check-in | `import_checkin, update_checkin, checkin_projects, checkin_status, missing_checkins, project_daily_summary` |
| Check-in session | `start_checkin_session, current_checkin_session, patch_checkin_session, complete_checkin_session` |
| Memory | `post_memory, search_memory` |
| Follow-up | `post_follow_up, list_follow_ups, patch_follow_up` |
| Channel identity | `channel_identity, upsert_channel_identity` |
| Reporting | `report_schema, report_query` |

### `infrastructure/llm_client.py`

Client LLM OpenAI-compatible đa provider.

| Thành phần | Mô tả |
|---|---|
| `LlmTransientError` | Lỗi tạm thời, được retry (5xx, mất kết nối) |
| `LlmError` | Lỗi không retry (4xx, response sai định dạng) |
| `ChatResponse` | Slots: `content, tool_calls, finish_reason, usage, latency_ms, provider, model` |
| `_RETRYABLE` | Tuple exception được retry: `ConnectError, ConnectTimeout, ReadTimeout, RemoteProtocolError, LlmTransientError` |
| `LlmClient._client(provider, cfg)` | Tạo/cache `httpx.AsyncClient` cho từng provider, timeout 330s |
| `LlmClient.chat(messages, tools=None, *, provider, max_tokens, temperature, response_format)` | Hàm chính — dựng body, gọi `_chat_with_retry` |
| `LlmClient._chat_with_retry(...)` | Bọc `@tenacity.retry` (3 lần, backoff luỹ thừa); 5xx → `LlmTransientError`, 4xx → `LlmError` |
| `LlmClient.close()` | Đóng mọi httpx client |

### `infrastructure/redis.py`

Wrapper Redis async. Nếu `REDIS_URL` rỗng hoặc không kết nối được → `client = None`,
caller tự fallback in-memory.

- `RedisClient(url)`: property `client` (Optional), `available` (bool); `connect()` ping thử; `close()`.
- Biến module: `redis_client = RedisClient(settings.redis.url)`.

---

## 17.5 `shared/` — kiểu dùng chung & text

### `shared/types.py` — contract channel ↔ orchestrator

Orchestrator **không import** package channel; channel tự dịch payload sang/từ các kiểu này.

| Model | Field |
|---|---|
| `ReplyOption` | `title, payload` |
| `ReplyBody` | `kind: "text"|"quick_replies", text, options: list[ReplyOption]` |
| `TurnRequest` | `text, source, conversation_id, external_id, correlation_id, event_type, metadata, skip_channel_ack, caller_user_id` |
| `TurnReply` | `reply, channel_reply, request_id, pattern, mode, dedup, silent` |

`TurnSource = Literal["chat", "cron", "cli", "eval"]`.

### `shared/text.py` — helper tiếng Việt

| Hàm | Mô tả |
|---|---|
| `normalize(text)` | Lowercase, bỏ dấu (NFD + xoá combining marks), `đ→d`, gộp về chữ-số. Dùng cho fuzzy match tên/lệnh |
| `nfc(text)` | Chuẩn hoá NFC (Gapo có thể gửi NFD) |
| `strip_markdown_for_gapo(text)` | Bỏ marker markdown Gapo không render (`**bold**`, `` `code` ``, fenced block, header, `#123`); giữ `*italic*` |

---

## 17.6 `channel/` — adapter GapoWork

### `channel/base.py`

- `TurnHandler` — type alias `Callable[[TurnRequest], Awaitable[TurnReply]]`.
- `ChannelAdapter` — Protocol để mở đường thêm Slack/Telegram sau này.

### `channel/gapo/models.py`

| Model | Mô tả |
|---|---|
| `Mention` | `target, length, offset` |
| `GapoNormalizedEvent` | Payload Gapo đã chuẩn hoá: `event_type, text, conversation_id, external_id, from_user_id, thread_id, to_bot_id, message_id, message_type, payload, mentions, is_group_message, sender_name, correlation_id, should_process` |
| `QuickReplyOption` | `title, payload` |
| `TextBody` | `type="text", text, is_markdown_text` |
| `QuickRepliesBody` | `type="quick_replies", text, options`; method `to_gapo()` dựng dict đúng format Gapo |
| `GapoSendResult` | `sent, conversation_id, response, status_code, message` |

### `channel/gapo/normalizer.py`

Chuẩn hoá payload webhook Gapo. Port nguyên `gapo-agent/src/normalizer.ts`.

| Hàm | Mô tả |
|---|---|
| `dig(value, *keys)` | Truy cập lồng nhau an toàn |
| `first_string(*values)` | Trả chuỗi/số đầu tiên không rỗng |
| `strip_gapo_prefix(value)` | Bỏ tiền tố `gapo:` |
| `ensure_gapo_prefix(value)` | Thêm `gapo:` nếu thiếu |
| `_normalize_mentions(value)` | Parse mảng mention |
| `normalize_gapo_payload(payload) -> GapoNormalizedEvent` | Hàm chính |

**`should_process`** = True khi: `event_type` rỗng hoặc `message_created`; `message_type` ∈ `{text, quick_reply, menu}`; nếu là group message thì phải có lệnh `/` hoặc @mention bot hoặc type `quick_reply/menu`; và text không rỗng. Hằng `_PROCESSABLE_TYPES = {"text","quick_reply","menu"}`.

### `channel/gapo/client.py`

Gửi tin qua Gapo Bot API.

| Hàm | Mô tả |
|---|---|
| `build_text_body(text)` | Dựng `TextBody` |
| `build_quick_replies_body(text, options)` | Dựng `QuickRepliesBody` |
| `build_mention_text_body(text, mention_name, target_user_id)` | Dựng text có mention |
| `build_quick_reply_fallback_text(body)` | Text dạng số khi channel không render được nút |
| `parse_conversation_target(value)` | `dm:<id>`→`{receiver_id}`, `collab:<id>`→`{collab_id}`, còn lại→`{thread_id}` |
| `GapoClient.build_request(conversation_id, body)` | Dựng body request gửi Gapo (kèm `bot_id`) |
| `GapoClient.send(conversation_id, body=None, *, text="")` | Gửi tin; nếu `GAPO_DRY_RUN=true` chỉ log không gọi API thật |

### `channel/gapo/handler.py`

`GapoHandler` — xử lý webhook + gửi tin. Thay `gapo-agent/src/index.ts`.

Hằng `_EVENT_DEDUP_TTL_SEC = 300` (dedup event 5 phút).

| Method | Mô tả |
|---|---|
| `__init__(client, turn_handler)` | Lưu `GapoClient` + callback orchestrator; khởi tạo `counters` |
| `_is_duplicate_event(event_id)` | Dedup theo `payload["id"]`, TTL 5 phút |
| `handle_webhook(payload) -> dict` | Normalize → dedup → `should_process` → gọi `turn_handler` → `_deliver` |
| `_to_turn_request(ev)` | Dịch `GapoNormalizedEvent` → `TurnRequest` |
| `_deliver(normalized, reply)` | Dựng outbound body từ `TurnReply`, gửi; nếu quick_replies fail → fallback text |
| `handle_send(conversation_id, text, body=None)` | Cho route `/send` (workflow gửi chủ động) |
| `health()` | Trả `counters` |
| `_reply_to_body(reply)` (hàm module) | `TurnReply` → `TextBody`/`QuickRepliesBody` |

`counters`: `webhook_received, webhook_processed, webhook_ignored, webhook_failed, send_succeeded, send_failed`.

---

## 17.7 `orchestrator/` — pipeline & hạ tầng

### `orchestrator/pipeline.py`

`Orchestrator` — định tuyến 1 turn. Port `bb-pm-tools/src/webhook.ts`.

| Thành phần | Mô tả |
|---|---|
| `_SLASH`, `_CHECKIN_CMD` | Regex nhận diện slash command / lệnh check-in |
| `_NO_MATCH` | Câu trả lời mặc định khi không tầng nào bắt |
| `Orchestrator.handle(request) -> TurnReply` | Chạy pipeline 8 bước (xem 17.2) |
| `Orchestrator._done(...)` | Đóng gói `TurnReply`, ghi telemetry, strip markdown |

Thứ tự: rate-limit (chat) → dedup (chat, non-slash) → resolve caller → check-in (nếu là lệnh check-in hoặc không phải slash) → action → fast-path → NL-read → no_match.

### Các module hạ tầng

| File | Thành phần chính |
|---|---|
| `rate_limit.py` | `RateLimitResult`; `check_rate_limit(key)` — token-bucket fixed-window, Redis hoặc `_memory_incr` in-mem; key `cid:`/`conv:` |
| `dedup.py` | `check_duplicate(conversation_id, text)` — sha256(conv+text), TTL `settings.dedup_ttl_sec`, dict in-mem có lazy GC |
| `concurrency.py` | `_Metrics`; `acquire_slot()` — async context manager bọc `asyncio.Semaphore(max_concurrent)`; `get_metrics()` |
| `caller_cache.py` | `resolve_caller(bbpm, external_id, thread_id)` — cache Gapo id → bb-pm user, TTL `caller_cache_ttl_sec` |
| `cooldown.py` | `is_on_cooldown(scope)`, `set_cooldown(scope, ttl_sec)` — Redis, fallback in-mem |
| `telemetry.py` | `record_run(mode, total_ms)`, `snapshot()` — counter theo mode |

---

## 17.8 `routing/` — fast-path, action, read

### `routing/fast_path/router.py`

`FastPathRouter` — slash command + pattern tiếng Việt, không gọi LLM (chỉ query DB).

- `HELP_TEXT`, `BLOCKER_HELP` — text tĩnh.
- `_slash: dict` — map lệnh `/help /mytasks /overdue /stale /blocked /projects /digest /report /weekly /automations` → handler.
- `_patterns: list[(regex, handler)]` — ~10 pattern tiếng Việt (task quá hạn, task stale, digest, weekly, task của tôi, danh sách dự án, data hygiene, automation, tình hình dự án X, task của [người]).
- `try_fast_path(text, ctx) -> (reply, pattern) | None` — match slash trước, rồi pattern.

### `routing/action_router.py`

`ActionRouter` — thao tác ghi bằng ngôn ngữ tự nhiên, có bước xác nhận. State `action-pending` lưu Redis (TTL `action_pending_ttl_sec`), fallback in-mem.

| Thành phần | Mô tả |
|---|---|
| `_CONFIRM`, `_CANCEL` | Regex nhận "ok"/"hủy" |
| `_RE_DEADLINE, _RE_STATUS, _RE_CREATE_TASK` | Regex phát hiện ý định |
| `handle(text, ctx)` | Nếu có pending: confirm→execute, cancel→huỷ; nếu không: `_detect` → lưu pending → trả preview |
| `_detect(text)` | Trả `(action, preview)` cho 3 loại: đổi deadline, đổi status, tạo task |
| `_execute(action)` | Gọi `ToolCatalog` thực thi |
| `_get/_set/_clear_pending` | Quản lý pending state |
| `_resolve_status(raw)` (hàm module) | Map từ khoá → `TaskStatus` |

### `routing/read_router.py`

| Thành phần | Mô tả |
|---|---|
| `classify_read_turn(text) -> "read"|"action"|"ambiguous"|"other"` | Phân loại bằng marker (action verb, read verb, entity, status, ranking, question) |
| `ReadRouter.try_read(text, ctx, company_id)` | Nếu `ambiguous` → hỏi lại; nếu `read` → gọi `NlToSqlTranslator.run()` |

---

## 17.9 `checkin/` — state machine check-in

### `checkin/models.py`

`ParsedBlocker` (`description, severity`), `ParsedCheckin` (`work_date, summary, hours, status, blocker, task_hint, needs_clarification, clarification_question`), `CheckinTurnResult` (`reply, channel_reply, pattern`).

### `checkin/parser.py`

Parse nội dung worklog: gọi LLM (temp 0) + regex fallback. Port `parseCheckin` từ TS.

| Hàm | Mô tả |
|---|---|
| `parse_checkin(text, llm) -> (ParsedCheckin, used_llm)` | Hàm chính; lỗi LLM → fallback regex |
| `regex_fallback(text)` | Trích giờ/status/blocker bằng regex |
| `extract_hours(text)` | Nhiều pattern: "2h30p", "nửa giờ", "9h-11h", "từ 9h đến bây giờ" |
| `_relative_now_range / has_relative_now_range` | Parse khoảng "từ Xh đến bây giờ" theo giờ HCM |
| `_to_minutes, _hanoi_minutes` | Helper thời gian, timezone `Asia/Ho_Chi_Minh` |
| `_normalize_parsed(payload, fallback)` | Hợp nhất output LLM với fallback |

### `checkin/service.py`

`CheckinService` — state machine. State: `IDLE → AWAITING_PROJECT → AWAITING_UPDATE → (AWAITING_TASK_CONFIRM) → COMPLETED`. Session lưu qua bb-pm API (`checkin-sessions`).

| Method | Mô tả |
|---|---|
| `handle_turn(text, ctx) -> CheckinTurnResult | None` | Entry point; nhận diện lệnh start/edit/cancel, payload quick-reply, rồi rẽ theo state |
| `build_project_selection_reply(user_id)` | Dựng `ReplyBody` quick_replies (top 3 project) — cũng dùng cho workflow reminder |
| `_start_session / _ensure_session / _get_session` | Vòng đời session |
| `_select_project` | Chốt project → state `AWAITING_UPDATE` |
| `_complete_with_project / _complete_with_task` | Tạo backlog (`import_checkin`), update status/blocker, đóng session |
| `_start_edit_session / _select_worklog_to_edit / _update_existing_worklog` | Luồng sửa worklog |
| `_list_user_projects / _list_project_tasks` | Truy vấn project/task của user |
| `_audit` | Ghi `agent_audit_log` |
| telemetry | `counters`, `telemetry_snapshot()`, `record_reminder_metric(kind)` |

Helper module: `_is_worklog_start, _is_worklog_edit, _is_cancel, _select_by_text, _expires_at_iso` (datetime hậu tố `Z`), `_is_expired`...

---

## 17.10 `reporting/nl_to_sql/translator.py`

`NlToSqlTranslator` — dịch câu hỏi tiếng Việt → SQL **chỉ đọc**.

| Thành phần | Mô tả |
|---|---|
| `validate_generated_sql(sql, company_id)` | Kiểm: chỉ `SELECT`, không DML/DDL, có scope `company_id` đúng |
| `extract_tables(sql)` | Trích tên bảng từ `FROM/JOIN` |
| `_base_rules(company_id, user_id)` | System prompt ràng buộc an toàn |
| `_parse_json_loose / _parse_sql_payload` | Parse output JSON của LLM (chịu được markdown fence) |
| `NlToSqlTranslator.run(question, company_id, user_id)` | Dịch → validate → `report_query` → repair 1 lần nếu lỗi → format |
| `_format_rows(result)` | Render kết quả ra text tiếng Việt |

Hằng `_SCOPED_TABLES` — danh sách bảng bắt buộc scope `company_id`.

---

## 17.11 `tools/` — catalog & format

### `tools/catalog.py`

`ToolCatalog` — gói các thao tác trên bb-pm API. **Query tool** trả text tiếng Việt; **action tool** trả dict.

| Loại | Method |
|---|---|
| Query | `my_tasks_today, deadlines_this_week, my_projects, overdue_tasks, stale_tasks, data_hygiene, daily_digest, weekly_report, list_projects, list_automations, project_snapshot, search_tasks, users_workload, person_tasks` |
| Action | `create_task, transition_task, patch_task, create_project` |

### `tools/format.py`

Render text tiếng Việt: `task_line, task_list, project_list, digest, weekly, hygiene`.

---

## 17.12 `workflows/` — workflow & scheduler

### `workflows/registry.py`

`WorkflowRegistry` — 7 workflow định kỳ. `WorkflowResult` (`ok, message, meta`), `WorkflowContext` (`source, target, correlation_id`).

| Workflow | Mô tả |
|---|---|
| `daily_digest` | Digest hôm nay → gửi `ctx.target` |
| `weekly_report` | Báo cáo tuần |
| `hygiene_check` | Quét data hygiene |
| `role_based_digest` | Digest theo role của 1 user |
| `noon_checkin_reminder` | Nhắc check-in giữa ngày |
| `eod_checkin_reminder` | Nhắc check-in cuối ngày |
| `missing_checkin_followup` | Follow-up ai chưa check-in |

`run(name, inputs, ctx)` dispatch tới `_wf_<name>`. `_run_reminder(kind, ctx)` xử lý 3 reminder: lấy `missing_checkins`, với mỗi user gửi picker project hoặc nhắc.

### `workflows/scheduler.py`

`AgentScheduler` — APScheduler `AsyncIOScheduler`, timezone `CRON_TZ`.

| Method | Mô tả |
|---|---|
| `start()` | Đăng ký: legacy env cron (digest/hygiene nếu có target), reminder cron (nếu `CRON_CHECKIN_ENABLED`), audit-cleanup cron, vòng poll automation |
| `_add_cron(...)` | Đăng ký 1 job cron |
| `_run_workflow / _run_audit_cleanup` | Thực thi job |
| `_sync_automations()` | Mỗi `automation_poll_sec` (mặc định 60s): đọc `/agent/automations`, register/unregister job; dead-man bỏ job ≥ 3 lần fail |
| `_run_db_automation(...)` | Chạy automation từ DB, patch `lastRun*` + `consecutiveFails` |

---

## 17.13 `app/` — FastAPI entrypoint & routes

### `app/main.py`

- `lifespan` — `configure_logging()`, `assert_config()`, `container.startup()`, … `container.shutdown()`.
- `app = FastAPI(...)` — mount 3 router.
- `GET /health` — kiểm `service`, `bb_pm_api`, `redis`; trả `status: ok|degraded`.

### `app/api/routes_agent.py` — `build_agent_router()`

| Route | Mô tả |
|---|---|
| `POST /api/plugins/bb-pm/agent/run` | Nhận `TurnRequest` JSON → `container.run_turn()` → `TurnReply` |
| `GET /api/plugins/bb-pm/agent/metrics` | telemetry + concurrency + checkin counters |
| `GET /api/plugins/bb-pm/health` | trạng thái orchestrator |

### `app/api/routes_gapo.py` — `build_gapo_router()`

| Route | Mô tả |
|---|---|
| `POST /api/plugins/gapo-agent/webhook` | Inbound Gapo — public, không token |
| `POST /api/plugins/gapo-agent/send` | Outbound chủ động — yêu cầu header `X-Plugin-Token` |
| `GET /api/plugins/gapo-agent/health` | counter của handler |

### `app/api/routes_debug.py` — `build_debug_router()`

`POST /debug/normalize-gapo` — trả `GapoNormalizedEvent` cho 1 payload (debug).

---

## 17.14 Bảng env variables quan trọng

| Env | Vai trò |
|---|---|
| `BB_PM_API_URL`, `BB_PM_AGENT_TOKEN` (alias `AGENT_API_TOKEN`) | Kết nối bb-pm API |
| `LLM_PROVIDER` | Provider active: `default|gemini|openrouter|9router` |
| `LLM_BASE_URL/API_KEY/MODEL/MAX_TOKENS/TEMPERATURE` | Provider `default` |
| `GEMINI_*`, `OPENROUTER_*`, `9ROUTER_*`/`NINE_ROUTER_*` | Provider thay thế |
| `GAPO_API_URL, GAPO_BOT_TOKEN, GAPO_BOT_ID` | Gapo Bot API |
| `GAPO_DRY_RUN` | `true` → không gửi tin thật |
| `GAPO_SEND_TOKEN` | Token bảo vệ route `/send` |
| `REDIS_URL` | Redis cho rate-limit/cooldown/action-pending |
| `CRON_TZ` | Timezone scheduler (`Asia/Ho_Chi_Minh`) |
| `CRON_CHECKIN_ENABLED` | Bật/tắt cron reminder |
| `CRON_NOON/EOD_CHECKIN, CRON_MISSING_CHECKIN_FOLLOWUP` | Lịch reminder |
| `CRON_DAILY_DIGEST(+_TARGET), CRON_WEEKLY_HYGIENE(+_TARGET)` | Cron legacy |
| `AUDIT_RETENTION_DAYS, AUDIT_CLEANUP_SCHEDULE` | Dọn audit log |
| `AGENT_RUN_MAX_PER_WINDOW, AGENT_RUN_WINDOW_SEC` | Rate-limit |
| `PM_AGENT_PORT` | Cổng HTTP (mặc định 8001) |

## 17.15 Build & chạy

```bash
# Local
cd agent && pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8001 --workers 1

# Docker (service pm_agent trong docker-compose.yaml)
docker compose build pm_agent
docker compose up -d pm_agent

# Test state machine check-in
python -m tests.test_checkin_sm
```

Lưu ý chạy **1 uvicorn worker** — `dedup`, `concurrency`, `caller_cache` giữ state in-process.

---

# 18. Channel Integration, Deployment & Testing

## 18.1 Từ OpenClaw sang Python service

Trước 2026-05, agent chạy dưới dạng OpenClaw gateway + 3 plugin TypeScript. Kiến trúc đó
đã bị **gỡ bỏ hoàn toàn**: `bb-pm-tools/`, `gapo-agent/`, `browser-tools/`, `docker/openclaw/`
đã xoá khỏi repo; service `openclaw` trong `docker-compose.yaml` được thay bằng `pm_agent`.

Lý do: OpenClaw là runtime bên thứ ba khó debug (plugin double-load làm scheduler chạy đôi),
build phức tạp. Service Python `agent/` kiểm soát hoàn toàn, đơn giản hơn.

`browser-tools` (gửi DM qua Playwright bằng tài khoản thật) bị bỏ — agent chỉ gửi tin qua
Gapo Bot API.

## 18.2 docker-compose topology

| Service | Port host:container | Vai trò |
|---|---|---|
| `bb_pm_db` | 5433:5432 | PostgreSQL 16 |
| `bb_pm_redis` | 6379:6379 | Redis 7 |
| `bb_pm_api` | 4000:4000 | Fastify API |
| `bb_pm_web` | 5173:80 | React SPA |
| `pm_agent` | 18789:8001 | **Python PM Agent** |

`pm_agent` giữ host port `18789` (trùng port OpenClaw cũ) để URL webhook public không phải
đổi. `depends_on`: `bb_pm_api`, `bb_pm_redis` (healthy). `extra_hosts: host.docker.internal`
để với tới LLM endpoint trên host/tailnet.

## 18.3 Gapo webhook

Bot GapoWork cấu hình **Outgoing webhook URL** trỏ tới:

```
https://<domain-public>/api/plugins/gapo-agent/webhook
```

`<domain-public>` qua reverse proxy → `host:18789` → `pm_agent:8001`. Path
`/api/plugins/gapo-agent/webhook` cố định trong code (`settings.gapo.webhook_path`).

Lưu ý: GapoWork **nuốt các slash command** (`/help`, `/checkin`...) thành menu lệnh built-in
của nó — chỉ forward webhook khi lệnh được khai báo trong cấu hình bot. Để khởi động luồng
check-in mà không vướng việc này, gõ **không dấu `/`** (vd `checkin`) — `_is_worklog_start`
trong `checkin/service.py` nhận cả dạng không slash.

## 18.4 Test cô lập với production

Bot production chạy source cũ trên server khác (webhook `open-claw.maximus-nhon.online`).
Để test `pm_agent` local **không ảnh hưởng production**:

1. Tạo **một bot Gapo test riêng** (token/id riêng) — bot production giữ nguyên webhook.
2. Tạo `.env.test` (sao `.env`, đổi `GAPO_BOT_TOKEN/ID` sang bot test, `CRON_CHECKIN_ENABLED=false`).
3. `docker compose --env-file .env.test up -d --force-recreate pm_agent`.
4. Expose `pm_agent` ra internet bằng tunnel tạm: `cloudflared tunnel --url http://localhost:18789`.
5. Đặt webhook bot test = URL tunnel + `/api/plugins/gapo-agent/webhook`.
6. Map danh tính người test vào `channel_identities` (DB local) để `/checkin` resolve được caller.

DB của `pm_agent` luôn là `bb_pm_db` local — cô lập hoàn toàn với DB production.

---

# 19. Daily Check-in Deep Dive

## 19.1 Mục tiêu UX

Bot nhắc nhân viên cập nhật worklog hằng ngày qua GapoWork. Người dùng gõ `checkin` → bot
hỏi project → người dùng chọn → gửi nội dung công việc → bot ghi nhận. Reminder tự động
lúc trưa / cuối ngày / sau giờ chốt.

## 19.2 State machine

Cài tại `checkin/service.py` (`CheckinService`). Session lưu qua bb-pm API
(`checkin_sessions`), TTL `CHECKIN_SESSION_TTL_MS` (mặc định 2h).

```
IDLE
 └─(gõ "checkin"/"/checkin"/"worklog")→ AWAITING_PROJECT
       ├─ chọn project đúng              → AWAITING_UPDATE
       └─ nhập sai tên                   → ở lại AWAITING_PROJECT, báo "chưa thấy project đó"
 AWAITING_UPDATE
       └─ gửi nội dung worklog → parse_checkin (LLM + regex fallback)
              ├─ needs_clarification     → hỏi lại, giữ state
              └─ ok                      → COMPLETED (tạo backlog GAPO_CHECKIN)
 AWAITING_TASK_CONFIRM   — chỉ dùng cho luồng sửa worklog (edit)
```

Lệnh `hủy` (hoặc payload `CANCEL_CHECKIN`) huỷ session bất kỳ lúc nào.

## 19.3 API contract (bb-pm)

| Endpoint | Dùng cho |
|---|---|
| `POST /agent/checkin-sessions/start` | Mở session |
| `GET /agent/checkin-sessions/current` | Lấy session hiện tại |
| `PATCH /agent/checkin-sessions/:id` | Cập nhật state/project |
| `POST /agent/checkin-sessions/:id/complete` | Đóng session |
| `POST /agent/checkins/import` | Tạo backlog `GAPO_CHECKIN` |
| `GET /agent/checkins/projects` | Project của user |
| `GET /agent/checkins/missing` | User chưa check-in (cho reminder) |

Lưu ý: trường datetime gửi lên bb-pm phải có hậu tố `Z` (validator Zod `.datetime()` từ
chối `+00:00`) — xem `_expires_at_iso()` trong `checkin/service.py`.

## 19.4 Reminder & cron

3 workflow reminder (`noon/eod/missing_checkin_followup`) trong `workflows/registry.py`,
lên lịch bởi `AgentScheduler` khi `CRON_CHECKIN_ENABLED=true`. `_run_reminder` lấy danh
sách user thiếu check-in, gửi picker project hoặc câu nhắc.

## 19.5 Failure modes & quan sát

| Hiện tượng | Nguyên nhân thường gặp |
|---|---|
| Bot trả "chưa nhận diện được tài khoản" | User chưa có `channel_identities` map Gapo id → bb-pm user |
| `/checkin` không phản hồi | GapoWork nuốt slash command — gõ `checkin` không dấu `/` |
| Bot trả câu lạc đề khi đang chọn project | (Đã sửa) trước đây nhập sai tên project làm văng khỏi luồng |
| Session "kẹt" | Session cũ chưa hết hạn — gõ `hủy` hoặc chờ TTL 2h |

Metrics từ `GET /api/plugins/bb-pm/agent/metrics` (khoá `checkin`): `sessions_started,
projects_selected, completed, parse_success, parse_fallback, reminders_sent, reminders_skipped`.
