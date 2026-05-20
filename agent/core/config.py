"""Central configuration for the standalone PM Agent service.

Replaces the per-plugin env loading of the OpenClaw plugins (bb-pm-tools,
gapo-agent). Every value is read from the process environment; an optional
.env file is loaded first. Mirrors bb-pm-tools/src/shared/config.ts.
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv
from pydantic import BaseModel, Field

# Load .env from a few candidate locations — env already set wins (override=False).
for _candidate in (
    Path(os.getenv("AGENT_ENV_FILE", "")) if os.getenv("AGENT_ENV_FILE") else None,
    Path(__file__).resolve().parent.parent / ".env",
    Path("/.env"),
):
    if _candidate and _candidate.is_file():
        load_dotenv(_candidate, override=False)


def _env(*names: str, default: str = "") -> str:
    for name in names:
        value = os.getenv(name)
        if value is not None and value != "":
            return value
    return default


def _int(*names: str, default: int) -> int:
    raw = _env(*names)
    try:
        return int(raw) if raw else default
    except ValueError:
        return default


def _float(*names: str, default: float) -> float:
    raw = _env(*names)
    try:
        return float(raw) if raw else default
    except ValueError:
        return default


def _bool(*names: str, default: bool = False) -> bool:
    raw = _env(*names)
    if not raw:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


LLM_PROVIDERS = ("default", "gemini", "openrouter", "9router")


class LlmProviderConfig(BaseModel):
    base_url: str
    api_key: str
    model: str
    max_tokens: int = 2048
    temperature: float = 0.2


class LlmConfig(BaseModel):
    requested_provider: str
    active_provider: str
    providers: dict[str, LlmProviderConfig]

    @property
    def active(self) -> LlmProviderConfig:
        return self.providers[self.active_provider]


class BbPmConfig(BaseModel):
    base_url: str
    agent_token: str


class GapoConfig(BaseModel):
    api_url: str
    bot_token: str
    bot_id: str = ""
    auth_header: str = "x-gapo-api-key"
    auth_prefix: str = ""
    dry_run: bool = False
    # Token guarding the internal /send + /webhook routes (was X-Plugin-Token).
    send_token: str = ""
    webhook_path: str = "/api/plugins/gapo-agent/webhook"
    send_path: str = "/api/plugins/gapo-agent/send"


class RedisConfig(BaseModel):
    url: str = ""
    follow_up_cooldown_sec: int = 24 * 3600


class RateLimitConfig(BaseModel):
    max_per_window: int = 30
    window_sec: int = 60


class ConcurrencyConfig(BaseModel):
    max_concurrent: int = 16
    max_queue: int = 30
    acquire_timeout_ms: int = 60_000


class CronJob(BaseModel):
    schedule: str
    target: str = ""


class CronConfig(BaseModel):
    timezone: str = "Asia/Ho_Chi_Minh"
    daily_digest: CronJob
    weekly_hygiene: CronJob
    noon_checkin: CronJob
    eod_checkin: CronJob
    missing_checkin_followup: CronJob
    checkin_enabled: bool = False
    audit_retention_days: int = 90
    audit_cleanup_schedule: str = "0 3 * * *"
    automation_poll_sec: int = 60
    # Risk scan — quét sau EOD; rỗng = tắt.
    risk_scan: CronJob = Field(default_factory=lambda: CronJob(schedule="30 18 * * 1-5"))
    risk_scan_enabled: bool = False


class Settings(BaseModel):
    bb_pm: BbPmConfig
    llm: LlmConfig
    gapo: GapoConfig
    redis: RedisConfig
    rate_limit: RateLimitConfig
    concurrency: ConcurrencyConfig
    cron: CronConfig
    admin_alert_target: str = ""
    # Conversational state TTLs.
    checkin_session_ttl_sec: int = 2 * 3600
    dedup_ttl_sec: int = 60
    caller_cache_ttl_sec: int = 15 * 60
    action_pending_ttl_sec: int = 10 * 60
    # HTTP server.
    port: int = 8001
    # Logging.
    io_log_enabled: bool = True
    io_log_max_chars: int = 2000
    # Routing: bật kiến trúc LLM-first (Option B). Tắt → rollback path cũ.
    llm_first_routing: bool = True


def _llm_config() -> LlmConfig:
    requested = _env("LLM_PROVIDER", default="default")
    active = requested if requested in LLM_PROVIDERS else "default"
    providers = {
        "default": LlmProviderConfig(
            base_url=_env("LLM_BASE_URL", default="http://localhost:8000/v1").rstrip("/"),
            api_key=_env("LLM_API_KEY", "NINE_ROUTER_API_KEY", "9ROUTER_API_KEY", default="not-needed"),
            model=_env("LLM_MODEL", default="Qwen/Qwen3.6-27B-FP8"),
            max_tokens=_int("LLM_MAX_TOKENS", default=2048),
            temperature=_float("LLM_TEMPERATURE", default=0.2),
        ),
        "gemini": LlmProviderConfig(
            base_url=_env(
                "GEMINI_BASE_URL",
                default="https://generativelanguage.googleapis.com/v1beta/openai",
            ).rstrip("/"),
            api_key=_env("GEMINI_API_KEY"),
            model=_env("GEMINI_MODEL", default="gemini-2.5-flash"),
            max_tokens=_int("GEMINI_MAX_TOKENS", default=2048),
            temperature=_float("GEMINI_TEMPERATURE", default=0.2),
        ),
        "openrouter": LlmProviderConfig(
            base_url=_env("OPENROUTER_BASE_URL", default="https://openrouter.ai/api/v1").rstrip("/"),
            api_key=_env("OPENROUTER_API_KEY"),
            model=_env("OPENROUTER_MODEL", default="openai/gpt-4o"),
            max_tokens=_int("OPENROUTER_MAX_TOKENS", default=2048),
            temperature=_float("OPENROUTER_TEMPERATURE", default=0.2),
        ),
        "9router": LlmProviderConfig(
            base_url=_env(
                "9ROUTER_BASE_URL", "NINE_ROUTER_BASE_URL", default="http://localhost:20128/v1"
            ).rstrip("/"),
            api_key=_env("9ROUTER_API_KEY", "NINE_ROUTER_API_KEY", default="not-needed"),
            model=_env(
                "9ROUTER_MODEL", "NINE_ROUTER_MODEL", default="gemini/gemini-3-flash-preview"
            ),
            max_tokens=_int("9ROUTER_MAX_TOKENS", "NINE_ROUTER_MAX_TOKENS", default=2048),
            temperature=_float("9ROUTER_TEMPERATURE", "NINE_ROUTER_TEMPERATURE", default=0.2),
        ),
    }
    return LlmConfig(requested_provider=requested, active_provider=active, providers=providers)


def load_settings() -> Settings:
    return Settings(
        bb_pm=BbPmConfig(
            base_url=_env("BB_PM_API_URL", default="http://localhost:4000/api/v1").rstrip("/"),
            agent_token=_env("BB_PM_AGENT_TOKEN", "AGENT_API_TOKEN"),
        ),
        llm=_llm_config(),
        gapo=GapoConfig(
            api_url=_env(
                "GAPO_API_URL",
                default="https://api.gapowork.vn/3rd-bot/v1.0/3rd/messages",
            ),
            bot_token=_env("GAPO_BOT_TOKEN", "BOT_TOKEN"),
            bot_id=_env("GAPO_BOT_ID"),
            auth_header=_env("GAPO_AUTH_HEADER", default="x-gapo-api-key"),
            auth_prefix=_env("GAPO_AUTH_PREFIX"),
            dry_run=_bool("GAPO_DRY_RUN"),
            send_token=_env("GAPO_SEND_TOKEN", "GAPO_AGENT_SEND_TOKEN"),
        ),
        redis=RedisConfig(
            url=_env("REDIS_URL"),
            follow_up_cooldown_sec=_int("FOLLOW_UP_COOLDOWN_SEC", default=24 * 3600),
        ),
        rate_limit=RateLimitConfig(
            max_per_window=_int("AGENT_RUN_MAX_PER_WINDOW", default=30),
            window_sec=_int("AGENT_RUN_WINDOW_SEC", default=60),
        ),
        concurrency=ConcurrencyConfig(
            max_concurrent=_int("AGENT_MAX_CONCURRENT", default=16),
            max_queue=_int("AGENT_MAX_QUEUE", default=30),
            acquire_timeout_ms=_int("AGENT_ACQUIRE_TIMEOUT_MS", default=60_000),
        ),
        cron=CronConfig(
            timezone=_env("CRON_TZ", default="Asia/Ho_Chi_Minh"),
            daily_digest=CronJob(
                schedule=_env("CRON_DAILY_DIGEST", default="0 8 * * *"),
                target=_env("CRON_DAILY_DIGEST_TARGET"),
            ),
            weekly_hygiene=CronJob(
                schedule=_env("CRON_WEEKLY_HYGIENE", default="0 9 * * MON"),
                target=_env("CRON_WEEKLY_HYGIENE_TARGET"),
            ),
            noon_checkin=CronJob(schedule=_env("CRON_NOON_CHECKIN", default="50 11 * * 1-5")),
            eod_checkin=CronJob(schedule=_env("CRON_EOD_CHECKIN", default="50 17 * * 1-5")),
            missing_checkin_followup=CronJob(
                schedule=_env("CRON_MISSING_CHECKIN_FOLLOWUP", default="0 18 * * 1-5")
            ),
            checkin_enabled=_bool("CRON_CHECKIN_ENABLED"),
            audit_retention_days=_int("AUDIT_RETENTION_DAYS", default=90),
            audit_cleanup_schedule=_env("AUDIT_CLEANUP_SCHEDULE", default="0 3 * * *"),
            automation_poll_sec=max(1, _int("AUTOMATION_POLL_MS", default=60_000) // 1000),
            risk_scan=CronJob(
                schedule=_env("CRON_RISK_SCAN", default="30 18 * * 1-5"),
                target=_env("CRON_RISK_SCAN_TARGET"),
            ),
            risk_scan_enabled=_bool("CRON_RISK_SCAN_ENABLED"),
        ),
        admin_alert_target=_env("ADMIN_ALERT_TARGET"),
        checkin_session_ttl_sec=_int("CHECKIN_SESSION_TTL_MS", default=2 * 3600 * 1000) // 1000,
        dedup_ttl_sec=max(1, _int("BB_PM_DEDUP_TTL_MS", default=60_000) // 1000),
        caller_cache_ttl_sec=max(1, _int("BB_PM_CALLER_CACHE_TTL_MS", default=15 * 60 * 1000) // 1000),
        action_pending_ttl_sec=max(1, _int("ACTION_PENDING_TTL_MS", default=10 * 60 * 1000) // 1000),
        port=_int("PM_AGENT_PORT", "PORT", default=8001),
        io_log_enabled=not _bool("BB_PM_IO_LOG_DISABLED"),
        io_log_max_chars=_int("BB_PM_IO_LOG_MAX_CHARS", default=2000),
        llm_first_routing=_bool("LLM_FIRST_ROUTING", default=True),
    )


def assert_config(settings: Settings) -> list[str]:
    """Return a list of missing/invalid critical config keys (non-fatal warnings)."""
    missing: list[str] = []
    if settings.llm.requested_provider not in LLM_PROVIDERS:
        missing.append(
            f"LLM_PROVIDER (valid: {'|'.join(LLM_PROVIDERS)}; got: {settings.llm.requested_provider})"
        )
    if not settings.bb_pm.agent_token:
        missing.append("BB_PM_AGENT_TOKEN")
    active = settings.llm.active_provider
    if active in {"gemini", "openrouter"} and not settings.llm.providers[active].api_key:
        missing.append(f"{active.upper()}_API_KEY")
    cron_on = (
        bool(settings.cron.daily_digest.target)
        or bool(settings.cron.weekly_hygiene.target)
        or settings.cron.checkin_enabled
    )
    if cron_on and not settings.gapo.send_token:
        missing.append("GAPO_SEND_TOKEN")
    return missing


settings = load_settings()
