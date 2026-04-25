# PM Operations Agent — System Architecture

AI agent tự động hoá công việc Project Manager qua chat (Gapo Work), tool-calling LLM (Qwen self-hosted), và backend REST (Fastify + Prisma).

Tài liệu liên quan:
- [PMOperationsAgent.md](./PMOperationsAgent.md) — spec product, 8 flow, 6 sprint
- [PROCESS.md](./PROCESS.md) — tracker tiến độ + changelog
- [bb-pm/ARCHITECTURE.md](./bb-pm/ARCHITECTURE.md) — chi tiết backend bb-pm
- [CLAUDE.md](./CLAUDE.md) — hướng dẫn cho Claude Code khi code trong repo này

---

## 1. High-level diagram

```
 ┌──────────────────────────────────────────────────────────────────────┐
 │                     Gapo Work bot  (outgoing webhook)                │
 └───────────────────────────────────┬──────────────────────────────────┘
                                     │ HTTPS, payload tuỳ Gapo
                                     ▼
 ┌──────────────────────────────────────────────────────────────────────┐
 │  openclaw  (Node 22, container)                                      │
 │  ├─ OpenClaw gateway :18789                                          │
 │  ├─ plugin gapo-work      (channel adapter thuần)                    │
 │  │    POST /api/plugins/gapo-work/webhook     ←── inbound Gapo       │
 │  │    POST /api/plugins/gapo-work/send        ←── outbound đi qua    │
 │  └─ plugin bb-pm-tools    (PM orchestrator)                          │
 │       POST /api/plugins/bb-pm/agent/run       ←── LLM ReAct          │
 │       cron  digest / hygiene                  ───▶ gapo-work /send   │
 └───────────┬──────────────────────────────┬─────────────────┬─────────┘
             │ X-Agent-Token                │ /v1/chat/...   │
             ▼                              ▼                │
 ┌────────────────────────┐        ┌────────────────────┐   │
 │ bb_pm_api  (Fastify)   │        │  LLM endpoint       │   │
 │  /api/v1/...           │        │  (self-hosted Qwen) │   │
 │   auth + domain CRUD   │        │  OpenAI-compatible  │   │
 │   agent endpoints      │        │  tool-calling       │   │
 └───────────┬────────────┘        └────────────────────┘   │
             │ Prisma                                        │
             ▼                                               │
 ┌────────────────────────┐        ┌────────────────────┐   │
 │ bb_pm_db (Postgres 16) │◀───────┤  bb_pm_web (Nginx) │───┘
 │  15 domain + 2 agent   │        │  React SPA         │
 │  tables                │        └────────────────────┘
 └────────────────────────┘
```

Ranh giới layer (nguyên tắc cứng):

| Layer | Sở hữu | KHÔNG chứa |
|---|---|---|
| **Channels** (`gapo-work`) | Gapo bot credential (`GAPO_BOT_TOKEN`), parse/gửi tin Gapo | LLM call, PM logic, DB |
| **Orchestrator** (`bb-pm-tools`) | `BB_PM_AGENT_TOKEN`, LLM key, ReAct loop, tool catalog, cron, cooldown | Channel credential, DB schema |
| **Backend** (`bb_pm_api`) | `AGENT_API_TOKEN`, `JWT_SECRET`, schema + state machine, company scoping | Chat state, prompt |

Mọi logic "cần cả con người dùng qua Web UI và agent dùng qua chat" PHẢI nằm ở `bb_pm_api`. Orchestrator và channel chỉ là consumer.

---

## 2. Container topology

Định nghĩa tại [docker-compose.yaml](./docker-compose.yaml). Tất cả service cùng network bridge `pm_bb_pm_net`.

| Service | Image | Port (host) | Depends on | Persistence |
|---|---|---|---|---|
| `bb_pm_db` | `postgres:16-alpine` | `5433:5432` | — | volume `bb_pm_pgdata` |
| `bb_pm_api` | build `bb-pm/apps/api/Dockerfile` | `4000:4000` | `bb_pm_db` healthy | — |
| `bb_pm_web` | build `bb-pm/apps/web/Dockerfile` (nginx) | `5173:80` | `bb_pm_api` | — |
| `openclaw` | build `docker/openclaw/Dockerfile` | `18789:18789` | `bb_pm_api` | volume `openclaw_home` |

Services giao tiếp bằng tên container qua DNS nội bộ của docker network:

```
openclaw   ──▶  bb_pm_api:4000/api/v1      (X-Agent-Token)
bb_pm_api  ──▶  bb_pm_db:5432               (Postgres)
bb_pm_web  ──▶  browser → localhost:4000   (CORS)
openclaw   ──▶  host.docker.internal:8000  (LLM — tailnet/host)
gapo-work  ──▶  localhost:18789             (same-container, inter-plugin)
```

`extra_hosts: host.docker.internal:host-gateway` trên service `openclaw` để container với ra được LLM endpoint host/tailnet (Linux docker).

---

## 3. Identity & secrets

Mỗi secret **chỉ sống ở 1 layer**. Hai secret chia sẻ giữa 2 layer qua HTTP header:

```
┌────────────┐                          ┌────────────┐                          ┌────────────┐
│ gapo-work  │  ── X-Plugin-Token ───▶  │ bb-pm-tools│  ── X-Agent-Token ─────▶ │ bb_pm_api  │
│            │  ◀── /agent/run body ──  │            │  ◀── JSON data ─────────  │            │
└────────────┘                          └────────────┘                          └────────────┘
     │                                       │                                       │
     │ Gapo bot token                        │ LLM API key                           │ JWT_SECRET
     │ sendToken (shared ↑)                  │ BB_PM_AGENT_TOKEN (shared →)          │ AGENT_API_TOKEN (shared ←)
     ▼                                       ▼                                       ▼
    Gapo API                            Qwen /v1                                Postgres creds
```

Giá trị cụ thể (generate bằng `openssl rand -hex 32`):

| Env var (compose) | Xuất hiện ở service | Vai trò |
|---|---|---|
| `AGENT_API_TOKEN` | `bb_pm_api`, `openclaw` (as `BB_PM_AGENT_TOKEN`) | Agent service user auth |
| `GAPO_SEND_TOKEN` | `openclaw` (2 plugin cùng đọc) | Inter-plugin outbound |
| `GAPO_BOT_TOKEN` | `openclaw` (gapo-work) | Gapo bot API |
| `JWT_SECRET` | `bb_pm_api` | Human JWT |
| `OPENCLAW_GATEWAY_TOKEN` | `openclaw` | Admin RPC |
| `LLM_API_KEY` | `openclaw` | LLM provider |
| `POSTGRES_PASSWORD` | `bb_pm_db`, `bb_pm_api` | DB |

File `.env` ở root repo cho docker-compose đọc; không commit (xem [.gitignore](./.gitignore) / [.env.docker.example](./.env.docker.example)).

Bên trong container openclaw, entrypoint tự seed:
- `/root/.openclaw/openclaw.json` (gateway + model provider)
- `/root/.openclaw/plugins/bb-pm-tools/.env` (plugin env)
- `/root/.openclaw/plugins/gapo-work/config.json` (gapo bot + sendToken + orchestrator URL)

Những file này được mount ra volume `openclaw_home` nên persist qua container rebuild. Seed **chỉ ghi khi file chưa tồn tại** — không overwrite customization.

---

## 4. Luồng dữ liệu — 3 use case

### 4.1 PM hỏi observational qua Gapo

```
PM ──"task nào quá hạn?"─▶ Gapo bot ──webhook──▶ openclaw:18789
                                                      │
                             gapo-work/webhook: parse Gapo payload
                                                      │ HTTP
                                                      ▼
                             bb-pm-tools/agent/run: runAgent(text)
                                ├─ chat(Qwen, systemPrompt, tools)
                                ├─ LLM trả tool_calls: list_overdue_tasks()
                                ├─ tools.ts handler:
                                │     bbPm.listOverdueTasks()
                                │        → GET /tasks/overdue  (X-Agent-Token)
                                │           bb_pm_api → Postgres
                                │        ← { data: [...], meta: {total} }
                                ├─ audit POST /agent/audit (fire-and-forget)
                                ├─ chat(...) lần 2 → LLM compose text VN
                                └─ return { reply }
                                                      │
                             gapo-work/webhook: sendReply(convId, reply)
                                                      │
                                     ──▶ Gapo API ──▶ PM trên Gapo
```

### 4.2 Cron digest 08:00 hàng sáng

```
scheduler.ts cron 0 8 * * *
    │
    ▼
runAgent("Tổng hợp báo cáo sáng...", ctx={source:"cron", correlationId})
    ├─ LLM gọi generate_daily_digest + list_overdue_tasks song song/tuần tự
    ├─ bb_pm_api GET /projects/digest + /tasks/overdue
    ├─ LLM compose markdown digest
    ▼
sendToGapo(CRON_DAILY_DIGEST_TARGET, markdown)
    │ POST http://localhost:18789/api/plugins/gapo-work/send
    │ Header X-Plugin-Token: <GAPO_SEND_TOKEN>
    │ Body   {conversationId, text}
    ▼
gapo-work/send.ts → client.sendReply → Gapo API → PM room
```

### 4.3 Follow-up có cooldown 24h

```
PM ──"ping A về task 42"──▶ ...agent/run
    │
    ▼
LLM: find_user("A") → userId=5, rồi send_follow_up(5, 42, "Chào A...")
    │
    ▼
tools.ts send_follow_up handler:
    key = "followup:5:42"
    ├─ cooldown.isCoolingDown(key)?
    │     yes → return {skipped:"cooldown", remainingSec}
    │     no  → tiếp
    ├─ bbPm.getGapoThread(5)
    │     → GET /agent/gapo-thread/5
    │     → bb_pm_api tra gapo_user_maps
    │     ← {gapoThreadId: "583..."}   (hoặc 404 → skipped:"no_gapo_thread")
    ├─ sendToGapo(threadId, question)
    │     → openclaw/gapo-work/send → Gapo API
    ├─ cooldown.mark(key, 86400)
    └─ return {sent:true, threadId, cooldownSec:86400}
```

Store cooldown hiện tại là `Map<string, {expiresAt}>` in-memory trong `bb-pm-tools/src/cooldown.ts`. OK cho single-process. Khi scale multi-container cần Redis — giữ interface, swap implementation.

---

## 5. Database schema

Postgres 16 ở `bb_pm_db`, schema `public`. Định nghĩa tại [bb-pm/apps/api/prisma/schema.prisma](./bb-pm/apps/api/prisma/schema.prisma).

**15 bảng domain:**

```
companies, users, customers, currencies,         ← support
projects, tasks, backlogs, members, member_rates,
milestones, scopes, tags, project_tags, task_tags,
gapo_user_maps                                   ← domain
```

**6 bảng agent:**

- `agent_audit_log` (migration `20260424000000`) — mỗi tool call ghi 1 row: `{tool, argsJson, resultJson, durationMs, errorMessage, correlationId, source: chat|cron|cli|other}`.
- `task_blockers` (migration `20260424000000` + FK `20260424010001`) — history blocker có cấu trúc: `{taskId, severity: LOW|MED|HIGH, description, resolvedAt?}`. Song song, text đã được append vào `tasks.issues` cho UI đọc nhanh.
- `agent_memory` (migration `20260424010000` — Sprint 4) — summary per-run cho memory recall: `{conversationId, userText, replyText, summary, toolsUsed[], projectIds[], taskIds[], correlationId, source, createdAt}`. Extension `pg_trgm` + GIN trigram index cho recall bằng ILIKE trên `summary` + `user_text`; GIN array index cho filter `projectIds`/`taskIds`. pgvector swap ở S4.5.
- `meetings` (migration `20260424020000` — Sprint 5) — meeting + transcript + summary/decisions/participants: `{companyId, projectId?, title?, heldAt, transcript, summary?, decisions[], participants[], createdById, timestamps}`. FK project→`SET NULL`.
- `meeting_action_items` (cùng migration) — DRAFT/APPROVED/REJECTED items trích xuất: `{meetingId, title, description?, ownerName?, ownerUserId?, dueDate?, priority, status, createdTaskId?}`. FK meeting→CASCADE. Sau approve, `createdTaskId` trỏ task thật.
- `channel_identities` (migration `20260424030000` — Sprint 6.1) — generic mapping user ↔ external platform: `{userId, channel: gapo\|slack\|zalo\|zalouser\|telegram\|email\|sms, externalId, externalName?, threadId?, preferred, lastSeenAt, timestamps}`. Unique `(channel, externalId)`. 1 user có thể có nhiều row cùng 1 channel (ví dụ 2 Telegram chat) — `preferred=true` đánh dấu default cho `send_follow_up` routing. Backfill từ `gapo_user_maps` → gapo identities khi migrate. Legacy `gapo_user_maps` giữ lại làm fallback read-only.

Scope: mọi endpoint khác `admin/*` auto-filter `WHERE companyId = req.user.companyId` trừ super-admin. Agent user là MANAGER (không super-admin) nên cũng company-scoped.

---

## 6. Tools catalog

19 tool tại [bb-pm-tools/src/tools.ts](./bb-pm-tools/src/tools.ts). Mỗi tool = 1 HTTP call sang bb-pm API, không tool nào chạm DB trực tiếp.

**Quan sát (Level 1) — 7 tool:**

| Tool | API endpoint | Mô tả |
|---|---|---|
| `list_overdue_tasks` | `GET /tasks/overdue` | Task quá hạn deadline |
| `list_stale_tasks` | `GET /tasks/stale` | Task không update >= N ngày |
| `check_data_hygiene` | `GET /tasks/hygiene` | Missing owner/deadline/stale-status |
| `generate_daily_digest` | `GET /projects/digest` | Rollup + per-project completion |
| `get_project_snapshot` | `GET /projects/:id` + `/tasks` | 1 dự án + open tasks |
| `list_blocked_tasks` | `GET /tasks?status=BLOCKED` | Dự phòng; hiện không dùng |
| `get_task_owner` | `GET /tasks/:id` | Lookup assignee |

**Điều phối (Level 2) — 4 tool:**

| Tool | API endpoint | Mô tả |
|---|---|---|
| `update_task_status` | `POST /tasks/:id/transition` | State machine TODO↔IN_PROGRESS↔REVIEW↔DONE |
| `create_action_item` | `POST /tasks/by-project/:id` | Tạo task mới |
| `send_follow_up` | `GET /agent/gapo-thread/:userId` + internal `/send` | Ping có cooldown |
| `post_blocker` | `POST /tasks/:id/blocker` | Ghi blocker + severity |

**Tổng hợp (Level 3 — Sprint 4) — 2 tool:**

| Tool | API endpoint | Mô tả |
|---|---|---|
| `generate_weekly_report` | `GET /projects/weekly-report` | Window rollup 7/30/90 ngày — done / blocker mới / hours approved / upcoming deadlines |
| `recall_memory` | `GET /agent/memory/search` | Recall summary hội thoại trước — ưu tiên same conversationId, fallback trigram |

**Điều phối Level 4 — Sprint 5 (Meeting) — 2 tool:**

| Tool | API endpoint | Mô tả |
|---|---|---|
| `ingest_meeting` | `POST /meetings` | Inner LLM call extract strict JSON → insert meeting + DRAFT items. ownerName auto-resolve sang userId best-effort |
| `approve_meeting_items` | `POST /meetings/:id/approve` | Convert DRAFT → Task thật. Per-item failures báo về `skipped[]` |

Human-in-the-loop: LLM chỉ tạo DRAFT, user xem + nói "approve items X, Y" rồi agent gọi `approve_meeting_items` — không auto-create.

Planning suggestion (Flow 8) không thêm tool riêng. System prompt hướng dẫn LLM khi user hỏi "đề xuất tiếp theo" thì combo `get_project_snapshot` + `list_overdue_tasks` + `list_blocked_tasks` rồi compose 3-5 gợi ý.

Orchestrator tự động:
- Gọi `GET /agent/memory/search?conversationId=...` ở đầu mỗi run → inject block "BỐI CẢNH TRƯỚC ĐÓ" vào system prompt.
- Sau khi tạo reply, spawn 1 LLM call tóm tắt 2 câu → `POST /agent/memory` (fire-and-forget, không block reply).
- LLM có thể tự gọi `recall_memory` với keyword cụ thể khi cần tìm ngữ cảnh cross-conversation.

**Tra cứu — 5 tool:**

| Tool | API endpoint |
|---|---|
| `find_project`, `search_projects` | `GET /projects?q=` |
| `find_task`, `search_tasks` | `GET /tasks?q=` |
| `find_user` | `GET /users` (client-side filter) |

System prompt 9 nguyên tắc ở [bb-pm-tools/src/orchestrator.ts](./bb-pm-tools/src/orchestrator.ts) chốt cách LLM dùng tool (không tự ý follow-up, không tự đổi status, không bịa số liệu, danh sách > 5 task thì nhóm theo dự án, priority HIGH/URGENT lên đầu).

---

## 7. Build & deployment

### First-time setup

```bash
# 1. Clone repo, ensure bb-pm submodule / openclaw submodule initialized
git clone <repo>
cd pm
git submodule update --init --recursive

# 2. Env
cp .env.docker.example .env
# Edit: generate AGENT_API_TOKEN and GAPO_SEND_TOKEN with `openssl rand -hex 32`,
# put JWT_SECRET, GAPO_BOT_TOKEN (từ Gapo dev portal), LLM_BASE_URL.

# 3. Build + start
docker compose up -d --build

# 4. Apply migrations + seed (đầu tiên)
docker compose exec bb_pm_api sh -c 'cd /app/apps/api && pnpm prisma migrate deploy && pnpm prisma db seed'

# 5. Smoke test
curl http://localhost:4000/api/v1/health
TOKEN=$(grep ^AGENT_API_TOKEN .env | cut -d= -f2)
curl -H "X-Agent-Token: $TOKEN" http://localhost:4000/api/v1/projects/digest
curl -X POST http://localhost:18789/api/plugins/bb-pm/agent/run \
     -H 'Content-Type: application/json' \
     -d '{"text":"task nào quá hạn?","source":"cli"}'
```

### Expose Gapo webhook ra internet

Gapo bot cần public URL. Các lựa chọn:
1. **Reverse proxy** (khuyến nghị prod): Cloudflare Tunnel / Nginx public → `http://<host>:18789/api/plugins/gapo-work/webhook`.
2. **ngrok / cloudflared** (dev): `cloudflared tunnel --url http://localhost:18789` rồi trỏ Gapo webhook vào URL trả về.
3. Direct public IP: cần firewall mở port 18789 + TLS termination tự xử lý.

### Cập nhật code

```bash
# Plugin changes (bb-pm-tools / gapo-work)
docker compose build openclaw && docker compose up -d openclaw

# bb-pm API changes
docker compose build bb_pm_api && docker compose up -d bb_pm_api

# Web changes
docker compose build bb_pm_web && docker compose up -d bb_pm_web
```

Volume `openclaw_home` giữ config + extension symlinks qua rebuild. Nếu muốn reset hoàn toàn: `docker compose down -v` (cẩn thận — xoá cả `bb_pm_pgdata`).

### Logs

```bash
docker compose logs -f openclaw       # gateway + plugin
docker compose logs -f bb_pm_api      # Fastify
docker compose logs --tail 50 bb_pm_db
```

---

## 8. Operations — first-line checklist

| Triệu chứng | Hướng fix |
|---|---|
| Agent trả "0 task" dù data có | LLM tool-calling không parse đúng — `curl $LLM_BASE_URL/chat/completions` test xem response có `tool_calls` không. Kiểm tra `compat.supportsTools: true` trong openclaw.json. |
| `/api/v1/tasks/overdue` trả 401 | `AGENT_API_TOKEN` trong `.env` (host) ≠ `BB_PM_AGENT_TOKEN` bake vào openclaw. Rebuild cả 2 service sau khi sync. |
| `send_follow_up` luôn `skipped: no_gapo_thread` | `gapo_user_maps` chưa seed. Insert mapping user_id ↔ gapo_thread_id hoặc hỏi user đúng Gapo ID. |
| Cron digest không chạy | Check `CRON_DAILY_DIGEST_TARGET` trong `.env` — không được rỗng. Xem `docker compose logs openclaw | grep cron`. |
| Gapo webhook 502 | Public URL chưa chỉ về container. `curl localhost:18789/api/plugins/gapo-work/webhook -X POST -d '{}'` từ host để test. |
| LLM unreachable | `openclaw` container không tới được `host.docker.internal`. Trên Linux phải có `extra_hosts` (đã cấu hình). Nếu LLM ở tailnet, host phải có Tailscale up. |
| `docker compose build` lỗi `corepack` | Node version trong Dockerfile. Check base image `node:22-bookworm-slim`. |
| Cooldown không reset sau reply của user | Sprint 3 chỉ ghi cooldown; parsing reply để clear cooldown là Sprint 3.5+ (chưa có). |

---

## 9. Roadmap liên quan deployment

| Sprint | Dependency deployment |
|---|---|
| S3 (✅) | Docker setup hiện tại — đủ chạy Level 1+2 |
| S3.5 (deferred) | Playwright container mới làm channel fallback (Browser DM) |
| S4 | Redis container cho multi-process cooldown + agent.memory (pgvector extension trên `bb_pm_db`) |
| S4 | Gmail MCP — thêm env `GOOGLE_*` + OAuth volume |
| S5 | Service transcription (Whisper?) cho Flow 4 meeting transcript |
| S6 | Multi-instance OpenClaw + Redis cluster; observability stack (Prometheus/Grafana, Loki) |

---

## 10. Tham chiếu nhanh

- `docker-compose.yaml` — service definitions
- `.env.docker.example` — required variables
- `docker/openclaw/Dockerfile` — OpenClaw image build
- `docker/openclaw/entrypoint.sh` — first-run seed + plugin linking
- `bb-pm/apps/api/Dockerfile` — Fastify image
- `bb-pm/apps/web/Dockerfile` — React + nginx
- `bb-pm-tools/` — orchestrator plugin source
- `openclaw/openclaw/plugins/gapo-work/` — channel plugin source
- `bb-pm/apps/api/prisma/schema.prisma` — DB schema
- `PMOperationsAgent.md` — product spec
- `PROCESS.md` — tracker tiến độ
