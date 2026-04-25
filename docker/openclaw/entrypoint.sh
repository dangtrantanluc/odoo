#!/bin/sh
# OpenClaw container entrypoint.
#
# 1. On first start (empty volume) write a sane default openclaw.json so the
#    CLI doesn't block on wizard prompts. Skipped if user already mounted one.
# 2. Link the bundled plugins (bb-pm-tools, gapo-work) into the extensions
#    directory — idempotent, safe on every boot.
# 3. exec the requested command (default: gateway run).
set -eu

OPENCLAW_HOME="${OPENCLAW_HOME:-/root/.openclaw}"
CONFIG_FILE="${OPENCLAW_HOME}/openclaw.json"
EXT_DIR="${OPENCLAW_HOME}/extensions"

mkdir -p "${EXT_DIR}" "${OPENCLAW_HOME}/plugins"

# ── 1. seed openclaw.json if missing ────────────────────────────────────────
if [ ! -f "${CONFIG_FILE}" ]; then
  cat > "${CONFIG_FILE}" <<JSON
{
  "gateway": {
    "port": 18789,
    "mode": "local",
    "bind": "0.0.0.0",
    "auth": {
      "mode": "token",
      "token": "${OPENCLAW_GATEWAY_TOKEN:-change-me-$(date +%s)}"
    }
  },
  "models": {
    "mode": "merge",
    "providers": {
      "berp-openai": {
        "baseUrl": "${LLM_BASE_URL:-http://host.docker.internal:8000/v1}",
        "apiKey": "${LLM_API_KEY:-nokey}",
        "api": "openai-completions",
        "models": [
          {
            "id": "${LLM_MODEL:-Qwen/Qwen3.6-27B-FP8}",
            "name": "${LLM_MODEL:-Qwen/Qwen3.6-27B-FP8}",
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
      "bb-pm-tools": {"enabled": true},
      "gapo-work":   {"enabled": true}
    }
  }
}
JSON
  echo "[entrypoint] wrote default openclaw.json"
fi

# ── 2. idempotent plugin link ───────────────────────────────────────────────
link_plugin() {
  # $1 = plugin id, $2 = source path
  plugin_id="$1"; source="$2"
  if [ -L "${EXT_DIR}/${plugin_id}" ] && [ "$(readlink "${EXT_DIR}/${plugin_id}")" = "${source}" ]; then
    return 0
  fi
  rm -rf "${EXT_DIR}/${plugin_id}"
  ln -s "${source}" "${EXT_DIR}/${plugin_id}"
  echo "[entrypoint] linked ${plugin_id} -> ${source}"
}

link_plugin bb-pm-tools /opt/plugins/bb-pm-tools
link_plugin gapo-work   /opt/plugins/gapo-work

# ── 3. plugin-specific env wiring ───────────────────────────────────────────
# bb-pm-tools reads .env from ~/.openclaw/plugins/bb-pm-tools/.env (see
# src/env.ts). Seed from container env on first boot; never overwrite.
BB_PM_TOOLS_ENV="${OPENCLAW_HOME}/plugins/bb-pm-tools/.env"
if [ ! -f "${BB_PM_TOOLS_ENV}" ]; then
  mkdir -p "$(dirname "${BB_PM_TOOLS_ENV}")"
  cat > "${BB_PM_TOOLS_ENV}" <<ENV
BB_PM_API_URL=${BB_PM_API_URL:-http://bb_pm_api:4000/api/v1}
BB_PM_AGENT_TOKEN=${BB_PM_AGENT_TOKEN:-}

LLM_BASE_URL=${LLM_BASE_URL:-http://host.docker.internal:8000/v1}
LLM_API_KEY=${LLM_API_KEY:-nokey}
LLM_MODEL=${LLM_MODEL:-Qwen/Qwen3.6-27B-FP8}
LLM_MAX_TOKENS=${LLM_MAX_TOKENS:-2048}
LLM_TEMPERATURE=${LLM_TEMPERATURE:-0.2}

AGENT_MAX_STEPS=${AGENT_MAX_STEPS:-5}

GAPO_SEND_URL=http://localhost:18789/api/plugins/gapo-work/send
GAPO_SEND_TOKEN=${GAPO_SEND_TOKEN:-}

REDIS_URL=${REDIS_URL:-}
FOLLOW_UP_COOLDOWN_SEC=${FOLLOW_UP_COOLDOWN_SEC:-86400}

CRON_TZ=${CRON_TZ:-Asia/Ho_Chi_Minh}
CRON_DAILY_DIGEST=${CRON_DAILY_DIGEST:-0 8 * * *}
CRON_DAILY_DIGEST_TARGET=${CRON_DAILY_DIGEST_TARGET:-}
CRON_WEEKLY_HYGIENE=${CRON_WEEKLY_HYGIENE:-0 9 * * MON}
CRON_WEEKLY_HYGIENE_TARGET=${CRON_WEEKLY_HYGIENE_TARGET:-}
ENV
  echo "[entrypoint] seeded bb-pm-tools/.env"
fi

# gapo-work config.json (stores bot token + sendToken + orchestrator url).
GAPO_CFG="${OPENCLAW_HOME}/plugins/gapo-work/config.json"
if [ ! -f "${GAPO_CFG}" ]; then
  mkdir -p "$(dirname "${GAPO_CFG}")"
  cat > "${GAPO_CFG}" <<JSON
{
  "gapo": {
    "apiUrl": "${GAPO_API_URL:-https://api.gapowork.vn/3rd-bot/v1.0/3rd/messages}",
    "botToken": "${GAPO_BOT_TOKEN:-}"
  },
  "orchestrator": {
    "url": "http://localhost:18789/api/plugins/bb-pm/agent/run",
    "timeoutMs": ${ORCHESTRATOR_TIMEOUT_MS:-30000}
  },
  "sendToken": "${GAPO_SEND_TOKEN:-}"
}
JSON
  echo "[entrypoint] seeded gapo-work/config.json"
fi

exec "$@"
