# @openclaw/bb-pm-tools — Sprint 1 + 2

OpenClaw plugin: PM agent over Gapo Work, self-hosted LLM, bb-pm API backend.

**Sprint 1** — reactive observer:
- 1 tool: `list_overdue_tasks`
- LLM orchestrator (OpenAI-compatible, Gemma 4)
- Gapo inbound webhook + outbound sender

**Sprint 2** — proactive observer (Level 1 capability):
- 3 more tools: `list_stale_tasks`, `check_data_hygiene`, `generate_daily_digest`
- Cron scheduler (Flow 1: daily digest @ 08:00, Flow 7: weekly hygiene Mon 09:00)
- Every tool call is audited to `agent_audit_log` via `POST /api/v1/agent/audit`

## Architecture (post Phase 1 refactor)

Channel plugins are now separate. This plugin is the **orchestrator only** —
it exposes a channel-agnostic HTTP endpoint `/api/plugins/bb-pm/agent/run`
that any channel adapter can POST into.

```
Gapo Work ──webhook──▶ gapo-work plugin ──HTTP /agent/run──▶ bb-pm-tools
   ▲                                                              │
   │                                                              │ tool call
   │                                                              ▼
   └──────────── reply ◀── gapo-work ◀──── { reply } ─────── bb-pm API ──▶ Postgres
                                                                  ▲
                                            LLM (self-hosted Gemma 4) ─┘
```

Outbound for the cron scheduler still goes directly from this plugin to the
Gapo API (Phase 2 will move that into gapo-work too).

## ⚠️ Gemma + tool-calling

Gemma does NOT speak OpenAI function-calling natively. You must serve it through
a stack that parses Gemma's tool-call format into the OpenAI `tool_calls` shape:

- **vLLM**: `--enable-auto-tool-choice --tool-call-parser <parser>` (pick the
  parser that matches your Gemma variant — check vLLM docs)
- **llama.cpp server**: use a build with `--chat-template gemma` and a tool
  adapter (e.g. llama-cpp-agent)
- **Ollama**: tool-calling support varies per model file; verify with
  `curl $LLM_BASE_URL/chat/completions` returning `tool_calls`

Quick verification:
```bash
curl $LLM_BASE_URL/chat/completions -H "Content-Type: application/json" -d '{
  "model": "gemma-4",
  "messages": [{"role":"user","content":"list overdue tasks"}],
  "tools": [{"type":"function","function":{"name":"list_overdue_tasks","description":"x","parameters":{"type":"object","properties":{}}}}],
  "tool_choice": "auto"
}'
```

If the response contains `"tool_calls": [...]` → you're good.
If not → your serving stack doesn't forward tool-calls. Fix the serving config
before expecting the plugin to work.

## Prerequisites — bb-pm API side

1. Pull the bb-pm API changes from this sprint:
   - `src/plugins/auth.ts` — accepts `X-Agent-Token` header
   - `src/modules/tasks/routes.ts` — new `GET /tasks/overdue`
   - `prisma/seed.ts` — creates `pm-agent@bluebolt.local` MANAGER user

2. Set env on the API service:
   ```
   AGENT_API_TOKEN=<same hex string as plugin>
   AGENT_USER_EMAIL=pm-agent@bluebolt.local   # optional override
   ```

3. Re-run seed so the agent user exists:
   ```
   pnpm --filter @bb-pm/api prisma db seed
   ```

## Setup

```bash
cd bb-pm/openclaw/bb-pm-tools
cp .env.example .env
# fill in BB_PM_AGENT_TOKEN, GAPO_BOT_TOKEN, LLM_BASE_URL
pnpm install
pnpm build
```

## Quick smoke test (no OpenClaw host, no Gapo)

```bash
pnpm cli "task nào đang quá hạn?"        # Sprint 1 flow
pnpm cli --digest                         # Sprint 2: daily digest
pnpm cli --hygiene                        # Sprint 2: weekly hygiene
pnpm cli --stale                          # Sprint 2: stale tasks
```

Expected: CLI prints a Vietnamese answer, e.g.
> Có 3 task quá hạn: ...

If you see `Missing env: BB_PM_AGENT_TOKEN` — set it in `.env`.

## Running inside OpenClaw host

The plugin registers a Fastify-style POST handler at
`/api/plugins/bb-pm/agent/run` via the OpenClaw plugin host's `api.http.post`.
Channel adapters (e.g. `gapo-work`) forward inbound messages to this path.

Request body:
```json
{ "text": "task nào quá hạn?", "source": "chat", "correlationId": "gapo-abc-...." }
```
Response:
```json
{ "reply": "Có 3 task quá hạn: ..." }
```

To hook Gapo, install and enable the `gapo-work` plugin and point its
`orchestrator.url` at `http://<openclaw-host>/api/plugins/bb-pm/agent/run`.

## Testing the full loop

1. In Gapo, send the bot: `[GAPO_USER: dat.le] task nào quá hạn?`
2. Plugin → LLM chooses `list_overdue_tasks` → calls bb-pm API.
3. Bot replies in Vietnamese with the overdue list.

## Enabling cron (Sprint 2)

The scheduler starts only for jobs where both `SCHEDULE` and `TARGET` are set.
`TARGET` is the Gapo conversation id the bot posts into (typically the PM room).

```
CRON_DAILY_DIGEST=0 8 * * *
CRON_DAILY_DIGEST_TARGET=<gapo-conv-id-for-pm-room>

CRON_WEEKLY_HYGIENE=0 9 * * MON
CRON_WEEKLY_HYGIENE_TARGET=<gapo-conv-id-for-pm-room>
```

To trigger manually without waiting: `pnpm cli --digest`.

## Audit log

Every tool call writes one row to `agent_audit_log` via `POST /api/v1/agent/audit`
with:
- `tool`, `argsJson`, summarized `resultJson` (counts only, not full lists)
- `durationMs`, `errorMessage` (if failed)
- `source` (`chat` | `cron` | `cli`)
- `correlationId` (for cron: `<jobName>-<timestamp>`)

Inspect recent entries:
```
curl -H "X-Agent-Token: $TOKEN" "http://localhost:4000/api/v1/agent/audit?limit=20"
```

## File map

- `src/config.ts` — env parsing (bb-pm, LLM, Gapo, cron)
- `src/api-client.ts` — typed bb-pm HTTP client
- `src/tools.ts` — tool catalog (4 tools: overdue, stale, hygiene, digest)
- `src/llm.ts` — OpenAI-compatible chat client
- `src/orchestrator.ts` — ReAct loop + audit wrapper
- `src/scheduler.ts` — node-cron jobs
- `src/gapo-channel.ts` — parse/send Gapo messages
- `src/webhook.ts` — HTTP handler
- `src/index.ts` — plugin entry (`register(api)`)
- `src/cli.ts` — standalone tester (supports `--digest`, `--hygiene`, `--stale`, `--overdue`)
