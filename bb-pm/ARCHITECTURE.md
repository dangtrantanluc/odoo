# BB-PM Architecture

Backend cho PM Operations Agent — SPA React + Node API + Postgres độc lập.

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

- **Network**: tất cả service chạy trong một Docker network `bb_pm_net`.
- **Port mapping**: API `4000`, Web `5173` (dev) / `80` (prod container), DB `5433`.
- **Persistence**: Postgres volume `bb_pm_pgdata`.

---

## 2. Monorepo layout

```
bb-pm/
├── apps/
│   ├── api/                     # Fastify + Prisma backend
│   │   ├── prisma/
│   │   │   ├── schema.prisma    # Nguồn sự thật cho DB
│   │   │   └── seed.ts          # Tạo admin + 2 currency + demo
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

## 3. Database — 15 bảng domain + 2 bảng agent

**4 bảng support:**

| Bảng | Ghi chú |
|---|---|
| `companies` | Multi-company; `currencyId` là default currency |
| `users` | `passwordHash` bcrypt; `role` enum (ADMIN/MANAGER/MEMBER/VIEWER) |
| `customers` | Khách hàng dự án |
| `currencies` | Seed `VND` + `USD` |

**11 bảng domain:**

```
projects, tasks, backlogs, members, member_rates,
milestones, scopes, tags, project_tags, task_tags,
gapo_user_maps
```

**2 bảng agent (Sprint 3):**

```
agent_audit_log   — tool invocation audit trail
task_blockers     — structured blocker history (severity + resolvedAt)
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
- **UI kit**: shadcn/ui (Radix primitives) + Tailwind.
- **Kanban**: `@dnd-kit/core` cho drag-drop task board theo status.
- **Table**: TanStack Table.
- **i18n**: `react-i18next`, default `vi_VN`. File `apps/web/src/i18n/vi.json`.
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

## 8. Deployment

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

## 9. Roadmap (6 sprints)

| Sprint | Focus | Deliverable |
|---|---|---|
| 1 | Foundation | Monorepo, Docker, Prisma schema, auth (login/register), shell FE, migrate script skeleton |
| 2 | Projects + Tags + Customers | Project CRUD, list/kanban, tag M2M, customer CRUD |
| 3 | Tasks + Milestones | Task CRUD, Kanban board dnd-kit, milestone progress |
| 4 | Backlogs + Cost engine | Backlog CRUD với snapshot, approval queue, recompute service |
| 5 | Scope + Dashboard + Profile | Scope CRUD, KPI cards, charts, avatar upload, i18n switcher |
| 6 | Polish | Settings (users/company/currencies), notifications, E2E tests, performance pass |

Mỗi sprint kết thúc bằng 1 demo có thể chạy được.

---

## 10. Sprint 7 — Agent runtime layer (2026-05-05)

```
                ┌─────────────────────────────────────────────────┐
                │  bb-pm-tools plugin (OpenClaw orchestrator)     │
                │  - 38 tools: 27 legacy + 11 v2 namespace        │
                │  - Prompt v1 (default) / v2 3-mode dispatcher   │
                │  - Workflow registry (3 workflows)              │
                │  - Scheduler 60s poll DB Automation             │
                │  - LLM multi-provider (Qwen / Gemini)           │
                └────────┬────────────────────────────────────────┘
                         │ HTTP X-Agent-Token
                         ▼
        ┌────────────────────────────────────────────────────┐
        │  bb-pm API (apps/api)                              │
        │                                                    │
        │  Standard CRUD endpoints (existing)                │
        │  + /agent/audit, /agent/memory, /agent/follow-up   │
        │  + /agent/report/query  (Phase 1 SQL gateway)      │
        │  + /agent/report/schema (Phase 1.1 DMMF→md)        │
        │  + /agent/automations   (Phase 4 CRUD)             │
        └────────┬───────────────────────────────────────────┘
                 │
        ┌────────┴────────┐
        ▼                 ▼
┌──────────────┐  ┌──────────────────────┐
│  Prisma      │  │  pg.Pool (readonly)  │
│  (full RW)   │  │  bb_pm_readonly role │
│              │  │  - SELECT only       │
│              │  │  - exclude pwd_hash  │
│              │  │  - revoke refresh_t  │
└──────┬───────┘  └─────────┬────────────┘
       │                    │
       ▼                    ▼
       PostgreSQL 16 (bb_pm)
```

### 10.1 SQL gateway (Phase 1 + 1.1) — defense pyramid

```
LLM SQL request
  ↓
[1] node-sql-parser AST
    - Reject non-SELECT
    - Reject multi-statement (';' splits)
    - Reject CTE with DML
[2] Forbidden keyword regex (defense beyond AST)
    - INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/COPY/CALL/EXECUTE/GRANT/REVOKE
    - pg_*/_prisma_* table prefix
    - information_schema/pg_catalog/pg_toast
[3] Company scope check
    - Touch table có company_id mà SQL không có WHERE → reject MISSING_COMPANY_SCOPE
    - SQL ép company_id != caller's → reject WRONG_COMPANY_SCOPE
[4] LIMIT injection — default 200, cap 1000
[5] Postgres SET statement_timeout = 5s
[6] Execute via bb_pm_readonly Postgres role
    - DML attempt → "permission denied" (DB-layer)
    - SELECT password_hash → "permission denied for column"
    - SELECT * FROM users → blocked (column-level grant excludes pwd hash)
    - SELECT * FROM refresh_tokens → blocked (table-level revoke)
[7] Result sanitize
    - Regex strip cột password|hash|jwt|secret|apikey|token → [REDACTED]
    - String fields > 2000 chars truncate
    - BigInt → Number (JSON-safe)
```

### 10.2 Automation engine (Phase 4 + 4.1)

```
User → automation.create tool → POST /agent/automations
                                  ↓
                      Automation row inserted (active=true)
                                  ↓
                                  ↓ (poll trigger ≤ 60s)
                                  ↓
   bb-pm-tools scheduler.syncRegistry() ← polls /agent/automations every 60s
                                  ↓
                        cron.schedule(row.schedule, () => runDbAutomation(row.id, ...))
                                  ↓
                            (cron tick fires)
                                  ↓
                        Re-fetch row → check active + consecutiveFails
                                  ↓
                        runWorkflow(row.workflow, row.inputs, {target: row.target})
                                  ↓
                        Workflow registry lookup
                                  ├── daily_digest    → bbPm.digest() → sendToGapo
                                  ├── weekly_report   → bbPm.weeklyReport() → sendToGapo
                                  └── hygiene_check   → bbPm.checkHygiene() → sendToGapo
                                  ↓
                        PATCH /agent/automations/:id { lastRunStatus, lastRunError, consecutiveFails }
                                  ↓
                        Dead-man switch: 3 fails liên tiếp → unregister + warn
```

Hot-register lifecycle (verified 2026-05-05):
- 10:06:42 — POST /agent/automations id=3 created
- 10:07:22 — gateway poll detected new row → cron registered (40s)
- 10:08:00 — cron fired → runtime check active → if inactive skip (defense layer 2)
- 10:08:22 — gateway poll detected DB inactive → cron unregistered (defense layer 1, 60s)

### 10.3 New tables (Sprint 7)

| Table | Purpose | Key columns |
|---|---|---|
| `automations` | Recurring workflow registration | name, workflow, schedule (cron), inputs (JSONB), target, active, owner_id, company_id, last_run_*, consecutive_fails |

Existing tables retained: agent_audit_log, agent_memory, agent_follow_ups, task_blockers (all from prior sprints).

### 10.4 LLM multi-provider

```
chat(messages, tools, options?)
  ↓
provider = options.provider ?? config.llm.activeProvider
  ↓
config.llm[provider] = { baseUrl, apiKey, model, ... }
  ↓
POST {baseUrl}/chat/completions  (OpenAI-compat)
  - default: Qwen self-host (vLLM)
  - gemini:  https://generativelanguage.googleapis.com/v1beta/openai
  ↓
ChatResponse: { content, tool_calls, finish_reason, usage, latencyMs, provider, model }
```

Bench (`pnpm bench`): scenarios cover greeting, knowledge-no-tool, with-15-tools, JSON mode. Gemini-flash 14x faster trên trung bình (free tier 20 req/day blocking full bench — production cần billing).

---

## 11. Sprint 8 follow-up — Production-grade request pipeline (2026-05-07)

### 11.1 Updated request flow

```
                                Inbound (Gapo webhook → bb-pm-tools webhook)
                                                ↓
                                       Rate limit + dedup check
                                                ↓
                  ┌─────────────── source === "chat" + conversationId? ──────────────┐
                  │                                                                  │
                  ▼ YES                                                              │ NO/other
   Resolve callerUserId (bbPm.getUserByGapoCid)                                     │
                  ↓                                                                  │
   tryFastPath(text, ctx) — slash / Vietnamese regex / end_session                  │
                  ↓                                                                  │
       Match? ──── YES ──→ executeFastPath (with circuit breaker)                   │
                  │              ↓                                                   │
                  │        directReply OR tool.handler() with logging                │
                  │              ↓                                                   │
                  │        stripMarkdownForGapo → recordRecentTurn → return ✓        │
                  │                                                                  │
                  ▼ NO                                                               │
       acquireSlot (cap 16, queue 30, timeout 60s) ◀─────────────────────────────────┤
                  ↓                                                                  │
       Promise.race([                                                                │
         runAgentInternal(text, ctx),                                                │
         hard_timeout(300s)                                                          │
       ])                                                                            │
                  ↓                                                                  │
       runAgentInternal:                                                             │
         resolveCallerBlock                                                          │
         tryFastPath (fallback if webhook didn't catch)                              │
         recallMemoryContext (DB + recent-turns cache)                               │
         ReAct loop (Qwen LLM + 41 tools, 31 visible v1 / 32 v2)                    │
         summarizeAndStore (fire-and-forget)                                         │
         recordRecentTurn (in-memory cache last 2 turn, TTL 30 min)                  │
                  ↓                                                                  │
       formatResponse(rawReply, ctx, userMessage):                                   │
         - source cli/eval → pass-through                                            │
         - chat: classify template (8 templates) → render OR LLM rewrite Qwen       │
         - special: if [END_SESSION] but user not real ack → strip marker           │
                  ↓                                                                  │
       stripMarkdownForGapo (defense in depth)                                       │
                  ↓                                                                  │
       Return reply { reply, requestId, fastPath? }
                  ↓
       Channel adapter sends to Gapo (gapo-agent plugin /send)
                  ↓
       Watcher detect [END_SESSION] marker → SKIP send + 5min cooldown
       OR send normally with watcher cooldownMs (~30s)
```

### 11.2 New layers (Sprint 8 follow-up)

| Layer | File | Purpose |
|---|---|---|
| **Slash commands** | pre-classifier.ts | 10 commands: /help /digest /weekly /mytasks /overdue /blocked /stale /projects /role /automations |
| **Pre-classifier patterns** | pre-classifier.ts | 10 Vietnamese regex: end_session, my_tasks, overdue, daily_digest, weekly_report, list_automations, my_role, list_projects, blocked_tasks, stale_tasks |
| **Fast-path circuit breaker** | pre-classifier.ts | Track per-pattern fail count rolling 60s. Threshold 3 → disable 5min → fall through LLM (no cascade) |
| **Concurrency limiter** | concurrency.ts | Cap 16 in-flight (vLLM Qwen3.6-27B-FP8 sweet spot), queue 30, acquire timeout 60s. Fast-path BYPASS slot. |
| **Hard timeout** | orchestrator.ts | Promise.race với 300s cap → friendly fallback message |
| **Response formatter** | formatter.ts | 3-tier: template match (8 templates) → skip if clean → Qwen LLM rewrite (timeout 30s) |
| **Recent-turns cache** | memory.ts | In-memory Map<cid, RecentTurn[]> cap 2/cid, TTL 30 min — catch follow-up khi DB summary chưa kịp ghi |
| **Markdown stripping** | channel-out.ts | Strip `**`, `__`, `~~`, backtick, `# heading` cho Gapo (không render markdown) |
| **Admin alert** | channel-out.ts + scheduler.ts | `notifyAdmin(context, error)` wire vào 3 cron handlers |
| **Health probe** | webhook.ts | `GET /health` check bbPmApi (3s timeout) + LLM /models (5s) |
| **Audit retention** | bb-pm-api routes + scheduler | Daily 3 AM cleanup `agent_audit_log` > 90d. Migration thêm `@@index([createdAt])`. |

### 11.3 Tool catalog filter (Phase 6 cleanup)

```
toolsByName (42 handlers, all callable nội bộ)
       ↓
toolCatalog(promptVersion):
       ↓
   v1 (default) → exclude V2_ONLY_TOOLS + DEPRECATED_LEGACY_TOOLS
                  → 31 tools shown to LLM
   v2           → exclude DEPRECATED_LEGACY_TOOLS only
                  → 32 tools shown to LLM (includes report.query SQL gateway)

V2_ONLY_TOOLS (1):
  - report.query

DEPRECATED_LEGACY_TOOLS (10) — handlers vẫn live cho fast-path/workflow:
  - assign_task, update_task_status, post_blocker
  - create_action_item, create_project, get_task_owner
  - send_follow_up, send_dm_to_gapo_user, find_gapo_user, mark_follow_up_replied

LLM phải dùng namespaced thay thế:
  - task.update / task.create / task.report_blocker
  - project.create / project.update
  - message.send / messages.broadcast / follow_up.update
  - find_task / find_user / gapo.find_user

Rollback: BB_PM_EXPOSE_LEGACY_TOOLS=true
```

### 11.4 Performance baseline (load test 2026-05-07)

20 concurrent users, mixed pattern (8 slash + 6 fastpath + 3 end_session + 3 LLM):

| Tier | p50 | p95 | Throughput |
|---|---|---|---|
| Slash commands | 127ms | 162ms | instant |
| Vietnamese fast-path | 130ms | 163ms | instant |
| End-session | 100ms | 102ms | instant |
| LLM (Qwen) | 52612ms | 138964ms | 16 concurrent cap |
| **Overall** | **130ms** | 52612ms | 0.14 req/s |

Success rate: 100% (20/20). 0 overloaded, 0 ratelimited. Wall clock 139s for full burst.

Baseline (pre-Sprint 8 follow-up): 45% success, p50 30162ms.
**Improvement: 232× faster ở p50, +55 pts success rate.**

Detail report: [test.md](../test.md).

### 11.5 Failure handling matrix

| Failure mode | Detection | Recovery |
|---|---|---|
| Qwen treo > 300s | `Promise.race` hard timeout | Return friendly + log alert + slot released |
| Qwen offline | Health endpoint LLM check fail | Status `degraded`, fast-path còn work |
| bb-pm API offline | Health endpoint bbPmApi fail | HTTP 503 health, agent runs error gracefully |
| Fast-path pattern fail liên tục | Circuit breaker counts | Disable pattern 5min, fall through LLM |
| 20+ concurrent burst | acquireSlot queue (cap 30) + timeout 60s | 503 agent_overloaded, caller retry-after 60s |
| Cron job fail | Try/catch + `notifyAdmin` | Log + Gapo alert vào ADMIN_ALERT_TARGET |
| User send wrong [END_SESSION] | Formatter cross-check userMessage | Strip marker, treat as normal reply |
| Caller (gapo cid) không resolve | Friendly NO_CALLER_REPLY ngay | User được hướng dẫn liên hệ admin (vs silent timeout) |
| Watcher Playwright session die | (TODO Sprint 9) | Manual restart hiện tại; auto re-login planned |

## 12. Check-in API cho PM Agent

Backend sở hữu persistence và state machine của daily check-in; plugin chỉ điều phối hội thoại. Nhóm endpoint hiện tại:

| Endpoint | Mục đích |
| --- | --- |
| `POST /api/v1/agent/checkin-sessions/start` | Tạo/reset phiên, đưa về `AWAITING_PROJECT` |
| `GET /api/v1/agent/checkin-sessions/current` | Đọc phiên hiện tại theo user |
| `PATCH /api/v1/agent/checkin-sessions/:id` | Cập nhật project/task/state/pending payload |
| `POST /api/v1/agent/checkin-sessions/:id/complete` | Đánh dấu `COMPLETED` |
| `POST /api/v1/agent/checkins/import` | Tạo backlog `GAPO_CHECKIN` cho task đã xác nhận |
| `GET /api/v1/agent/checkins/status` | Lấy check-in trong ngày |
| `GET /api/v1/agent/checkins/missing` | Tìm user còn thiếu check-in |
| `GET /api/v1/agent/checkins/project-daily-summary` | Tổng hợp check-in theo project |

State hợp lệ:

```text
IDLE | AWAITING_PROJECT | AWAITING_UPDATE | AWAITING_TASK_CONFIRM | COMPLETED
```

Quy tắc đáng nhớ:

- Session là một-per-user, `start` dùng upsert để reset phiên cũ.
- `import` chỉ chấp nhận task đang assign đúng user.
- `missing` bỏ qua user đã có backlog `GAPO_CHECKIN` trong ngày và đánh dấu `activeSession` để workflow không nhắc trùng.
- API luôn enforce company scope với non-super-admin.
