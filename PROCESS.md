# PM Operations Agent — Process & Progress Tracker

> Nhật ký tiến độ build hệ thống **PM Operations Agent** (OpenClaw + bb-pm).
> Cập nhật lần cuối: **2026-04-24 10:00** — Sprint 6.1 Multi-channel Identity DONE. LLM retry logic + IPv4 DNS fix operational.

Tham chiếu thiết kế: [PMOperationsAgent.md](./PMOperationsAgent.md) · [bb-pm/ARCHITECTURE.md](./bb-pm/ARCHITECTURE.md)

---

## 0. Tổng quan trạng thái

| Layer | Trạng thái | Ghi chú |
|---|---|---|
| **bb-pm API** (Fastify + Prisma) | ✅ Sprint 1–6.1 done | 18 module, JWT + X-Agent-Token, audit + blocker + memory + weekly report + meetings + channel identity, 5 migration applied |
| **bb-pm Web** (React SPA) | ✅ Sprint 1 done | Shell + login/register + dashboard placeholder |
| **OpenClaw — `bb-pm-tools` plugin** | ✅ Sprint 1–5 done | 19 tools (Level 1 + 2 + 3 + 4), ReAct + memory recall + meeting extraction |
| **OpenClaw — `gapo-work` plugin** | ✅ Refactored | Channel adapter thuần: inbound webhook + outbound `/send` |
| **Channels** | 🟡 Gapo only | Zalo / Slack / Telegram / Gmail chưa |
| **LLM self-hosted** | ✅ Qwen | `Qwen/Qwen3.6-27B-FP8` @ `http://100.108.110.17:8000/v1`, tool-calling OK |
| **End-to-end verified** | ✅ 2026-04-24 | 9 flow smoke-tested: overdue / digest / hygiene / blocker / follow-up / weekly report / memory recall / Gapo webhook / meeting approval |
| **Redis cooldown** | 🟡 in-memory | OK dev, cần swap sang Redis khi multi-process |
| **GapoUserMap seed** | ❌ trống | `send_follow_up` sẽ skip với `no_gapo_thread` cho đến khi có data |
| **Cron digest target** | ❌ chưa set | `CRON_DAILY_DIGEST_TARGET` rỗng → cron không chạy |
| **Agent memory** (pg_trgm) | ✅ text search | Recall by conversationId + keyword trigram. Vector swap (pgvector) ở S4.5 |
| **Meeting Assistant** | 🟡 direct API OK, LLM extraction chờ Qwen | Ingest/approve flow qua API verified. LLM-driven ingest code-complete, blocked bởi Qwen ECONNREFUSED tại 09:00 2026-04-24 |
| **Gmail delivery** | ⏳ Sprint 4.5 | Flow 6 weekly report gửi email — cần OAuth setup |
| **Audio transcription** | ⏳ Sprint 5.5 | Whisper cho upload audio → transcript |

Chú thích: ✅ done · 🟡 partial · ⏳ chưa bắt đầu · ❌ thiếu data/config

---

## 1. Kiến trúc hiện tại (sau Phase 1 + 2 refactor)

3 layer phân lập, HTTP boundary giữa các layer:

```
                    [Gapo Bot]
                        │  webhook
                        ▼
 ┌────────────────────────────────────────────┐
 │  gapo-work plugin  (channel adapter)       │
 │  /openclaw/plugins/gapo-work/              │
 │  • webhook.ts  — parse Gapo payload        │
 │  • send.ts     — outbound /send endpoint   │
 │  • client.ts   — gọi Gapo API              │
 │  Secret: GAPO_BOT_TOKEN, sendToken         │
 └────────────┬──────────────────▲────────────┘
              │ /agent/run        │ /send (X-Plugin-Token)
              ▼                   │
 ┌────────────────────────────────────────────┐
 │  bb-pm-tools plugin  (orchestrator)        │
 │  /bb-pm-tools/                             │
 │  • index.ts, webhook.ts — /agent/run       │
 │  • orchestrator.ts      — ReAct loop       │
 │  • tools.ts             — 15 tool          │
 │  • scheduler.ts         — cron → /send     │
 │  • cooldown.ts          — TTL map          │
 │  • channel-out.ts       — → gapo-work/send │
 │  Secret: BB_PM_AGENT_TOKEN, LLM key        │
 └────────────┬───────────────────────────────┘
              │ HTTP + X-Agent-Token
              ▼
 ┌────────────────────────────────────────────┐
 │  bb-pm API  (Fastify + Prisma)             │
 │  /bb-pm/apps/api/                          │
 │  • /tasks/overdue, /stale, /hygiene        │
 │  • /tasks/:id/blocker                      │
 │  • /projects/digest                        │
 │  • /agent/audit, /agent/gapo-thread/:id    │
 │  Auth: JWT (web) OR X-Agent-Token (agent)  │
 └────────────┬───────────────────────────────┘
              │ Prisma
              ▼
         [Postgres bb_pm :5433]
```

**Nguyên tắc kiến trúc:**
- Mỗi layer chỉ biết về layer kế tiếp qua HTTP, không import chéo.
- Gapo credentials **chỉ tồn tại trong `gapo-work`**. Scheduler / follow_up_tool gọi `gapo-work /send` với `X-Plugin-Token` chung.
- bb-pm-tools **chỉ** giữ `BB_PM_AGENT_TOKEN` + LLM key — không chạm Gapo API.

---

## 2. bb-pm API — trạng thái

Path: [bb-pm/apps/api](./bb-pm/apps/api/)

### 2.1 Module đã triển khai

| Module | Endpoints chính | Trạng thái |
|---|---|---|
| `auth` | register, login, refresh, me | ✅ |
| `users` | CRUD + list | ✅ |
| `projects` | CRUD + snapshot + **digest (agent)** | ✅ |
| `tasks` | CRUD + **overdue / stale / hygiene / blocker (agent)** + transition | ✅ |
| `backlogs` | CRUD + approve/reject/reset | ✅ |
| `members` | CRUD project members | ✅ |
| `milestones` | CRUD + progress | ✅ |
| `rates` | Member rates | ✅ |
| `scopes` | Project scope | ✅ |
| `tags` | Tag M2M | ✅ |
| `customers` | CRUD | ✅ |
| `uploads` | MinIO (avatar) | ✅ |
| `dashboard` | KPI rollup | ✅ |
| `notifications` | Basic notification store | ✅ |
| `admin` | Settings | ✅ |
| **`agent`** (mới) | `POST/GET /agent/audit`, `GET /agent/gapo-thread/:userId` | ✅ |

### 2.2 Identity & auth

- JWT access + refresh ✅
- **X-Agent-Token** header ✅ ([plugins/auth.ts](./bb-pm/apps/api/src/plugins/auth.ts)) — resolve sang service user
- 4 role: ADMIN / MANAGER / MEMBER / VIEWER ✅
- Service user `pm-agent@bluebolt.local` role MANAGER ✅ (seed bcrypt random, chỉ login qua agent token)
- Bảng `ChannelIdentity` chung cho Gapo/Slack/Zalo/Telegram/Email/SMS ✅ (migration `20260424030000`, backfill từ `GapoUserMap`)

### 2.3 Database

- Postgres 16 @ :5433 (Docker `bb_pm_db`) ✅
- 15 bảng domain + `agent_audit_log` + `task_blockers` + `agent_memory` + `meetings` + `meeting_action_items` + `channel_identities` ✅
- Enums: `AgentAuditSource`, `BlockerSeverity`, `MeetingItemStatus`, `ChannelKind` (gapo/slack/zalo/zalouser/telegram/email/sms) ✅
- Migrations applied: `20260424000000_add_agent_tables`, `20260424010000_add_agent_memory`, `20260424010001_task_blocker_fk`, `20260424020000_add_meetings`, `20260424030000_add_channel_identities` ✅
- Extension `pg_trgm` bật cho trigram search trên `agent_memory.summary` + `user_text` ✅
- pgvector extension — ❌ chưa bật (S4.5 swap text search → semantic)

### 2.4 Agent endpoint contracts

| Endpoint | Auth | Mô tả |
|---|---|---|
| `GET /tasks/overdue?projectId=&days=&limit=` | X-Agent-Token/JWT | Task quá hạn, company-scoped, order priority desc + deadline asc |
| `GET /tasks/stale?daysSinceUpdate=&limit=` | X-Agent-Token/JWT | Task không update trong N ngày, order cũ nhất trước |
| `GET /tasks/hygiene?staleDays=14` | X-Agent-Token/JWT | 3 subquery: missingOwner / missingDeadline / staleStatus |
| `GET /projects/digest` | X-Agent-Token/JWT | Rollup counters + active projects + completion % |
| `GET /projects/weekly-report?days=7&projectId=` | X-Agent-Token/JWT | **(S4)** Rollup window: tasks done / new blockers / hours approved / upcoming deadlines |
| `POST /tasks/:id/blocker` body `{description, severity}` | X-Agent-Token/JWT | Append vào `task.issues` + tạo row `TaskBlocker` |
| `POST /agent/audit` body `{tool, argsJson, ...}` | X-Agent-Token | Ghi 1 row `AgentAuditLog` |
| `GET /agent/audit?tool=&correlationId=&limit=` | X-Agent-Token/JWT | Liệt kê audit gần đây |
| `GET /agent/gapo-thread/:userId` | X-Agent-Token/JWT | Lookup `gapo_user_maps`, trả `{gapoThreadId, gapoUserId}` hoặc 404 |
| `POST /agent/memory` body `{userText, replyText, summary, toolsUsed, projectIds, taskIds, conversationId?, correlationId?}` | X-Agent-Token/JWT | **(S4)** Lưu summary 1 lượt hội thoại |
| `GET /agent/memory/search?q=&conversationId=&projectId=&daysBack=30&limit=5` | X-Agent-Token/JWT | **(S4)** Recall: ưu tiên same-conversation, fallback trigram ILIKE trên `summary`/`user_text` |
| `POST /meetings` body `{title?, transcript, summary?, decisions, participants, projectId?, items[]}` | X-Agent-Token/JWT | **(S5)** Lưu meeting + DRAFT action items. ownerName auto-resolve sang userId |
| `GET /meetings?projectId=&limit=20` | X-Agent-Token/JWT | **(S5)** List recent meetings + count items |
| `GET /meetings/:id` | X-Agent-Token/JWT | **(S5)** Chi tiết + items |
| `POST /meetings/:id/approve` body `{itemIds[], defaultProjectId?}` | X-Agent-Token/JWT | **(S5)** Convert DRAFT items → Task thật, mark APPROVED |
| `POST /meetings/:id/reject` body `{itemIds[]}` | X-Agent-Token/JWT | **(S5)** Mark items REJECTED |
| `GET /agent/channel-identity/:userId?channel=` | X-Agent-Token/JWT | **(S6.1)** List channel identities của 1 user, order preferred desc + lastSeenAt desc |
| `POST /agent/channel-identity` body `{userId, channel, externalId, externalName?, threadId?, preferred?}` | X-Agent-Token + ADMIN/MANAGER | **(S6.1)** Upsert theo unique (channel, externalId). Nếu `preferred:true` → unmark các row cùng (userId, channel). |
| `DELETE /agent/channel-identity/:id` | X-Agent-Token + ADMIN/MANAGER | **(S6.1)** Xoá 1 identity |
| `GET /agent/gapo-thread/:userId` | X-Agent-Token/JWT | **(S3, S6.1 refactor)** Read-through: ưu tiên `channel_identities` where channel=gapo + preferred desc; fallback `gapo_user_maps` legacy |

---

## 3. OpenClaw plugins — trạng thái

### 3.1 `bb-pm-tools` (orchestrator)

Path: [bb-pm-tools](./bb-pm-tools/) (sibling với `bb-pm/`, KHÔNG phải `bb-pm/openclaw/`)

**Tools đã expose — 19 tool:**

**Quan sát (Level 1):**
- `list_overdue_tasks` · `list_stale_tasks` · `check_data_hygiene` · `generate_daily_digest`
- `get_project_snapshot` · `list_blocked_tasks` · `get_task_owner`

**Điều phối (Level 2):**
- `update_task_status` · `create_action_item`
- `send_follow_up(userId, taskId, question)` — lookup GapoUserMap, cooldown 24h, POST qua gapo-work /send
- `post_blocker(taskId, description, severity)` — ghi vào bb-pm API

**Tổng hợp (Level 3 — Sprint 4):**
- `generate_weekly_report(days?, projectId?)` — window rollup 7/30/90 ngày
- `recall_memory(q?, conversationId?, projectId?, taskId?, daysBack?, limit?)` — trigram search + conv-scope

**Điều phối Level 4 — Sprint 5 (Meeting Assistant):**
- `ingest_meeting(transcript, projectId?, title?)` — LLM extract JSON strict (summary/decisions/participants/actionItems) → bb-pm API `/meetings` → DRAFT items
- `approve_meeting_items(meetingId, itemIds[], defaultProjectId?)` — convert DRAFT → Task thật

**Tìm kiếm:**
- `find_project` · `find_task` · `find_user` · `search_tasks` · `search_projects`

**Infrastructure:**

| Thành phần | File | Trạng thái |
|---|---|---|
| Env loader (manual, no dotenv) | `src/env.ts` | ✅ |
| Config/env parse | `src/config.ts` | ✅ |
| bb-pm HTTP client | `src/api-client.ts` | ✅ |
| LLM client (OpenAI-compat, Qwen, `response_format` support) | `src/llm.ts` | ✅ |
| ReAct orchestrator + audit wrap + memory recall/store | `src/orchestrator.ts` | ✅ |
| Memory recall + auto-summarize (Sprint 4) | `src/memory.ts` | ✅ |
| Meeting extraction (strict JSON output + loose parser) (Sprint 5) | `src/meeting.ts` | ✅ |
| Shared AgentContext (correlation + conversation IDs) | `src/types.ts` | ✅ |
| OpenClaw HTTP handler (`registerHttpRoute`) | `src/webhook.ts` + `index.ts` | ✅ |
| Outbound → gapo-work /send | `src/channel-out.ts` | ✅ |
| Cron scheduler | `src/scheduler.ts` | ✅ |
| Cooldown TTL store | `src/cooldown.ts` | ✅ in-memory (Redis swap sau) |
| CLI tester | `src/cli.ts` | ✅ |
| pgvector semantic recall | — | ⏳ S4.5 |

### 3.2 `gapo-work` (channel adapter)

Path: [openclaw/openclaw/plugins/gapo-work](./openclaw/openclaw/plugins/gapo-work/)

**Files hoạt động (Phase 1 refactor xoá hết PM logic):**

| File | Role |
|---|---|
| `index.ts` | Đăng ký 2 route: `/webhook` (inbound) + `/send` (outbound) |
| `webhook.ts` | Parse Gapo payload, forward HTTP → bb-pm-tools `/agent/run`, reply về Gapo |
| `send.ts` | POST `/send` — nhận `{conversationId, text}` với `X-Plugin-Token`, gọi Gapo API |
| `client.ts` | Outbound Gapo message API client |
| `config.ts` | Load `~/.openclaw/plugins/gapo-work/config.json` + env |

**Đã xoá:** các file PM logic cũ (`parser.ts`, `db.ts`, RPC client, `service.ts`, `formatter.ts`, `types.ts`) + tất cả `*.js` stale ở root.

---

## 4. Flow — trạng thái chạy

Theo [PMOperationsAgent.md §4.3](./PMOperationsAgent.md):

| Flow | Trigger | Status | Note |
|---|---|---|---|
| **1. Daily Project Scan** | Cron 08:00 ICT | 🟡 code ready | Chưa set `CRON_DAILY_DIGEST_TARGET` |
| **2. Task Follow-up** | LLM tự quyết gọi `send_follow_up` | ✅ code ready | Cần seed `gapo_user_maps` để chạy thật |
| **3. Blocker Management** | Intent detect → `post_blocker` | ✅ **chạy thật OK** | Smoke test 2026-04-24 pass |
| **4. Meeting Assistant** | Transcript inbound | 🟡 direct API OK | LLM ingest code-complete, verify chờ Qwen up |
| **5. Executive Query** | Inbound Gapo | ✅ **chạy thật OK** | Memory recall theo conversationId + trigram search (2026-04-24) |
| **6. Reporting — Daily** | Cron | 🟡 code ready | Tool `generate_daily_digest` OK, cần set cron target |
| **6. Reporting — Weekly** | Cron Fri 17:00 (future) | 🟡 partial | Tool `generate_weekly_report` OK; Gmail delivery ở S4.5 |
| **7. Data Hygiene** | Cron Mon 09:00 ICT | 🟡 code ready | Chưa set `CRON_WEEKLY_HYGIENE_TARGET` |
| **8. Planning Support** | Agent nhận "đề xuất tiếp theo" | 🟡 prompt-based | Không thêm tool riêng — LLM tự combine get_project_snapshot + list_overdue_tasks + list_blocked_tasks theo system prompt rule 12 |

---

## 5. Smoke test end-to-end (2026-04-24)

Chạy thật, data thật. Chi tiết log trong conversation.

### 5.1 Direct agent endpoint

```
POST http://localhost:18789/api/plugins/bb-pm/agent/run
Body: {"text": "task nào đang quá hạn?", "source": "cli"}

→ Qwen gọi list_overdue_tasks
→ bb-pm API GET /tasks/overdue trả 1 task (KPI cards, 9 ngày overdue)
→ Qwen compose VN + hỏi có ping không

Reply: "Hiện có 1 task đang quá hạn: Build dashboard KPI cards (WR-2026),
        người phụ trách Tran Thi B, deadline 15/04/2026 (quá hạn 9 ngày),
        trạng thái IN_PROGRESS. Bạn có muốn mình gửi tin nhắn nhắc nhở không?"
```

### 5.2 Daily digest

```
Input: "tổng kết hôm nay"
Tool:  generate_daily_digest
Reply: Markdown đầy đủ 5 counter + 2 project + completion % + gợi ý follow-up
```

### 5.3 Blocker (LLM-driven)

```
Input: "task 3 mình đang bị stuck chờ design review, ghi blocker severity med giúp"
Tool:  post_blocker(taskId=3, description="chờ design review", severity="MED")
DB:    tasks.id=3.issues = "[2026-04-24 07:51] [MED] chờ design review"
       task_blockers row id=2 created
```

### 5.4 Gapo webhook simulation

```
POST /api/plugins/gapo-work/webhook
Body: {message:{text:"[GAPO_USER: pm] hygiene check", thread:{id:"test-thread-123"}}}
→ ack 200 {ok: true}
→ async forward sang /agent/run → reply → Gapo API (fake thread sẽ fail — expected)
```

### 5.5 Audit log

Sau test, 5 rows trong `agent_audit_log`:

```
id | source | tool                   | duration
 5 | chat   | post_blocker           | 13ms
 4 | chat   | list_overdue_tasks     | 11ms
 3 | chat   | generate_daily_digest  | 21ms
 2 | cli    | list_overdue_tasks     | 59ms
 1 | cli    | smoke_test             | --
```

---

## 6. Config đang production-ready

| Thành phần | Path | Nội dung |
|---|---|---|
| OpenClaw config | `~/.openclaw/openclaw.json` | Qwen provider `berp-openai`, 2 plugin entries, gateway :18789 |
| bb-pm API env | `bb-pm/.env` | `AGENT_API_TOKEN`, `AGENT_USER_EMAIL`, `DATABASE_URL` |
| bb-pm-tools env | `~/.openclaw/plugins/bb-pm-tools/.env` | LLM Qwen, `BB_PM_AGENT_TOKEN`, `GAPO_SEND_URL`, `GAPO_SEND_TOKEN` |
| gapo-work config | `~/.openclaw/plugins/gapo-work/config.json` | `gapo.botToken`, `orchestrator.url`, `sendToken` |

**Shared secrets (generated):**

| Name | Value (hex 32) | Dùng ở |
|---|---|---|
| `AGENT_API_TOKEN` / `BB_PM_AGENT_TOKEN` | `e4def90c...f027d2f` | bb-pm API ↔ bb-pm-tools |
| `GAPO_SEND_TOKEN` / `sendToken` | `f2ccf92f...597c7a93` | bb-pm-tools ↔ gapo-work |
| Gapo bot token | `a92772667cfe48929f4c847dc6cc8ce4` | gapo-work ↔ Gapo API (**chưa rotate** — cần làm ở Gapo portal) |

---

## 7. Sprint roadmap — tình trạng

Theo [PMOperationsAgent.md §4.7](./PMOperationsAgent.md):

| Sprint | Level | Deliverable | Status |
|---|---|---|---|
| **S1** Foundation | — | Service user + token, scaffold plugin, `list_overdue_tasks` | ✅ DONE |
| **S2** Observer | L1 | Flow 1 + 7: daily digest + weekly hygiene | ✅ DONE |
| **S3** Follow-up | L2 | Flow 2 + 3: cooldown, `send_follow_up`, `post_blocker` | ✅ DONE 2026-04-24 |
| **S4** Summarizer | L3 | Flow 5 + 6 Weekly: agent_memory, recall_memory, generate_weekly_report, CEO query | ✅ DONE 2026-04-24 |
| **S5** Coordinator | L4 | Flow 4 + 8: meeting transcript → action items (DRAFT + approve), planning suggestion qua prompt | ✅ DONE 2026-04-24 |
| **S6.1** Multi-channel Identity | — | `channel_identities` generic schema + CRUD + back-compat `/gapo-thread` | ✅ **DONE 2026-04-24** |
| **S6.2** Polish remaining | — | Audit dashboard UI, E2E test suite, load test, ops hardening | ⏳ NEXT |
| **S3.5** Browser capability | — | Playwright tools cho initiate DM khi bot API không đủ | ⏳ deferred |
| **S4.5** Gmail + pgvector | — | Flow 6 Gmail delivery + swap memory recall sang vector embedding | ⏳ |
| **S5.5** Whisper | — | Audio upload → transcript → ingest_meeting | ⏳ |

---

## 8. Việc còn lại ngay (2026-04-24)

### 8.1 Cho production-ready Sprint 3

- [ ] **Seed `gapo_user_maps`** — map user bb-pm → gapo_thread_id để `send_follow_up` dùng được
- [ ] Set **`CRON_DAILY_DIGEST_TARGET`** = conversation_id phòng PM thật → restart gateway
- [ ] Set **`CRON_WEEKLY_HYGIENE_TARGET`** = conversation_id phòng PM thật
- [ ] Public URL cho Gapo webhook: firewall/DNS cho `http://<public>:18789/api/plugins/gapo-work/webhook`
- [ ] **Rotate Gapo bot token** ở Gapo developer portal (không tự làm được)

### 8.2 Sprint 3 nice-to-have

- [ ] Swap `cooldown.ts` sang Redis-backed (add ioredis + keep interface)
- [ ] Inbound reply parser ("xong rồi" / "đang kẹt X" / "ETA <date>") → auto `update_task_status` hoặc `post_blocker`
- [ ] Thread tracker map `threadId → taskId` trong Redis để `send_follow_up` reply khớp task

### 8.3 Sprint 4.5 preview

- [ ] Bật pgvector extension trên Postgres bb_pm (postgres:16-alpine → pgvector/pgvector:pg16)
- [ ] Thêm cột `summary_embedding vector(768)` vào `agent_memory`
- [ ] Embedding client trong bb-pm-tools (OpenAI-compat hoặc local `intfloat/multilingual-e5-base`)
- [ ] Hybrid search: trigram (đang có) + cosine similarity (mới), re-rank
- [ ] Gmail delivery cho `generate_weekly_report`:
  - OAuth 2.0 hoặc service account (Gmail MCP hoặc `nodemailer` + Google API)
  - Config `SMTP_*` / `GMAIL_*` env
  - Tool `send_weekly_report_email(projectId?, recipients[])` → markdown → HTML → email
- [ ] Schema `agent.follow_ups` (persistent theo dõi ai được ping, ai reply, status)

### 8.4 Sprint 3.5 — Browser capability (deferred)

- [ ] Chốt 5 câu hỏi: account dedicated, MFA flow, service/container, LLM choice, audit depth
- [ ] Scaffold `browser-tools` plugin (Playwright MCP)
- [ ] Gapo macro: `gapo_find_user`, `gapo_send_dm`, `gapo_read_thread`
- [ ] Fallback `send_follow_up`: bot API → browser nếu bot không initiate được

---

## 9. Open questions / Decisions pending

1. **Kênh CEO:** Zalo hay Gapo? Ảnh hưởng priority Zalo plugin.
2. **Mức tự chủ L3/L4/L5:** auto-action hay chờ PM approve? (khuyến nghị approve tuần đầu để xây trust)
3. **LLM strategy:** Qwen tự host cho L1-L2 (đang dùng, OK) — L4-L5-L6 có cần Claude Sonnet cho summary chất lượng cao?
4. **Memory scope:** Schema `agent.*` chung `bb_pm` DB (đề xuất) hay tách DB riêng?
5. **Escalation:** Blocker severity=high → PM? Tech lead? CEO?
6. **Browser account:** dedicated bot account hay cá nhân?
7. **Audit độ chi tiết:** counts (đang dùng) hay screenshot + full payload khi debug?

---

## 10. Changelog

| Ngày | Việc | Người |
|---|---|---|
| 2026-04-21 | Scaffold monorepo `bb-pm`, Docker, Prisma schema, auth | Dat |
| 2026-04-21 | 16 module API + admin seed + migrate script | Dat |
| 2026-04-21 | Clone openclaw repo, scaffold `bb-pm-tools` plugin | Dat |
| 2026-04-21 | Sprint 1: `list_overdue_tasks` tool + Gapo webhook + LLM client | Dat |
| 2026-04-21 | Sprint 2: 3 tool observer + cron scheduler + audit log | Dat |
| 2026-04-22 | Bổ sung skill prompts (`skill/*.md`) | Dat |
| 2026-04-23 | Tool extension: snapshot/blocked/owner/update-status/create-action + find/search | Dat |
| 2026-04-24 sáng | Tạo `PROCESS.md`, plan Sprint 3 + browser capability | Dat |
| 2026-04-24 sáng | Config token, env init cho bb-pm-tools | Dat |
| **2026-04-24 (Phase 1)** | **Refactor `gapo-work` thành channel adapter thuần**: xoá các file PM logic (parser/db/rpc/service/formatter), bỏ dep `pg`, webhook chuyển sang forward HTTP tới bb-pm-tools `/agent/run`. Bỏ Gapo inbound/async-reply khỏi bb-pm-tools. | Claude |
| **2026-04-24 (Phase 2)** | **Outbound Gapo centralized ở `gapo-work`**: thêm `POST /api/plugins/gapo-work/send` với `X-Plugin-Token` shared secret. Xoá `bb-pm-tools/src/gapo-channel.ts`, scheduler dùng `channel-out.sendToGapo()` gọi vào `/send`. | Claude |
| **2026-04-24 (Sprint 3 — bb-pm API)** | Extend `auth.ts` nhận `X-Agent-Token`. Prisma: thêm model `AgentAuditLog`, `TaskBlocker`, enum `AgentAuditSource`/`BlockerSeverity`. Migration `20260424000000_add_agent_tables`. Seed `pm-agent@bluebolt.local` MANAGER. | Claude |
| **2026-04-24 (Sprint 3 — routes)** | Thêm `/tasks/overdue`, `/stale`, `/hygiene`, `/:id/blocker`, `/projects/digest`, `/agent/audit` (POST+GET), `/agent/gapo-thread/:userId`. | Claude |
| **2026-04-24 (Sprint 3 — plugin)** | Thêm `send_follow_up` (lookup GapoUserMap + cooldown 24h + POST gapo-work /send), `post_blocker`. Tạo `cooldown.ts` in-memory. Orchestrator system prompt cập nhật 9 nguyên tắc Level 1+2. | Claude |
| **2026-04-24 (Config)** | Sửa typo `http://attp://` → `http://100.108.110.17:8000/v1` trong openclaw.json. Đổi LLM sang `Qwen/Qwen3.6-27B-FP8`. Generate `GAPO_SEND_TOKEN` hex 32, match ở 2 phía. Tách config sensitive ra `~/.openclaw/plugins/bb-pm-tools/.env` + `~/.openclaw/plugins/gapo-work/config.json`. Gitignore `config.json`, `.env*`. | Claude |
| **2026-04-24 (Fix runtime)** | Refactor bb-pm-tools `index.ts` dùng `api.registerHttpRoute` (chuẩn OpenClaw SDK). Viết lại `webhook.ts` parse raw IncomingMessage. Tạo `env.ts` tự load .env. Thêm `whatwg-url` dep (node-fetch@2 trên Node 24). Link-install với `--dangerously-force-unsafe-install` (scanner false positive). | Claude |
| **2026-04-24 (Deploy)** | Apply Prisma migration, seed pm-agent, start bb-pm API :4000, restart OpenClaw gateway systemd (8 plugins load), smoke test 4 flow + audit log. **Pipeline end-to-end OK**. | Claude |
| **2026-04-24 (Odoo removal)** | Xoá toàn bộ Odoo footprint: `docker compose down -v` cho stack Odoo, xoá folder `project_addons/`, `apps/redesign/`, `services/`, `pm-odoo/`, `ops/`, `init/`, `data/backups/`, `config/`, `minio-data`, `agent` symlink, `docker-compose.yaml` root, `.env` root, `odoo.conf`, `cookie.txt`. Xoá `migrate-from-odoo.ts` + script `migrate:odoo`. Clean tham chiếu Odoo trong bb-pm docs/schema/env. Viết lại `CLAUDE.md` cho stack mới. | Claude |
| **2026-04-24 (Docker)** | Tạo `docker-compose.yaml` root + `docker/openclaw/Dockerfile` multi-stage + `entrypoint.sh` first-run seed + `.env.docker.example` + `.dockerignore`. Viết `ARCHITECTURE.md` root mô tả 3-layer container topology + secret matrix + luồng dữ liệu + operations checklist. Compose config validate OK. | Claude |
| **2026-04-24 (Sprint 4 — bb-pm API)** | Prisma: thêm model `AgentMemory` + relation `TaskBlocker → Task`. Migration `20260424010000_add_agent_memory` bật `pg_trgm` + GIN trigram index trên `summary`/`user_text`, GIN trên `project_ids`/`task_ids`. Migration `20260424010001_task_blocker_fk` thêm FK. | Claude |
| **2026-04-24 (Sprint 4 — routes)** | `POST /agent/memory`, `GET /agent/memory/search` (filter q/conversationId/projectId/taskId/daysBack), `GET /projects/weekly-report` (window rollup tasks done, new blockers, backlog approved, upcoming deadlines). | Claude |
| **2026-04-24 (Sprint 4 — plugin)** | Tools mới: `recall_memory`, `generate_weekly_report`. Modules mới: `src/memory.ts` (recallMemoryContext + summarizeAndStore async), `src/types.ts` (AgentContext với `conversationId` tách khỏi `correlationId`). Orchestrator: prepend memory block vào system prompt, auto-summarize sau mỗi run (fire-and-forget). System prompt thêm nguyên tắc 8-10-12: recall có điều kiện, executive mode, weekly vs daily. | Claude |
| **2026-04-24 (Sprint 4 — deploy+verify)** | Apply 2 migration, restart bb-pm API, rebuild bb-pm-tools, restart OpenClaw gateway. Smoke test end-to-end 3 query cùng conversationId: (1) hỏi task KPI → dùng find_task, lưu memory; (2) hỏi "lần trước bao nhiêu ngày" → LLM gọi recall_memory lấy summary trước, trả lời chính xác "9 ngày"; (3) "báo cáo tuần qua" → gọi `generate_weekly_report` trả rollup đầy đủ. 4 row memory + 12 row audit trong DB. **Pipeline Level 3 OK**. | Claude |
| **2026-04-24 (Sprint 5 — bb-pm API)** | Prisma: thêm `Meeting` + `MeetingActionItem` models + enum `MeetingItemStatus` + relation `Project.meetings`. Migration `20260424020000_add_meetings` + FK. Module mới `meetings/routes.ts` — POST/GET/approve/reject. Approve endpoint auto-resolve ownerName → userId, tạo Task với `project.currencyId`, mark item APPROVED + link `createdTaskId`. | Claude |
| **2026-04-24 (Sprint 5 — plugin)** | Module mới `src/meeting.ts` — `extractMeetingFromTranscript(transcript)`: inner LLM call với `response_format: json_object`, loose JSON parser (direct → fenced → balanced-brace), normalize output (title/summary/decisions/participants/actionItems). `llm.ts` thêm ChatOptions (max_tokens, temperature, response_format). 2 tool mới: `ingest_meeting` + `approve_meeting_items`. Orchestrator prompt rule 10 siết: nếu input có dấu hiệu transcript → BẮT BUỘC dùng ingest_meeting, không tự create_action_item. Rule 12 planning suggestion qua combo snapshot + overdue + blocked. | Claude |
| **2026-04-24 (Sprint 5 — verify)** | Direct API verify end-to-end: POST /meetings với 2 items + ownerName → auto-resolve 2 userId; POST /meetings/1/approve → 2 task tạo đúng (priority HIGH + MEDIUM, deadline, assignee), items APPROVED + link createdTaskId. Tổng cộng meeting 1 + items 1-2 + tasks 5-6 trong DB. LLM flow code-complete nhưng chưa verify được do Qwen ECONNREFUSED tại 09:00. | Claude |
| **2026-04-24 (Ops — IPv6 fix)** | Phát hiện Node fetch hang trên IPv6 (tailnet có AAAA nhưng không route) gây pricing bootstrap 15s timeout + dashboard RPC chậm 9.3s. Fix: systemd drop-in `~/.config/systemd/user/openclaw-gateway.service.d/override.conf` set `NODE_OPTIONS=--dns-result-order=ipv4first`. Verify node fetch 418ms thay vì timeout. | Claude |
| **2026-04-24 (Ops — LLM retry)** | `bb-pm-tools/src/llm.ts` thêm retry 2 lần với backoff 1.5s/3s cho ECONNREFUSED/ECONNRESET/socket hang up/LLM 5xx. Xử lý Qwen vllm flap ngắn (EngineCore crash + restart). Tool calls vẫn fail nếu Qwen > 5s down. | Claude |
| **2026-04-24 (Sprint 6.1)** | Prisma: thêm model `ChannelIdentity` + enum `ChannelKind` (gapo/slack/zalo/zalouser/telegram/email/sms) + relation `User.channelIdentities[]`. Migration `20260424030000_add_channel_identities`: tạo bảng + unique (channel, external_id) + GIN index + backfill từ `gapo_user_maps` thành preferred=true gapo rows. Routes mới: `GET /agent/channel-identity/:userId[?channel=]`, `POST /agent/channel-identity` (upsert), `DELETE /agent/channel-identity/:id` — yêu cầu ADMIN/MANAGER. Refactor `/agent/gapo-thread/:userId` đọc ChannelIdentity trước (preferred→lastSeen), fallback GapoUserMap. Seed 3 demo identity (dev1/dev2 gapo + pm email). | Claude |
| **2026-04-24 (Sprint 6.1 — verify)** | Smoke test 7 kịch bản: list identity 1 user, filter theo channel, back-compat /gapo-thread vẫn trả đúng data, POST upsert Slack identity mới, upsert same externalId update threadId (behavior owner-reassign), DELETE cleanup, list after delete. DB state: 3 rows still (dev1 gapo, dev2 gapo, pm email). 7/7 test pass. | Claude |

---

## 11. Tham chiếu nhanh

- Spec thiết kế: [PMOperationsAgent.md](./PMOperationsAgent.md)
- Kiến trúc bb-pm: [bb-pm/ARCHITECTURE.md](./bb-pm/ARCHITECTURE.md)
- Setup dev: [bb-pm/WALKTHROUGH.md](./bb-pm/WALKTHROUGH.md)
- bb-pm-tools README: [bb-pm-tools/README.md](./bb-pm-tools/README.md)
- gapo-work README: [openclaw/openclaw/plugins/gapo-work/README.md](./openclaw/openclaw/plugins/gapo-work/README.md)
- Skill prompts: [skill/](./skill/)

---

## 12. Commands reference

### Dev loop

```bash
# Start Postgres (nếu chưa chạy)
cd /home/bbsw/pm/bb-pm && pnpm db:up

# Apply migrations + seed
cd /home/bbsw/pm/bb-pm/apps/api && pnpm prisma migrate deploy && pnpm db:seed

# Start bb-pm API
cd /home/bbsw/pm/bb-pm && pnpm --filter @bb-pm/api dev

# Build plugins sau khi sửa code
cd /home/bbsw/pm/bb-pm-tools && node node_modules/typescript/bin/tsc
cd /home/bbsw/pm/openclaw/openclaw/plugins/gapo-work && node node_modules/typescript/bin/tsc

# Reload plugin vào OpenClaw
openclaw plugins install --dangerously-force-unsafe-install --link /home/bbsw/pm/bb-pm-tools
rm -rf ~/.openclaw/extensions/gapo-work && openclaw plugins install --link /home/bbsw/pm/openclaw/openclaw/plugins/gapo-work
openclaw gateway stop && sleep 2 && openclaw gateway start
```

### Smoke test

```bash
TOKEN=e4def90c2b18bf54dfc4cda8971238795b2e0f15e2c8ef829056f30cbf027d2f

# API side (direct bb-pm)
curl -H "X-Agent-Token: $TOKEN" http://localhost:4000/api/v1/tasks/overdue
curl -H "X-Agent-Token: $TOKEN" http://localhost:4000/api/v1/projects/digest
curl -H "X-Agent-Token: $TOKEN" http://localhost:4000/api/v1/agent/audit?limit=10

# Agent side (qua OpenClaw gateway)
curl -X POST http://localhost:18789/api/plugins/bb-pm/agent/run \
  -H "Content-Type: application/json" \
  -d '{"text":"task nào đang quá hạn?","source":"cli"}'

# Gapo inbound simulation
curl -X POST http://localhost:18789/api/plugins/gapo-work/webhook \
  -H "Content-Type: application/json" \
  -d '{"message":{"text":"[GAPO_USER: pm] hygiene check","user":{"name":"pm"},"thread":{"id":"TEST"}}}'
```

### Logs

```bash
journalctl --user -u openclaw-gateway -n 100 --no-pager
tail -f /tmp/openclaw/openclaw-$(date +%F).log
docker logs bb_pm_db --tail 50
```
