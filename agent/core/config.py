"""
Config: load từ /home/bbsw/pm/.env (thư mục cha của agent/).
Tất cả file khác import: from core.config import cfg
"""
import os
from pathlib import Path
from dotenv import load_dotenv

# .env nằm ở thư mục cha (pm/), agent/ là thư mục con
_ENV_PATH = Path(__file__).resolve().parents[2] / ".env"
load_dotenv(_ENV_PATH)


class Config:
    # ── OpenAI-compatible LLM ─────────────────────────────────────────
    # BASE_URL  = https://apimodel.berp.vn/v1
    # MODEL     = openai/gpt-oss-20b  (từ MODEL_API_BASE trong .env)
    # API_KEY   = dumemay
    LLM_BASE_URL  : str   = os.getenv("BASE_URL", "https://apimodel.berp.vn/v1")
    LLM_API_KEY   : str   = os.getenv("OPENAI_API_KEY", "dumemay")
    LLM_MODEL     : str   = os.getenv("MODEL_API_BASE", "openai/gpt-oss-20b")
    LLM_TEMP      : float = float(os.getenv("TEMPERATURE", "0"))

    # ── PostgreSQL (Odoo DB) ──────────────────────────────────────────
    # DB_NAME = odoo (Odoo tự tạo DB tên "odoo", khác với POSTGRES_DB=project_management)
    DB_HOST     : str = os.getenv("DB_HOST", "localhost")
    DB_PORT     : int = int(os.getenv("DB_PORT", "5432"))
    DB_NAME     : str = os.getenv("DB_NAME", "odoo")
    DB_USER     : str = os.getenv("POSTGRES_USER", "admin")
    DB_PASSWORD : str = os.getenv("POSTGRES_PASSWORD", "admin123")

    # ── Redis ─────────────────────────────────────────────────────────
    REDIS_HOST     : str = os.getenv("REDIS_HOST", "localhost")
    REDIS_PORT     : int = int(os.getenv("REDIS_PORT", "6379"))
    REDIS_PASSWORD : str = os.getenv("REDIS_PASSWORD", "redis123@")

    # ── Agent ─────────────────────────────────────────────────────────
    MAX_ITER : int  = int(os.getenv("AGENT_MAX_ITER", "6"))
    DEBUG    : bool = os.getenv("AGENT_DEBUG", "false").lower() == "true"

    # ── Embedding (local, không cần API) ─────────────────────────────
    # sentence-transformers chạy local, free, dim=384
    EMBED_MODEL : str = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
    EMBED_DIM   : int = 384   # dimension của model trên


cfg = Config()


# ── Quick sanity check khi import ────────────────────────────────────────────
if cfg.DEBUG:
    print(f"[Config] .env loaded from: {_ENV_PATH}")
    print(f"[Config] LLM: {cfg.LLM_MODEL} @ {cfg.LLM_BASE_URL}")
    print(f"[Config] DB:  {cfg.DB_USER}@{cfg.DB_HOST}:{cfg.DB_PORT}/{cfg.DB_NAME}")
    print(f"[Config] Redis: {cfg.REDIS_HOST}:{cfg.REDIS_PORT}")
