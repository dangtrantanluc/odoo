from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv
from pydantic import BaseModel, Field


ENV_PATH = Path(__file__).resolve().parent / ".env"
for env_path in (Path("/.env"), ENV_PATH):
    load_dotenv(env_path, override=False)


class Settings(BaseModel):
    # Chat / Gapo
    bot_token: str = Field(default="")
    webhook_url: str = Field(default="")
    gapo_api_url: str = Field(default="https://api.gapowork.vn/3rd-bot/v1.0/3rd/messages")
    gapo_bot_id: str = Field(default="")
    gapo_auth_header: str = Field(default="Authorization")
    gapo_auth_prefix: str = Field(default="Bearer")

    # Existing bb-pm API. Python agent should call this API, not write DB directly.
    bb_pm_api_url: str = Field(default="http://localhost:4000/api/v1")
    bb_pm_agent_token: str = Field(default="")

    # OpenAI-compatible LLM endpoint.
    llm_base_url: str = Field(default="http://localhost:8000/v1")
    llm_api_key: str = Field(default="nokey")
    llm_model: str = Field(default="Qwen/Qwen3.6-27B-FP8")

    # Reminder times. Keep these in env so lead/ops can change without code edits.
    cron_tz: str = Field(default="Asia/Ho_Chi_Minh")
    noon_checkin_cron: str = Field(default="50 11 * * 1-5")
    eod_checkin_cron: str = Field(default="50 17 * * 1-5")

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            bot_token=os.getenv("BOT_TOKEN", os.getenv("GAPO_BOT_TOKEN", "")),
            webhook_url=os.getenv("WEBHOOK_URL", ""),
            gapo_api_url=os.getenv(
                "GAPO_API_URL",
                "https://api.gapowork.vn/3rd-bot/v1.0/3rd/messages",
            ),
            gapo_bot_id=os.getenv("GAPO_BOT_ID", ""),
            gapo_auth_header=os.getenv("GAPO_AUTH_HEADER", "Authorization"),
            gapo_auth_prefix=os.getenv("GAPO_AUTH_PREFIX", "Bearer"),
            bb_pm_api_url=os.getenv("BB_PM_API_URL", "http://localhost:4000/api/v1").rstrip("/"),
            bb_pm_agent_token=os.getenv(
                "BB_PM_AGENT_TOKEN",
                os.getenv("AGENT_API_TOKEN", ""),
            ),
            llm_base_url=os.getenv("LLM_BASE_URL", "http://100.94.242.21/v1").rstrip("/"),
            llm_api_key=os.getenv("LLM_API_KEY", "nokey"),
            llm_model=os.getenv("LLM_MODEL", "Qwen/Qwen3.6-27B-FP8"),
            cron_tz=os.getenv("CRON_TZ", "Asia/Ho_Chi_Minh"),
            noon_checkin_cron=os.getenv("NOON_CHECKIN_CRON", "50 11 * * 1-5"),
            eod_checkin_cron=os.getenv("EOD_CHECKIN_CRON", "50 17 * * 1-5"),
        )


settings = Settings.from_env()
