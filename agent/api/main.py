"""
FastAPI — Entry point của BB Project AI Agent.

Endpoints:
  POST /ask        — câu hỏi chính, trả lời theo role
  POST /notify     — trigger notification batch (dùng cho cron)
  GET  /health     — kiểm tra DB + Redis + LLM còn sống
"""
import uuid
import os

from fastapi import FastAPI, HTTPException, Request, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from minio import Minio
from minio.error import S3Error
import io

from core.config import cfg
from core.database import test_connection
from core import intent, react_loop
from core.sql_engine import text_to_sql_and_run

app = FastAPI(
    title="BB Project AI Agent",
    description="Hybrid Text-to-SQL + ReAct agent cho hệ thống quản lý dự án BlueBolt",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Schemas ──────────────────────────────────────────────────────────────────

class AskRequest(BaseModel):
    question:   str = Field(..., description="Câu hỏi bằng tiếng Việt")
    user_id:    int = Field(..., description="ID user trong Odoo (res_users.id)")
    role:       str = Field(..., description="admin | manager | member | viewer")
    session_id: str = Field(
        default=None,
        description="Session ID để duy trì context hội thoại. Bỏ trống để tạo mới.",
    )


class AskResponse(BaseModel):
    answer:     str
    session_id: str
    path:       str = Field(description="sql | react | react_fallback — để debug")


class NotifyRequest(BaseModel):
    days_ahead: int = Field(default=3, description="Cảnh báo deadline trong N ngày tới")


# ─── Endpoints ────────────────────────────────────────────────────────────────

@app.post("/ask", response_model=AskResponse)
async def ask(req: AskRequest):
    """
    Endpoint chính: nhận câu hỏi, trả lời thông minh theo role.

    Ví dụ request:
    ```json
    {
        "question": "Task nào của tôi sắp đến deadline?",
        "user_id": 5,
        "role": "member"
    }
    ```
    """
    # Validate role
    valid_roles = ("admin", "manager", "member", "viewer")
    if req.role not in valid_roles:
        raise HTTPException(
            status_code=400,
            detail=f"role phải là một trong: {', '.join(valid_roles)}",
        )

    session_id = req.session_id or f"ses_{uuid.uuid4().hex[:10]}"

    # ── Phân loại intent ──
    query_type = intent.classify(req.question)

    if cfg.DEBUG:
        print(f"\n[API /ask] user={req.user_id} role={req.role} intent={query_type}")
        print(f"[API /ask] question: {req.question}")

    # ── Simple query → Text-to-SQL trực tiếp ──
    if query_type == "simple_query":
        result = text_to_sql_and_run(
            question=req.question,
            user_id=req.user_id,
            role=req.role,
        )

        if "error" not in result:
            answer = _format_sql_answer(result, req.question)
            return AskResponse(answer=answer, session_id=session_id, path="sql")

        # SQL lỗi → fallback sang ReAct
        if cfg.DEBUG:
            print(f"[API /ask] SQL failed ({result['error']}), falling back to ReAct")
        answer = react_loop.run(req.question, req.user_id, req.role, session_id)
        return AskResponse(answer=answer, session_id=session_id, path="react_fallback")

    # ── Complex → ReAct full loop ──
    answer = react_loop.run(req.question, req.user_id, req.role, session_id)
    return AskResponse(answer=answer, session_id=session_id, path="react")


@app.post("/notify")
async def notify(req: NotifyRequest):
    """
    Trigger batch notification: deadline alerts + budget warnings.
    Thường được gọi bởi cron job hàng ngày lúc 8:00.

    Trả về summary notifications đã gửi.
    """
    from core.tools import _get_deadline_alerts, _get_budget_warnings

    deadline_msg = _get_deadline_alerts(
        days_ahead=req.days_ahead,
        target_user_id=None,
        caller_user_id=0,   # system call
        role="admin",       # admin xem tất cả
    )

    budget_msg = _get_budget_warnings(
        threshold_pct=20,
        caller_user_id=0,
        role="admin",
    )

    # TODO: tích hợp gửi qua Odoo mail.thread hoặc Discuss
    # Hiện tại trả về text để log / hiển thị

    return {
        "status":   "ok",
        "deadline_alerts": deadline_msg,
        "budget_warnings": budget_msg,
    }


@app.get("/health")
async def health():
    """Kiểm tra trạng thái các thành phần."""
    db_ok = test_connection()

    redis_ok = False
    try:
        from memory.manager import _redis
        _redis.ping()
        redis_ok = True
    except Exception:
        pass

    llm_ok = False
    try:
        from openai import OpenAI
        client = OpenAI(api_key=cfg.LLM_API_KEY, base_url=cfg.LLM_BASE_URL)
        client.chat.completions.create(
            model=cfg.LLM_MODEL,
            messages=[{"role": "user", "content": "ping"}],
            max_tokens=3,
        )
        llm_ok = True
    except Exception:
        pass

    overall = "ok" if (db_ok and redis_ok and llm_ok) else "degraded"

    return {
        "status": overall,
        "components": {
            "database": "ok" if db_ok    else "error",
            "redis":    "ok" if redis_ok else "error",
            "llm":      "ok" if llm_ok   else "error",
        },
        "model":    cfg.LLM_MODEL,
        "base_url": cfg.LLM_BASE_URL,
    }


# ─── MinIO helper ─────────────────────────────────────────────────────────────

def _get_minio_client():
    endpoint  = os.environ.get("MINIO_ENDPOINT", "minio:9000")
    access    = os.environ.get("MINIO_ACCESS_KEY", "minio")
    secret    = os.environ.get("MINIO_SECRET_KEY", "minio123@")
    return Minio(endpoint, access_key=access, secret_key=secret, secure=False)

MINIO_BUCKET = os.environ.get("MINIO_BUCKET", "file-storage")
MINIO_PUBLIC = os.environ.get("MINIO_PUBLIC_ENDPOINT", "http://localhost:9000")


@app.post("/upload-avatar")
async def upload_avatar(
    file: UploadFile = File(...),
    user_id: int = Form(...),
):
    """Upload avatar to MinIO, return public URL."""
    allowed = {"image/jpeg", "image/png", "image/webp", "image/gif"}
    if file.content_type not in allowed:
        raise HTTPException(400, "Only JPEG/PNG/WEBP/GIF images are allowed.")

    data = await file.read()
    if len(data) > 5 * 1024 * 1024:
        raise HTTPException(400, "File too large (max 5 MB).")

    ext = file.filename.rsplit(".", 1)[-1].lower() if "." in (file.filename or "") else "jpg"
    object_name = f"avatars/{user_id}_{uuid.uuid4().hex[:8]}.{ext}"

    client = _get_minio_client()

    # Ensure bucket exists
    try:
        if not client.bucket_exists(MINIO_BUCKET):
            client.make_bucket(MINIO_BUCKET)
            # Set public read policy
            import json
            policy = json.dumps({
                "Version": "2012-10-17",
                "Statement": [{
                    "Effect": "Allow",
                    "Principal": {"AWS": ["*"]},
                    "Action": ["s3:GetObject"],
                    "Resource": [f"arn:aws:s3:::{MINIO_BUCKET}/*"],
                }]
            })
            client.set_bucket_policy(MINIO_BUCKET, policy)
    except S3Error as e:
        raise HTTPException(500, f"MinIO bucket error: {e}")

    try:
        client.put_object(
            MINIO_BUCKET,
            object_name,
            io.BytesIO(data),
            length=len(data),
            content_type=file.content_type,
        )
    except S3Error as e:
        raise HTTPException(500, f"MinIO upload error: {e}")

    public_url = f"{MINIO_PUBLIC.rstrip('/')}/{MINIO_BUCKET}/{object_name}"
    return {"url": public_url, "object": object_name}


# ─── Error handlers ───────────────────────────────────────────────────────────

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    if cfg.DEBUG:
        import traceback
        traceback.print_exc()
    return JSONResponse(
        status_code=500,
        content={"detail": f"Internal error: {str(exc)}"},
    )


# ─── Helper ───────────────────────────────────────────────────────────────────

def _format_sql_answer(result: dict, question: str) -> str:
    """Format kết quả SQL thành câu trả lời tự nhiên."""
    rows  = result.get("rows", [])
    count = result.get("count", 0)

    if not rows:
        return "Không tìm thấy dữ liệu phù hợp với yêu cầu."

    lines = [f"Tìm thấy **{count} kết quả**:\n"]
    for i, row in enumerate(rows[:20], 1):
        parts = []
        for k, v in row.items():
            if v is not None and v != "":
                parts.append(f"{k}: {v}")
        lines.append(f"{i}. {' | '.join(parts)}")

    if count > 20:
        lines.append(f"\n_...còn {count - 20} kết quả khác_")

    return "\n".join(lines)
