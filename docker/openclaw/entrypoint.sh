#!/bin/sh
# OpenClaw container entrypoint.
#
# 1. On first start (empty volume) write a sane default openclaw.json so the
#    CLI doesn't block on wizard prompts. Skipped if user already mounted one.
# 2. Link the bundled plugins (bb-pm-tools, gapo-agent, browser-tools) into the extensions
#    directory — idempotent, safe on every boot.
# 3. exec the requested command (default: gateway run).
set -eu

OPENCLAW_HOME="${OPENCLAW_HOME:-/root/.openclaw}"
CONFIG_FILE="${OPENCLAW_HOME}/openclaw.json"
EXT_DIR="${OPENCLAW_HOME}/extensions"
export CONFIG_FILE

mkdir -p "${EXT_DIR}" "${OPENCLAW_HOME}/plugins"

# ── 1. seed openclaw.json if missing ────────────────────────────────────────
if [ ! -f "${CONFIG_FILE}" ]; then
  cat > "${CONFIG_FILE}" <<JSON
{
  "gateway": {
    "port": 18789,
    "mode": "local",
    "bind": "lan",
    "auth": {
      "mode": "token",
      "token": "${OPENCLAW_GATEWAY_TOKEN:-change-me-$(date +%s)}"
    }
  },
  "models": {
    "mode": "merge",
    "providers": {
      "9router": {
        "baseUrl": "${NINE_ROUTER_BASE_URL:-${LLM_BASE_URL:-http://host.docker.internal:20128/v1}}",
        "apiKey": "${NINE_ROUTER_API_KEY:-${LLM_API_KEY:-nokey}}",
        "api": "openai-completions",
        "models": [
          {
            "id": "${NINE_ROUTER_MODEL:-${LLM_MODEL:-gemini/gemini-3-flash-preview}}",
            "name": "${NINE_ROUTER_MODEL:-${LLM_MODEL:-gemini/gemini-3-flash-preview}}",
            "api": "openai-completions",
            "reasoning": false,
            "input": ["text"],
            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
            "contextWindow": 32768,
            "maxTokens": 4096,
            "compat": {"supportsTools": true}
          }
        ]
      }
    }
  },
  "plugins": {
    "entries": {
      "gapo-agent":  {"enabled": true},
      "bb-pm-tools": {"enabled": true},
      "browser-tools": {"enabled": true}
    }
  }
}
JSON
  echo "[entrypoint] wrote default openclaw.json"
fi

# ── 2. idempotent plugin wiring ─────────────────────────────────────────────
# Older volumes may contain a legacy `gapo-work` extension and plugin config.
# Configure bundled plugins directly so startup converges even when that old
# state is still present.
rm -f "${EXT_DIR}/gapo-work" "${EXT_DIR}/gapo-agent" "${EXT_DIR}/bb-pm-tools" "${EXT_DIR}/browser-tools"

node <<'NODE'
const fs = require("fs");
const path = process.env.CONFIG_FILE;
const json = JSON.parse(fs.readFileSync(path, "utf8"));
json.plugins ??= {};
json.plugins.entries ??= {};
json.plugins.entries["gapo-agent"] = { ...(json.plugins.entries["gapo-agent"] || {}), enabled: true };
json.plugins.entries["bb-pm-tools"] = { ...(json.plugins.entries["bb-pm-tools"] || {}), enabled: true };
json.plugins.entries["browser-tools"] = { ...(json.plugins.entries["browser-tools"] || {}), enabled: true };
delete json.plugins.entries["gapo-work"];
json.plugins.load ??= {};
json.plugins.load.paths = [...new Set([
  ...(Array.isArray(json.plugins.load.paths) ? json.plugins.load.paths : []),
  "/opt/plugins/gapo-agent",
  "/opt/plugins/bb-pm-tools",
  "/opt/plugins/browser-tools",
])].filter((p) => p !== "/opt/plugins/gapo-work");
if (json.plugins.installs) delete json.plugins.installs["gapo-work"];
fs.writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
NODE
echo "[entrypoint] wired gapo-agent + bb-pm-tools + browser-tools"

# ── 3. plugin-specific env wiring ───────────────────────────────────────────
# bb-pm-tools reads .env from ~/.openclaw/plugins/bb-pm-tools/.env (see
# src/env.ts). Seed from container env on first boot; never overwrite.
BB_PM_TOOLS_ENV="${OPENCLAW_HOME}/plugins/bb-pm-tools/.env"
if [ ! -f "${BB_PM_TOOLS_ENV}" ]; then
  mkdir -p "$(dirname "${BB_PM_TOOLS_ENV}")"
  cat > "${BB_PM_TOOLS_ENV}" <<ENV
BB_PM_API_URL=${BB_PM_API_URL:-http://bb_pm_api:4000/api/v1}
BB_PM_AGENT_TOKEN=${BB_PM_AGENT_TOKEN:-}

LLM_PROVIDER=${LLM_PROVIDER:-default}
GEMINI_BASE_URL=${GEMINI_BASE_URL:-https://generativelanguage.googleapis.com/v1beta/openai}
GEMINI_API_KEY=${GEMINI_API_KEY:-}
GEMINI_MODEL=${GEMINI_MODEL:-gemini-2.5-flash}
GEMINI_MAX_TOKENS=${GEMINI_MAX_TOKENS:-2048}
GEMINI_TEMPERATURE=${GEMINI_TEMPERATURE:-0.2}

9ROUTER_BASE_URL=${NINE_ROUTER_BASE_URL:-http://host.docker.internal:20128/v1}
9ROUTER_API_KEY=${NINE_ROUTER_API_KEY:-${LLM_API_KEY:-nokey}}
9ROUTER_MODEL=${NINE_ROUTER_MODEL:-${LLM_MODEL:-gemini/gemini-3-flash-preview}}
9ROUTER_MAX_TOKENS=${NINE_ROUTER_MAX_TOKENS:-2048}
9ROUTER_TEMPERATURE=${NINE_ROUTER_TEMPERATURE:-0.2}

LLM_BASE_URL=${LLM_BASE_URL:-http://host.docker.internal:20128/v1}
LLM_API_KEY=${LLM_API_KEY:-${NINE_ROUTER_API_KEY:-nokey}}
LLM_MODEL=${LLM_MODEL:-${NINE_ROUTER_MODEL:-Qwen/Qwen3.6-27B-FP8}}
LLM_MAX_TOKENS=${LLM_MAX_TOKENS:-2048}
LLM_TEMPERATURE=${LLM_TEMPERATURE:-0.2}

AGENT_MAX_STEPS=${AGENT_MAX_STEPS:-5}

GAPO_SEND_URL=http://localhost:18789/api/plugins/gapo-agent/send
GAPO_SEND_TOKEN=${GAPO_SEND_TOKEN:-}
BROWSER_TOOLS_SEND_URL=http://localhost:18789/api/plugins/browser-tools/send-dm
BROWSER_TOOLS_FIND_URL=http://localhost:18789/api/plugins/browser-tools/find-user
BROWSER_TOOLS_FIND_AND_OPEN_DM_URL=http://localhost:18789/api/plugins/browser-tools/find-and-open-dm
BROWSER_TOOLS_TOKEN=${BROWSER_TOOLS_TOKEN:-${GAPO_SEND_TOKEN:-}}

REDIS_URL=${REDIS_URL:-}
FOLLOW_UP_COOLDOWN_SEC=${FOLLOW_UP_COOLDOWN_SEC:-86400}

CRON_TZ=${CRON_TZ:-Asia/Ho_Chi_Minh}
CRON_DAILY_DIGEST=${CRON_DAILY_DIGEST:-0 8 * * *}
CRON_DAILY_DIGEST_TARGET=${CRON_DAILY_DIGEST_TARGET:-}
CRON_WEEKLY_HYGIENE=${CRON_WEEKLY_HYGIENE:-0 9 * * MON}
CRON_WEEKLY_HYGIENE_TARGET=${CRON_WEEKLY_HYGIENE_TARGET:-}
CRON_CHECKIN_ENABLED=${CRON_CHECKIN_ENABLED:-false}
CRON_NOON_CHECKIN=${CRON_NOON_CHECKIN:-50 11 * * 1-5}
CRON_EOD_CHECKIN=${CRON_EOD_CHECKIN:-50 17 * * 1-5}
CRON_MISSING_CHECKIN_FOLLOWUP=${CRON_MISSING_CHECKIN_FOLLOWUP:-0 18 * * 1-5}
ENV
  echo "[entrypoint] seeded bb-pm-tools/.env"
fi

# browser-tools reads .env from ~/.openclaw/plugins/browser-tools/.env.
BROWSER_TOOLS_ENV="${OPENCLAW_HOME}/plugins/browser-tools/.env"
if [ ! -f "${BROWSER_TOOLS_ENV}" ]; then
  mkdir -p "$(dirname "${BROWSER_TOOLS_ENV}")"
  cat > "${BROWSER_TOOLS_ENV}" <<ENV
GAPO_WORK_URL=${GAPO_WORK_URL:-https://www.gapowork.vn}
BROWSER_TOOLS_TOKEN=${BROWSER_TOOLS_TOKEN:-${GAPO_SEND_TOKEN:-}}
BROWSER_HEADLESS=${BROWSER_HEADLESS:-1}
BROWSER_STORAGE_STATE=${BROWSER_STORAGE_STATE:-${OPENCLAW_HOME}/plugins/browser-tools/storage-state.json}
BROWSER_MAX_DMS_PER_HOUR=${BROWSER_MAX_DMS_PER_HOUR:-30}
AGENT_RUN_URL=${AGENT_RUN_URL:-http://localhost:18789/api/plugins/bb-pm/agent/run}
ENV
  echo "[entrypoint] seeded browser-tools/.env"
fi

# gapo-agent reads .env from ~/.openclaw/plugins/gapo-agent/.env.
GAPO_AGENT_ENV="${OPENCLAW_HOME}/plugins/gapo-agent/.env"
if [ ! -f "${GAPO_AGENT_ENV}" ]; then
  mkdir -p "$(dirname "${GAPO_AGENT_ENV}")"
  cat > "${GAPO_AGENT_ENV}" <<ENV
GAPO_API_URL=${GAPO_API_URL:-https://api.gapowork.vn/3rd-bot/v1.0/3rd/messages}
GAPO_BOT_TOKEN=${GAPO_BOT_TOKEN:-}
GAPO_BOT_ID=${GAPO_BOT_ID:-}
GAPO_AUTH_HEADER=${GAPO_AUTH_HEADER:-x-gapo-api-key}
GAPO_AUTH_PREFIX=${GAPO_AUTH_PREFIX:-}
GAPO_DRY_RUN=${GAPO_DRY_RUN:-false}
GAPO_SEND_TOKEN=${GAPO_SEND_TOKEN:-}
AGENT_WEBHOOK_URL=${AGENT_WEBHOOK_URL:-http://localhost:18789/api/plugins/bb-pm/agent/run}
AGENT_WEBHOOK_TIMEOUT_MS=${AGENT_WEBHOOK_TIMEOUT_MS:-30000}
ENV
  echo "[entrypoint] seeded gapo-agent/.env"
fi

exec "$@"
