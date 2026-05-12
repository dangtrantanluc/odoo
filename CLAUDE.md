# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**PM Operations Agent** — AI agent tự động hoá công việc Project Manager hàng ngày cho BlueBolt (Vietnamese company). 3-layer kiến trúc HTTP-boundary:

1. **Channels** (gapo-work plugin) — adapter thuần cho Gapo Work bot. Không có PM logic.
2. **OpenClaw orchestrator** (bb-pm-tools plugin) — ReAct loop, LLM tool-calling (Qwen self-hosted), cron scheduler, follow-up cooldown.
3. **bb-pm API** (Fastify + Prisma + Postgres) — source of truth cho projects/tasks/backlogs/audit.

Chi tiết spec: [PMOperationsAgent.md](./PMOperationsAgent.md) · Trạng thái sprint: [PROCESS.md](./PROCESS.md) · Vận hành/troubleshoot: [RUNBOOK.md](./RUNBOOK.md)

## Repo layout

```
/home/bbsw/pm/
├── bb-pm/                         # Fastify API + React SPA (source of truth)
│   ├── apps/api/                  # Fastify + Prisma
│   ├── apps/web/                  # React SPA
│   ├── packages/shared/           # Zod schemas share FE↔BE
│   ├── docker-compose.yaml        # Postgres :5433 + API + Web
│   └── ARCHITECTURE.md · WALKTHROUGH.md
├── bb-pm-tools/                   # OpenClaw plugin — PM agent orchestrator
│   └── src/ (config|env|tools|orchestrator|cooldown|scheduler|channel-out)
├── openclaw/openclaw/             # OpenClaw gateway submodule
│   └── plugins/gapo-work/         # OpenClaw plugin — Gapo channel adapter
├── skill/                         # Agent role prompt cards (PO, SA, FE, BE, ...)
├── PMOperationsAgent.md           # Spec gốc — kiến trúc 3-layer, 8 flow, 6 sprint
├── PROCESS.md                     # Progress tracker + changelog
└── CLAUDE.md                      # File này
```

**Runtime config files** (ngoài repo, không commit):
- `~/.openclaw/openclaw.json` — OpenClaw gateway config (plugin entries, LLM provider)
- `~/.openclaw/plugins/gapo-work/config.json` — Gapo bot token, sendToken, orchestrator URL
- `~/.openclaw/plugins/bb-pm-tools/.env` — bb-pm API token, LLM, GAPO_SEND_TOKEN

## Running the stack

### Postgres + bb-pm API

```bash
cd /home/bbsw/pm/bb-pm

# Start Postgres :5433
docker compose up bb_pm_db -d

# Apply migrations + seed (idempotent)
pnpm --filter @bb-pm/api prisma migrate deploy
pnpm --filter @bb-pm/api prisma db seed

# Start API :4000 (dev watch)
pnpm --filter @bb-pm/api dev

# Health check
curl http://localhost:4000/api/v1/health
```

### OpenClaw gateway + plugins

```bash
# Build plugins sau khi sửa code
cd /home/bbsw/pm/bb-pm-tools && node node_modules/typescript/bin/tsc
cd /home/bbsw/pm/openclaw/openclaw/plugins/gapo-work && node node_modules/typescript/bin/tsc

# Reload plugin (link mode — không copy)
openclaw plugins install --dangerously-force-unsafe-install --link /home/bbsw/pm/bb-pm-tools
rm -rf ~/.openclaw/extensions/gapo-work
openclaw plugins install --link /home/bbsw/pm/openclaw/openclaw/plugins/gapo-work

# Restart gateway
openclaw gateway stop && sleep 2 && openclaw gateway start
openclaw gateway status

# Logs
journalctl --user -u openclaw-gateway -n 100 --no-pager
```

### Smoke test end-to-end

```bash
TOKEN=$(grep AGENT_API_TOKEN /home/bbsw/pm/bb-pm/.env | cut -d= -f2)

# Direct bb-pm API
curl -H "X-Agent-Token: $TOKEN" http://localhost:4000/api/v1/tasks/overdue
curl -H "X-Agent-Token: $TOKEN" http://localhost:4000/api/v1/projects/digest

# Qua OpenClaw gateway → LLM → tool → bb-pm API → reply
curl -X POST http://localhost:18789/api/plugins/bb-pm/agent/run \
  -H "Content-Type: application/json" \
  -d '{"text":"task nào đang quá hạn?","source":"cli"}'

# Gapo inbound simulation
curl -X POST http://localhost:18789/api/plugins/gapo-work/webhook \
  -H "Content-Type: application/json" \
  -d '{"message":{"text":"[GAPO_USER: pm] hygiene check","user":{"name":"pm"},"thread":{"id":"TEST"}}}'
```

## Kiến trúc chi tiết

### bb-pm API (Fastify + Prisma)

- Auth: JWT (web) HOẶC `X-Agent-Token` header (plugin). Service user `pm-agent@bluebolt.local` MANAGER.
- 18+ module REST: projects, tasks, backlogs, members, milestones, rates, scopes, tags, customers, uploads, dashboard, notifications, admin, auth, users, **agent** (audit + gapo-thread + memory + follow-up + **report SQL gateway** + **automations**).
- Schema: 15 bảng domain + `AgentAuditLog` + `TaskBlocker` + `AgentMemory` + `AgentFollowUp` + `Automation` + enum `AgentAuditSource`, `BlockerSeverity`, `FollowUpStatus`.
- Agent-specific endpoints: `/tasks/overdue`, `/tasks/stale`, `/tasks/hygiene`, `/tasks/:id/blocker`, `/projects/digest`, `/agent/audit`, `/agent/gapo-thread/:userId`, **`/agent/report/query` (Sprint 7 SQL gateway)**, **`/agent/report/schema` (DMMF→md)**, **`/agent/automations` (CRUD)**.
- Company-scoped: mọi query tự động `WHERE companyId = req.user.companyId` trừ super-admin.

#### Sprint 7 — Read SQL gateway

- `POST /agent/report/query` accept `{sql}` raw SELECT. Defense pyramid: AST guard (node-sql-parser, reject DML/system tables/multi-statement) → company_id scope must-have-WHERE → LIMIT cap 1000 → `SET statement_timeout=5s` → execute via `bb_pm_readonly` Postgres role (column-level grant on users excluding password_hash, table-level revoke on refresh_tokens) → result sanitize (regex strip secret cols).
- `GET /agent/report/schema` trả markdown DB schema (8KB, generated từ Prisma DMMF) cho LLM viết SQL chính xác (snake_case columns, enum values, common patterns).

### bb-pm-tools plugin (OpenClaw orchestrator)

- Endpoint: `POST /api/plugins/bb-pm/agent/run` (channel-agnostic, nhận `{text, correlationId?, source?}` → `{reply}`).
- LLM: multi-provider — `default` (Qwen self-host) + `gemini` (OpenAI-compat endpoint). Switch global qua `LLM_PROVIDER` env, per-call qua `chat(messages, tools, {provider})`.
- ReAct loop trong `orchestrator.ts` — tối đa 10 bước tool call (env `AGENT_MAX_STEPS`).
- **38 tools** (Sprint 7): 27 legacy + 8 v2 namespace (`task.*`/`project.*`/`message.send`/`follow_up.update`/`gapo.find_user`) + 1 `report.query` (NL→SQL inner LLM hoặc raw SQL escape) + 4 automation (`automation.create`/`list`/`delete`, `workflow.run`).
- System prompt 2 mode: v1 (default) hoặc v2 3-mode dispatcher (READ/ACTION/AUTOMATION). Switch qua `BB_PM_PROMPT_VERSION=v2`.
- Cron scheduler 2 nguồn: legacy env-based (CRON_DAILY_DIGEST_TARGET) + DB-backed Automation table với 60s poll loop hot-register/unregister.
- Workflows registry (`src/workflows/registry.ts`): `daily_digest`, `weekly_report`, `hygiene_check` — pure functions composable với cron + `workflow.run` tool.
- Cooldown 24h Redis (fallback in-memory) cho `send_follow_up`.
- Mọi tool call ghi vào `/agent/audit` (fire-and-forget). Eval: `pnpm eval` với golden set `test/golden-eval.json` (26 case across 5 category).

### gapo-work plugin (channel adapter)

- Inbound: `POST /api/plugins/gapo-work/webhook` — parse Gapo payload, forward HTTP → bb-pm-tools `/agent/run`, ack 200 ngay, gửi reply về Gapo async.
- Outbound: `POST /api/plugins/gapo-work/send` — yêu cầu header `X-Plugin-Token` (shared secret), body `{conversationId, text}`. Gửi qua Gapo bot API.
- `conversationId` parse prefix (Sprint 7 fix): `dm:<int>` → `receiver_id` field, `collab:<int>` → `collab_id` field, `<int>` → `thread_id` (legacy passthrough). Sai prefix → throw error rõ ràng thay vì send rác cho Gapo.
- **Không chứa PM logic**, không gọi DB, không gọi LLM. Gapo credentials chỉ sống ở đây.

## Quy ước code

### bb-pm API (Fastify + Prisma + Zod)

- Response shape: `{ data, meta: {page, pageSize, total} }` hoặc `{ error: {code, message, details} }`.
- Validation: Zod schema share FE↔BE qua `packages/shared`.
- State transition: `POST /:resource/:id/transition {status}` — server validate allowed.
- Scope check: `companyId` trong `req.user`, super-admin bỏ qua.
- Auth hook: `app.addHook("preHandler", app.authenticate)` ở đầu mỗi routes module.
- Agent endpoint: cùng route file (tasks, projects, agent) — auth plugin xử lý X-Agent-Token transparently.

### OpenClaw plugins (TypeScript)

- Plugin entry: `register(api)` export default. Gọi `api.registerHttpRoute({path, auth, match, handler})` để đăng ký route.
- Handler signature: `(req: IncomingMessage, res: ServerResponse) => Promise<boolean>` (raw Node, không Express).
- Env loader: không dùng dotenv — plugin tự parse `.env` theo thứ tự: env var `<PLUGIN>_ENV` → `~/.openclaw/plugins/<id>/.env` → plugin source dir.
- Build: `node node_modules/typescript/bin/tsc` (tránh `pnpm build` vì `tsc` trong `.bin` có permission issue trên setup này).
- Install với `--link` khi dev (không copy), `--dangerously-force-unsafe-install` nếu dùng env+fetch (OpenClaw scanner false positive).

### Secret segregation

- **gapo-work**: `GAPO_BOT_TOKEN`, `sendToken` (shared với bb-pm-tools)
- **bb-pm-tools**: `BB_PM_AGENT_TOKEN`, `LLM_API_KEY`, `GAPO_SEND_TOKEN` (shared với gapo-work)
- **bb-pm API**: `AGENT_API_TOKEN` (match `BB_PM_AGENT_TOKEN`), `JWT_SECRET`, DB creds
- Không có secret nào lộ sang layer khác. Shared secrets (2 chiều) được generate 1 lần.

## Conventions

- **Markdown:** tiếng Việt cho docs, comment, prompt LLM — team nội bộ.
- **Code identifiers:** tiếng Anh.
- **File paths trong doc:** relative-to-repo-root (vd `bb-pm/apps/api/src/...`), không absolute.
- **LLM system prompt:** nguyên tắc 9 điểm trong `bb-pm-tools/src/orchestrator.ts` — không tự ý follow-up khi user chỉ hỏi, không tự đổi status, luôn trả "0 task" rõ ràng thay vì bịa.
- **Không commit secret:** `.env`, `config.json` có token thật đều trong `.gitignore`. Example files dùng placeholder.

## Common tasks

**Thêm tool mới cho agent:**
1. Implement handler trong `bb-pm-tools/src/tools.ts` (push vào array + update `toolsByName` auto-computed).
2. Nếu cần endpoint mới ở bb-pm API: add vào routes module tương ứng.
3. Thêm API-client method trong `bb-pm-tools/src/api-client.ts`.
4. Update system prompt trong `orchestrator.ts` nếu tool cần hướng dẫn đặc biệt.
5. Build + reload plugin + restart gateway.

**Thêm bảng mới vào bb-pm DB:**
1. Sửa `bb-pm/apps/api/prisma/schema.prisma`.
2. `pnpm --filter @bb-pm/api prisma migrate dev --name <desc>`.
3. `pnpm --filter @bb-pm/api prisma generate` để TypeScript client update.
4. Tạo routes module trong `src/modules/<name>/routes.ts` + register trong `server.ts`.

**Rotate agent token:**
1. `openssl rand -hex 32` → copy value.
2. Update 3 chỗ sync: `bb-pm/.env` (`AGENT_API_TOKEN`), `bb-pm-tools/.env` (`BB_PM_AGENT_TOKEN`), `~/.openclaw/plugins/bb-pm-tools/.env` (`BB_PM_AGENT_TOKEN`).
3. Restart bb-pm API + OpenClaw gateway.

## Status

Xem [PROCESS.md](./PROCESS.md) cho trạng thái sprint chi tiết + smoke test log. **Sprint 1–7 done** (Phase 1.2 NL→SQL partial, Phase 6 cleanup deferred). Production stack: gateway + bb-pm API + Postgres readonly role + DB-backed automation registry với hot register.
