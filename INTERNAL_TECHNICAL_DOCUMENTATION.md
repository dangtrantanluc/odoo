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
17. [bb-pm-tools Deep Dive](#17-bb-pm-tools-deep-dive)
18. [OpenClaw Integration Deep Dive](#18-openclaw-integration-deep-dive)
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

# 17. bb-pm-tools Deep Dive

## 17.1 bb-pm-tools là gì

`bb-pm-tools` là OpenClaw plugin đóng vai trò PM Agent orchestrator cho hệ thống BB-PM.

Nói ngắn gọn:

- `bb-pm` là source of truth và REST API.
- `bb-pm-tools` là brain/runtime của agent: nhận câu hỏi, gọi LLM, chọn tool, gọi API, audit, format reply, schedule workflow.
- `gapo-agent` hoặc channel adapter khác chỉ là lớp nhận/gửi message.
- OpenClaw là plugin host và HTTP gateway để các plugin giao tiếp.

WHY tách `bb-pm-tools` khỏi `bb-pm`:

- Agent runtime có latency, retry, LLM, prompt, rate limit, channel concerns khác hẳn CRUD API.
- BB-PM API cần ổn định, deterministic, dễ test.
- Agent có thể thay LLM/provider/prompt mà không migrate backend.
- Channel adapter có thể thay từ Gapo sang Slack/Telegram mà không đổi core PM domain.

## 17.2 Vị trí trong workspace

```text
/home/bbsw/pm/
├── bb-pm/              # Core React + Fastify + Prisma app
├── bb-pm-tools/        # OpenClaw plugin: PM agent orchestrator
└── openclaw/openclaw/  # OpenClaw gateway/plugin host + gapo-agent plugin
```

## 17.3 Package overview

`bb-pm-tools/package.json`:

| Field | Ý nghĩa |
|---|---|
| `name: @openclaw/bb-pm-tools` | Plugin package name |
| `main: dist/index.js` | Built plugin entry |
| `type: commonjs` | Plugin build output currently CommonJS |
| `openclaw.extensions` | OpenClaw loads `./dist/index.js` |

Main scripts:

```bash
pnpm build              # TypeScript compile
pnpm typecheck          # tsc --noEmit
pnpm cli "task nào quá hạn?"
pnpm bench              # LLM benchmark helper
pnpm eval               # eval runner
pnpm test               # formatter + pre-classifier tests
```

Key dependencies:

| Dependency | Vai trò |
|---|---|
| `node-fetch` | Call BB-PM API, LLM endpoint, plugin endpoints |
| `node-cron` | Legacy cron jobs + DB-backed automations |
| `ioredis` | Optional distributed cooldown/rate-limit state |
| `tsx` | Local CLI/test runner |

## 17.4 File map

```text
bb-pm-tools/src/
├── index.ts              # OpenClaw plugin entry, register HTTP routes
├── webhook.ts            # /agent/run, /agent/metrics, /health handlers
├── orchestrator.ts       # Main ReAct loop, prompt, memory, tool invocation
├── tools.ts              # Tool catalog + tool handlers
├── api-client.ts         # Typed-ish client to bb-pm API
├── llm.ts                # OpenAI-compatible chat client + retries
├── config.ts             # Env parsing
├── pre-classifier.ts     # Fast-path intent classifier
├── formatter.ts          # Chat reply formatter/cleanup
├── channel-out.ts        # Outbound to gapo-agent/browser-tools
├── memory.ts             # Recall + summarize conversation memory
├── scheduler.ts          # Cron, DB automation sync, audit cleanup
├── workflows/registry.ts # Named workflow registry
├── rate-limit.ts         # /agent/run rate limit
├── dedup.ts              # Duplicate message protection
├── concurrency.ts        # In-flight slot limiter
├── cooldown.ts           # Follow-up cooldown
├── redis.ts              # Redis adapter/fallback
├── meeting.ts            # Transcript -> meeting/action items
├── nl-to-sql.ts          # Natural language report query support
├── prompt-v2.ts          # New READ/ACTION/AUTOMATION prompt builder
└── types.ts              # AgentContext, trace types
```

## 17.5 Registered OpenClaw routes

`src/index.ts` registers three plugin-owned routes:

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/plugins/bb-pm/agent/run` | POST | plugin | Main channel-agnostic agent entry |
| `/api/plugins/bb-pm/agent/metrics` | GET | plugin | Runtime concurrency/counter metrics |
| `/api/plugins/bb-pm/health` | GET | plugin | Liveness/readiness check |

OpenClaw route registration:

```ts
api.registerHttpRoute({
  path: "/api/plugins/bb-pm/agent/run",
  auth: "plugin",
  match: "exact",
  handler: handleAgentRun,
});
```

WHY channel-agnostic `/agent/run`:

- Gapo, Slack, Telegram, CLI hoặc future adapters có thể gửi cùng một request shape.
- Orchestrator không cần biết inbound channel payload gốc.
- Channel plugin chỉ chịu trách nhiệm parse inbound và deliver outbound.

Request:

```json
{
  "text": "[GAPO_USER: Nguyen Van A] task nào quá hạn?",
  "conversationId": "gapo:123456",
  "correlationId": "gapo-123456-1715000000000",
  "source": "chat"
}
```

Response:

```json
{
  "reply": "Có 3 task quá hạn: WS-3 · API auth · QA checklist",
  "requestId": "req_xxx"
}
```

## 17.6 AgentContext

`src/types.ts`:

```ts
export type AgentContext = {
  source?: "chat" | "cron" | "cli" | "other" | "eval";
  correlationId?: string;
  conversationId?: string;
  callerUserId?: number;
  trace?: { toolCalls: AgentToolTrace[] };
};
```

Semantics:

| Field | Ý nghĩa |
|---|---|
| `source` | Nguồn chạy: chat/cron/cli/eval |
| `correlationId` | ID mỗi turn để nối audit/log |
| `conversationId` | ID ổn định theo thread, dùng memory/dedup |
| `callerUserId` | bb-pm user đã map từ Gapo conversation |
| `trace` | Dùng trong eval/tests để biết tool nào được gọi |

Convention quan trọng:

```text
conversationId = "gapo:<numeric_thread_id>"
```

Orchestrator dùng convention này để:

- Resolve caller từ `bb-pm` qua channel identity.
- Group memory theo conversation.
- Gửi quick acknowledgement về đúng Gapo thread nếu LLM chậm.

## 17.7 Request handling flow trong `webhook.ts`

```mermaid
flowchart TD
  A[POST /api/plugins/bb-pm/agent/run] --> B[Parse JSON body]
  B --> C[Validate text]
  C --> D[Generate/propagate requestId]
  D --> E[Rate limit by correlationId or IP]
  E --> F{Duplicate chat message?}
  F -- Yes --> G[Return empty reply silent=true]
  F -- No --> H{Check-in or action session?}
  H -- Yes --> I[Execute deterministic state machine]
  I --> J[Return reply]
  H -- No --> K{Fast-path possible?}
  K -- Yes --> L[Execute fast-path without LLM slot]
  L --> J
  K -- No --> M{Read query?}
  M -- Yes --> N[Text-to-SQL / report.query]
  N --> J
  M -- No --> O[Acquire concurrency slot]
  O --> P[runAgent ReAct]
  P --> Q[Format response]
  Q --> R[Strip markdown for Gapo]
  R --> J
```

Important operational decisions:

- Check-in/action sessions run before generic fast-path so follow-up turns like "ok" or a bare project name stay in the active workflow.
- Fast-path runs before concurrency slot because it does not need LLM.
- Duplicate chat messages return empty reply so channel watcher does not spam user.
- Concurrency limiter protects slow/self-hosted LLM from burst overload.
- Formatter is fail-safe: if formatting fails, raw reply is still returned.

## 17.8 Orchestrator flow

`src/orchestrator.ts` implements a ReAct/function-calling loop:

```mermaid
sequenceDiagram
  participant Ch as Channel Plugin
  participant Run as bb-pm-tools /agent/run
  participant Orch as runAgent
  participant LLM as LLM Provider
  participant Tool as Tool Handler
  participant API as bb-pm API
  participant Audit as agent_audit_log

  Ch->>Run: { text, conversationId, correlationId }
  Run->>Orch: runAgent(text, ctx)
  Orch->>API: resolve caller by Gapo cid
  Orch->>Orch: tryFastPath()
  Orch->>API: recall memory
  Orch->>LLM: chat(system prompt + tools)
  LLM-->>Orch: tool_calls
  Orch->>Tool: invokeTool(name,args)
  Tool->>API: HTTP X-Agent-Token
  API-->>Tool: data
  Orch->>Audit: postAudit(tool,args,result summary)
  Orch->>LLM: tool results
  LLM-->>Orch: final Vietnamese reply
  Orch->>API: summarize/store memory async
  Orch-->>Run: reply
  Run-->>Ch: { reply }
```

## 17.9 Prompt versions

Env:

```env
BB_PM_PROMPT_VERSION=v1
# or
BB_PM_PROMPT_VERSION=v2
```

Current behavior:

| Version | Description |
|---|---|
| `v1` | Large system prompt with detailed tool-specific operating rules |
| `v2` | Prompt builder with 3-mode dispatcher: READ, ACTION, AUTOMATION |

WHY keep both:

- v1 is stable and explicit for current workflows.
- v2 enables cleaner intent separation and can include schema docs.
- Rollout can be controlled by env without redeploying API.

## 17.10 Tool catalog

`src/tools.ts` exposes legacy tools and newer namespaced tools.

Observed tools include:

| Category | Tools |
|---|---|
| Read/observe | `list_overdue_tasks`, `list_stale_tasks`, `check_data_hygiene`, `generate_daily_digest`, `get_project_snapshot`, `list_blocked_tasks`, `generate_weekly_report` |
| Lookup/search | `find_project`, `find_task`, `find_user`, `search_tasks`, `search_projects`, `gapo.find_user` |
| Task actions | `task.create`, `task.update`, `task.report_blocker`, `tasks.bulk_update` |
| Legacy task actions | `get_task_owner`, `update_task_status`, `assign_task`, `create_action_item`, `post_blocker` |
| Project actions | `project.create`, `project.update`, legacy `create_project` |
| Messaging | `message.send`, `messages.broadcast`, legacy `send_follow_up`, `send_dm_to_gapo_user` |
| Follow-up | `list_pending_follow_ups`, `follow_up.update`, legacy `mark_follow_up_replied` |
| Meeting | `ingest_meeting`, `approve_meeting_items` |
| Reporting | `report.query`, `recall_memory` |
| Automation | `automation.create`, `automation.list`, `automation.delete`, `workflow.run` |

Maintainability note:

- Prefer namespaced tools for new prompt/workflow: `task.update`, `project.create`, `message.send`.
- Keep legacy tools until prompt/eval no longer depends on them.
- Do not remove a tool without checking prompt text, eval tests, and historical memory summaries.

## 17.11 Tool invocation and audit

Every tool call goes through `invokeTool()`:

1. Parse JSON arguments.
2. Find tool in `toolsByName`.
3. Execute handler.
4. Push trace if `ctx.trace` exists.
5. Fire-and-forget audit to BB-PM:

```http
POST /api/v1/agent/audit
X-Agent-Token: <BB_PM_AGENT_TOKEN>
```

Audit intentionally stores summarized result:

- Array -> `{ length }`
- Object -> key count
- Scalars -> raw value

WHY summarize:

- Avoid storing huge task lists.
- Reduce PII/data leakage in audit.
- Keep `agent_audit_log` small enough for retention cleanup.

## 17.12 LLM provider layer

`src/llm.ts` calls OpenAI-compatible `/chat/completions`.

Providers from `src/config.ts`:

| Provider | Env prefix | Default |
|---|---|---|
| `default` | `LLM_*` | `http://localhost:8000/v1`, model `gemma-4` |
| `gemini` | `GEMINI_*` | `gemini-2.5-flash` via OpenAI-compatible endpoint |
| `openrouter` | `OPENROUTER_*` | `openai/gpt-4o` |

Selection:

```env
LLM_PROVIDER=default
LLM_PROVIDER=gemini
LLM_PROVIDER=openrouter
```

Behavior:

- Adds `tools` and `tool_choice: auto` when tools are provided.
- Retries transient network/5xx LLM failures up to 2 times.
- Annotates response with latency/provider/model.

Important caveat:

Self-hosted models must expose OpenAI-compatible `tool_calls`. If the server returns only text with pseudo tool JSON, the orchestrator will not execute tools correctly.

## 17.13 Fast-path classifier

`src/pre-classifier.ts` handles common intents without LLM:

- End-session acknowledgements.
- "task của tôi".
- Role/status/count queries.
- Overdue/digest/weekly/list automation style queries.

WHY:

- LLM can take 60-180s under load.
- Many user messages are deterministic DB lookups.
- Fast-path avoids queue/concurrency slot.
- Better UX and lower cost.

Rule of thumb:

- Add fast-path only for high-confidence, deterministic, frequent queries.
- Do not fast-path ambiguous action commands that need confirmation.

## 17.14 Concurrency, rate limit, dedup

| Component | Purpose |
|---|---|
| `rate-limit.ts` | Limit `/agent/run` per correlation/IP window |
| `dedup.ts` | Stop duplicate messages from retries/resends |
| `concurrency.ts` | Cap in-flight LLM turns and queue depth |
| `cooldown.ts` | Avoid repeated follow-up pings |
| `redis.ts` | Redis-backed state when available, in-process fallback otherwise |

WHY these exist:

- Chat systems retry webhooks.
- Users resend when a bot is slow.
- Self-hosted LLM can be easily overloaded.
- Follow-up automation can accidentally ping the same user repeatedly.

## 17.15 Scheduler and automations

`src/scheduler.ts` supports three scheduling modes:

1. Legacy env cron jobs:
   - `CRON_DAILY_DIGEST`
   - `CRON_DAILY_DIGEST_TARGET`
   - `CRON_WEEKLY_HYGIENE`
   - `CRON_WEEKLY_HYGIENE_TARGET`

2. DB-backed automations from BB-PM `Automation` table:
   - Polls API every `AUTOMATION_POLL_MS` ms, default 60s.
   - Registers active rows dynamically.
   - Re-registers when schedule/workflow/target changes.
   - Stops jobs removed or disabled in DB.
   - Dead-man switch after 3 consecutive failures.

3. Audit retention cron:
   - `AUDIT_RETENTION_DAYS`, default 90.
   - `AUDIT_CLEANUP_SCHEDULE`, default `0 3 * * *`.

DB automation lifecycle:

```mermaid
flowchart TD
  A[BB-PM Automation row active=true] --> B[bb-pm-tools poll /agent/automations]
  B --> C[Register node-cron task]
  C --> D[Cron fires]
  D --> E[runWorkflow]
  E --> F{ok?}
  F -- yes --> G[Patch lastRunStatus=ok consecutiveFails=0]
  F -- no --> H[Patch lastRunStatus=error consecutiveFails+1]
  H --> I{fails >= 3?}
  I -- yes --> J[Dead-man skip/unregister]
```

## 17.16 Workflow registry

`src/workflows/registry.ts` contains named workflows:

| Workflow | Purpose |
|---|---|
| `daily_digest` | Fetch `/projects/digest`, format Vietnamese digest, send to target |
| `weekly_report` | Fetch `/projects/weekly-report`, format weekly report, send |
| `hygiene_check` | Fetch `/tasks/hygiene`, summarize data hygiene issues, send |

WHY workflows do not call LLM:

- Scheduled outputs should be deterministic.
- Cron should not fail because LLM is slow.
- Workflows are easier to test and reason about.
- Manual `workflow.run` can execute same logic as scheduler.

## 17.17 Memory

`src/memory.ts` provides:

- `recallMemoryContext()` before LLM prompt.
- `summarizeAndStore()` after reply, fire-and-forget.
- `recordRecentTurn()` in-memory recent context for immediate follow-up.

Storage is in BB-PM API/DB through `agent_memory`.

WHY:

- Agent can answer follow-up questions like "vụ đó sao rồi?".
- Conversation context can survive process restarts through DB summary.
- In-memory recent turn avoids race where DB summary has not been written yet.

## 17.18 Outbound channel strategy

`bb-pm-tools` should not hold direct Gapo credentials for normal outbound. It sends through `gapo-agent`:

```text
bb-pm-tools -> POST /api/plugins/gapo-agent/send -> Gapo API
```

Config:

```env
GAPO_SEND_URL=http://localhost:18789/api/plugins/gapo-agent/send
GAPO_SEND_TOKEN=<shared secret>
```

Fallback browser tools exist for DM discovery/opening:

```env
BROWSER_TOOLS_SEND_URL=http://localhost:18789/api/plugins/browser-tools/send-dm
BROWSER_TOOLS_FIND_URL=http://localhost:18789/api/plugins/browser-tools/find-user
BROWSER_TOOLS_FIND_AND_OPEN_DM_URL=http://localhost:18789/api/plugins/browser-tools/find-and-open-dm
BROWSER_TOOLS_TOKEN=<token>
```

## 17.19 Important env variables

| Env | Required | Purpose |
|---|---|---|
| `BB_PM_API_URL` | Yes | BB-PM API base, default `http://localhost:4000/api/v1` |
| `BB_PM_AGENT_TOKEN` | Yes | Sent as `X-Agent-Token` to BB-PM |
| `LLM_PROVIDER` | No | `default`, `gemini`, `openrouter` |
| `LLM_BASE_URL` | If default provider | OpenAI-compatible base |
| `LLM_API_KEY` | Depends | API key for default provider |
| `LLM_MODEL` | No | Default provider model |
| `GEMINI_API_KEY` | If provider gemini | Gemini auth |
| `OPENROUTER_API_KEY` | If provider openrouter | OpenRouter auth |
| `GAPO_SEND_URL` | For outbound | gapo-agent send endpoint |
| `GAPO_SEND_TOKEN` | For outbound/cron | Shared secret to gapo-agent |
| `REDIS_URL` | Optional | Distributed rate/cooldown |
| `FOLLOW_UP_COOLDOWN_SEC` | Optional | Follow-up cooldown, default 24h |
| `AGENT_RUN_MAX_PER_WINDOW` | Optional | Rate limit max |
| `AGENT_RUN_WINDOW_SEC` | Optional | Rate limit window |
| `AGENT_MAX_STEPS` | Optional | Max ReAct tool steps |
| `BB_PM_PROMPT_VERSION` | Optional | `v1` or `v2` |
| `AUTOMATION_POLL_MS` | Optional | DB automation poll interval |
| `AUDIT_RETENTION_DAYS` | Optional | Audit cleanup retention |

## 17.20 Local smoke tests

From `/home/bbsw/pm/bb-pm-tools`:

```bash
pnpm install
pnpm build

pnpm cli "task nào đang quá hạn?"
pnpm cli --digest
pnpm cli --hygiene
pnpm cli --stale
```

Direct HTTP:

```bash
curl -s -X POST http://localhost:18789/api/plugins/bb-pm/agent/run \
  -H 'content-type: application/json' \
  -d '{
    "text": "task nào quá hạn?",
    "conversationId": "gapo:123",
    "correlationId": "manual-test-1",
    "source": "chat"
  }'
```

Metrics:

```bash
curl -s http://localhost:18789/api/plugins/bb-pm/agent/metrics
```

Health:

```bash
curl -s http://localhost:18789/api/plugins/bb-pm/health
```

## 17.21 Debugging bb-pm-tools

| Symptom | Likely cause | Check |
|---|---|---|
| `Missing env: BB_PM_AGENT_TOKEN` | Plugin cannot auth to BB-PM | `.env`, `config.ts`, BB-PM `AGENT_API_TOKEN` |
| LLM returns text but no tools execute | Model server not emitting OpenAI `tool_calls` | Curl `/chat/completions` with tools |
| Slow replies | LLM saturated, no fast-path, queue full | `/agent/metrics`, logs, `AGENT_MAX_STEPS` |
| Duplicate replies | Channel retry/dedup mismatch | `conversationId`, `dedup.ts`, gapo-agent ack-fast |
| No scheduled digest | Missing target/token or invalid cron | `CRON_*`, `GAPO_SEND_TOKEN`, scheduler logs |
| Follow-up spam | Redis unavailable or cooldown not shared | `REDIS_URL`, `FOLLOW_UP_COOLDOWN_SEC` |
| Agent knows no caller | Missing `ChannelIdentity` mapping | BB-PM `/api/v1/agent/user-by-channel` |

---

# 18. OpenClaw Integration Deep Dive

## 18.1 OpenClaw là gì trong hệ thống này

OpenClaw là local-first AI gateway/plugin host. Trong kiến trúc BB-PM, OpenClaw không phải database và không phải PM domain API.

Vai trò chính:

- Load plugin `bb-pm-tools`.
- Load channel plugin như `gapo-agent`.
- Expose plugin HTTP routes dưới `/api/plugins/...`.
- Cung cấp gateway process chạy lâu dài.
- Cho phép các channel adapter và orchestrator giao tiếp trong cùng gateway.

## 18.2 Boundary rõ ràng

```mermaid
flowchart LR
  GW[OpenClaw Gateway] --> GP[gapo-agent plugin]
  GW --> BP[bb-pm-tools plugin]
  GP -->|POST /agent/run| BP
  BP -->|X-Agent-Token| API[bb-pm API]
  API --> DB[(PostgreSQL)]
  BP -->|POST /gapo-agent/send| GP
  GP --> Gapo[Gapo Work API]
```

Responsibility split:

| Layer | Owns | Does not own |
|---|---|---|
| `bb-pm` | PM data, business rules, RBAC, migrations | LLM prompts, channel webhooks |
| `bb-pm-tools` | Orchestration, tools, LLM, workflows, memory, audit | Raw Gapo payload parsing, browser UI |
| `gapo-agent` | Gapo webhook parse/send | PM logic, DB query, intent routing |
| OpenClaw gateway | Plugin loading/routing/runtime | BB-PM business domain |

## 18.3 OpenClaw plugin contract used here

Both `bb-pm-tools` and `gapo-agent` expose:

```ts
export function register(api: any) {
  api.registerHttpRoute({
    path: "...",
    auth: "plugin",
    match: "exact",
    handler,
  });
}
```

WHY `registerHttpRoute`:

- Plugin owns a route namespace.
- Gateway can dispatch incoming HTTP request to plugin.
- Plugin handler works with raw Node `IncomingMessage` / `ServerResponse`.
- The same gateway can host multiple plugins without each plugin running its own HTTP server.

## 18.4 gapo-agent plugin

Location:

```text
gapo-agent/
```

Files:

| File | Role |
|---|---|
| `index.ts` | Register webhook/send routes |
| `webhook.ts` | Receive Gapo inbound, normalize, forward to bb-pm-tools |
| `send.ts` | Authenticated outbound send endpoint |
| `client.ts` | Gapo API client |
| `config.ts` | Load config from file/env |
| `openclaw.plugin.json` | Plugin metadata |

Registered routes:

| Route | Method | Purpose |
|---|---|---|
| `/api/plugins/gapo-agent/webhook` | POST | Gapo inbound webhook |
| `/api/plugins/gapo-agent/send` | POST | Outbound send used by bb-pm-tools |

## 18.5 Inbound Gapo flow

```mermaid
sequenceDiagram
  participant Gapo as Gapo Work
  participant GW as OpenClaw Gateway
  participant GP as gapo-agent
  participant BP as bb-pm-tools
  participant API as bb-pm API

  Gapo->>GW: POST /api/plugins/gapo-agent/webhook
  GW->>GP: webhookHandler(req,res)
  GP-->>Gapo: 200 { ok: true } fast ack
  GP->>GP: parse text, senderName, conversationId
  GP->>BP: POST /api/plugins/bb-pm/agent/run
  BP->>API: tool calls with X-Agent-Token
  API-->>BP: PM data
  BP-->>GP: { reply }
  GP->>Gapo: sendReply(conversationId, reply)
```

Important detail:

`gapo-agent` acknowledges Gapo before calling the orchestrator. This prevents Gapo from retrying webhook delivery while LLM is still processing.

## 18.6 Payload normalization

`gapo-agent/webhook.ts` supports real Gapo and legacy test payloads.

It extracts:

- `text`
- `senderName`
- `conversationId`

It prefixes sender name into text:

```text
[GAPO_USER: Nguyen Van A] task nào quá hạn?
```

WHY:

- Maintains compatibility with old intent/caller parsing.
- Gives the LLM human-readable speaker context.
- Actual stable identity still comes from `conversationId = gapo:<id>` and BB-PM channel mapping.

Forwarded request:

```json
{
  "text": "[GAPO_USER: Nguyen Van A] task nào quá hạn?",
  "conversationId": "gapo:123456",
  "correlationId": "gapo-123456-1715000000000",
  "source": "chat"
}
```

## 18.7 Outbound Gapo flow

`bb-pm-tools` sends outbound messages through:

```http
POST /api/plugins/gapo-agent/send
X-Plugin-Token: <GAPO_SEND_TOKEN>
```

Body:

```json
{
  "conversationId": "123456",
  "text": "Digest hôm nay..."
}
```

WHY route outbound through `gapo-agent`:

- Centralizes Gapo API token.
- Keeps channel credentials out of `bb-pm-tools`.
- Lets scheduler/follow-up use same send path as reply flow.
- Makes future channel replacement easier.

## 18.8 gapo-agent config

Preferred file:

```text
~/.openclaw/plugins/gapo-agent/config.json
```

Example:

```json
{
  "gapo": {
    "apiUrl": "https://api.gapowork.vn/3rd-bot/v1.0/3rd/messages",
    "botToken": "<token>",
    "botId": "<bot-id>"
  },
  "orchestrator": {
    "url": "http://localhost:18789/api/plugins/bb-pm/agent/run",
    "timeoutMs": 30000
  },
  "sendToken": "<same-as-GAPO_SEND_TOKEN>"
}
```

Env fallback:

```env
GAPO_API_URL=https://api.gapowork.vn/3rd-bot/v1.0/3rd/messages
GAPO_BOT_TOKEN=<token>
GAPO_BOT_ID=<bot-id>
ORCHESTRATOR_URL=http://localhost:18789/api/plugins/bb-pm/agent/run
ORCHESTRATOR_TIMEOUT_MS=30000
GAPO_SEND_TOKEN=<shared-secret>
```

## 18.9 Full deployment topology

```mermaid
flowchart TD
  subgraph UserSide[Users]
    U[PM/Member in Gapo Work]
  end

  subgraph OpenClaw[OpenClaw Gateway :18789]
    GP[gapo-agent plugin]
    BP[bb-pm-tools plugin]
  end

  subgraph Core[BB-PM Core]
    WEB[React Web]
    API[Fastify API]
    DB[(PostgreSQL)]
    REDIS[(Redis optional)]
  end

  subgraph AI[LLM Provider]
    LLM[OpenAI-compatible endpoint]
  end

  U -->|message| GP
  GP -->|/agent/run| BP
  BP -->|chat/completions tools| LLM
  BP -->|X-Agent-Token| API
  API --> DB
  BP -. cooldown/rate .-> REDIS
  BP -->|/gapo-agent/send| GP
  GP -->|reply| U
  WEB -->|Bearer JWT| API
```

## 18.10 Setup order for full loop

1. Start BB-PM DB/API/Web.
2. Run BB-PM migrations and seed.
3. Ensure API `.env` has:

   ```env
   AGENT_API_TOKEN=<secret>
   AGENT_USER_EMAIL=pm-agent@bluebolt.local
   ```

4. Configure `bb-pm-tools`:

   ```env
   BB_PM_API_URL=http://localhost:4000/api/v1
   BB_PM_AGENT_TOKEN=<same-as-AGENT_API_TOKEN>
   LLM_PROVIDER=default
   LLM_BASE_URL=http://localhost:8000/v1
   LLM_MODEL=<model-with-tool-calling>
   GAPO_SEND_URL=http://localhost:18789/api/plugins/gapo-agent/send
   GAPO_SEND_TOKEN=<shared-secret>
   ```

5. Build `bb-pm-tools`:

   ```bash
   cd /home/bbsw/pm/bb-pm-tools
   pnpm install
   pnpm build
   ```

6. Configure `gapo-agent` in OpenClaw:

   ```json
   {
     "gapo": {
       "botToken": "<token>",
       "botId": "<bot-id>"
     },
     "orchestrator": {
       "url": "http://localhost:18789/api/plugins/bb-pm/agent/run",
       "timeoutMs": 30000
     },
     "sendToken": "<shared-secret>"
   }
   ```

7. Enable plugins in OpenClaw config.
8. Start OpenClaw gateway.
9. Point Gapo outgoing webhook to:

   ```text
   https://<public-domain>/api/plugins/gapo-agent/webhook
   ```

10. Test message in Gapo:

   ```text
   task nào quá hạn?
   ```

## 18.11 Three-token model

There are three separate secrets. Do not confuse them.

| Token | Used between | Header/env |
|---|---|---|
| BB-PM agent token | `bb-pm-tools` -> `bb-pm API` | `X-Agent-Token`, `BB_PM_AGENT_TOKEN`, API `AGENT_API_TOKEN` |
| Gapo bot token | `gapo-agent` -> Gapo API | `GAPO_BOT_TOKEN` |
| Plugin send token | `bb-pm-tools` -> `gapo-agent/send` | `X-Plugin-Token`, `GAPO_SEND_TOKEN` |

WHY separate:

- If Gapo token leaks, BB-PM API is still protected.
- If agent token leaks, attacker still cannot send Gapo messages unless gateway/send token also leaks.
- Rotation can be scoped per boundary.

## 18.12 Correlation and observability

Trace IDs:

| ID | Source | Used for |
|---|---|---|
| `requestId` | bb-pm-tools `/agent/run` | HTTP/log trace |
| `correlationId` | channel plugin or generated | Agent audit rows |
| `conversationId` | channel thread | Memory grouping, dedup, caller resolve |

Example:

```text
conversationId = gapo:123456
correlationId = gapo-123456-1715000000000
```

Where to inspect:

- OpenClaw gateway logs.
- `gapo-agent` logs: inbound and sendReply.
- `bb-pm-tools` logs: fast-path, slot, LLM, tool calls.
- BB-PM DB: `agent_audit_log`, `agent_memory`, `agent_follow_ups`.
- `GET /api/plugins/bb-pm/agent/metrics`.
- `GET /api/plugins/bb-pm/health`.

## 18.13 Common failure modes across OpenClaw + bb-pm-tools

| Symptom | Layer | Cause | Fix |
|---|---|---|---|
| Gapo webhook retries repeatedly | `gapo-agent` | Handler not acking fast or route unreachable | Check public URL, gateway bind, logs |
| Gapo receives generic error reply | `gapo-agent` -> `bb-pm-tools` | Orchestrator timeout/fail | Check `ORCHESTRATOR_URL`, `/agent/health`, LLM |
| `/agent/run` returns 503 overloaded | `bb-pm-tools` | Concurrency queue full | Check LLM latency, add fast-path, tune slots |
| Tool calls fail 401 | `bb-pm-tools` -> `bb-pm` | Agent token mismatch | Sync `BB_PM_AGENT_TOKEN` and `AGENT_API_TOKEN` |
| Agent cannot answer "task của tôi" | identity mapping | No `ChannelIdentity` for Gapo cid | Create/import mapping |
| Scheduled digest not sent | outbound | Missing `GAPO_SEND_TOKEN` or bad target | Test `/gapo-agent/send` |
| Reply has markdown artifacts | formatter/channel | LLM returned markdown | Check formatter, `stripMarkdownForGapo` |
| No tool calls from LLM | LLM server | No OpenAI function-calling support | Verify `tool_calls` with curl |

## 18.14 Maintenance rules

- Keep PM business rules in `bb-pm`, not in `gapo-agent`.
- Keep channel payload parsing in `gapo-agent`, not in `bb-pm-tools`.
- Keep prompt/tool orchestration in `bb-pm-tools`, not in `bb-pm` API.
- Add new PM capability as API endpoint first, then expose as tool.
- For every new mutating tool, define confirmation rules in prompt/eval.
- For every scheduled workflow, prefer deterministic workflow functions over LLM prompts.
- For every new channel, preserve the `/agent/run` contract and map its thread/user ID into `conversationId`.


# 19. Daily Check-in Deep Dive

## 19.1 Mục tiêu UX

Daily check-in cần đủ nhanh để user không ngại dùng mỗi ngày. Vì vậy `/checkin` không hiển thị toàn bộ project đang mở; nó chỉ đưa ra 3 project gần đây rồi cho phép nhập tự do nếu user đang làm project khác.

```text
Hôm nay bạn làm project nào?

Gần đây:
1. AI PM Agent
2. Logistics Dashboard
3. CRM Internal

Hoặc nhập tên project khác.
```

Cách chọn hợp lệ:

- quick reply;
- gõ số thứ tự;
- gõ tên project bất kỳ còn open task của user.

## 19.2 Luồng xử lý

```text
/checkin hoặc reminder
  -> start session
  -> AWAITING_PROJECT
  -> user chọn project
  -> AWAITING_UPDATE
  -> user gửi tiến độ
     -> lưu worklog trực tiếp theo project
     -> nếu parser nhận diện task rất rõ: gắn task ngầm như enrichment
  -> chọn task
  -> tạo backlog GAPO_CHECKIN
  -> COMPLETED
```

`bb-pm-tools/src/checkin.ts` xử lý turn hội thoại; `bb-pm API` giữ session và business rule. Parse update dùng LLM trước, regex fallback sau để không mất check-in khi LLM chập chờn.

## 19.3 API contract

| Endpoint | Ý nghĩa |
| --- | --- |
| `POST /api/v1/agent/checkin-sessions/start` | Mở/reset phiên |
| `GET /api/v1/agent/checkin-sessions/current` | Lấy phiên hiện tại |
| `PATCH /api/v1/agent/checkin-sessions/:id` | Cập nhật state/project/task |
| `POST /api/v1/agent/checkin-sessions/:id/complete` | Đóng phiên |
| `POST /api/v1/agent/checkins/import` | Tạo backlog `GAPO_CHECKIN` |
| `GET /api/v1/agent/checkins/status` | Theo dõi ai đã check-in |
| `GET /api/v1/agent/checkins/missing` | Tìm user còn thiếu check-in |
| `GET /api/v1/agent/checkins/project-daily-summary` | Tổng hợp theo project trong ngày |

## 19.4 Reminder và cron

Workflow hiện tại:

- `noon_checkin_reminder`
- `eod_checkin_reminder`
- `missing_checkin_followup`

Biến môi trường:

- `CRON_CHECKIN_ENABLED`
- `CRON_NOON_CHECKIN`
- `CRON_EOD_CHECKIN`
- `CRON_MISSING_CHECKIN_FOLLOWUP`

Reminder chỉ gửi khi user còn thiếu check-in, có Gapo identity, không có active session và có project open để chọn.

## 19.5 Failure modes và quan sát

| Hiện tượng | Cần kiểm tra |
| --- | --- |
| Gửi `/checkin` nhưng không có prompt | caller mapping, open task, log `checkin:no_project` |
| Reminder không tới | cron flag, target Gapo identity, active session |
| Bot hỏi task tiếp | không còn là happy path mặc định; nếu xuất hiện cần kiểm tra runtime có đang chạy bản cũ không |
| Parse update kém | telemetry `parseFallback`, LLM health |
| Report thiếu người | endpoint `/checkins/missing`, backlog nguồn `GAPO_CHECKIN` |

Metrics quan trọng từ `/api/plugins/bb-pm/agent/metrics`: `sessionsStarted`, `projectsSelected`, `completed`, `parseSuccess`, `parseFallback`, `remindersSent`, `remindersSkipped`.
