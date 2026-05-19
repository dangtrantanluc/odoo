"""Compatibility shim. Prefer: uvicorn app.main:app --host 0.0.0.0 --port 8001."""
from app.main import app
