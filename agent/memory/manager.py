"""
Memory Manager: CRUD cho 3 loại memory + embedding local.

Embedding dùng sentence-transformers chạy local (không cần API, free):
  Model: paraphrase-multilingual-MiniLM-L12-v2
  Dim:   384  (khớp với vector(384) trong schema.sql)
  Ngôn ngữ: hỗ trợ tiếng Việt tốt

Working memory (session context) lưu trong Redis, TTL 30 phút.
"""
import hashlib
import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from functools import lru_cache
from typing import Any, Literal, Optional

import redis as redis_lib
from openai import OpenAI

from core.config import cfg
from core.database import db_cursor

# ── Khởi tạo Redis ────────────────────────────────────────────────────────────
_redis = redis_lib.Redis(
    host=cfg.REDIS_HOST,
    port=cfg.REDIS_PORT,
    password=cfg.REDIS_PASSWORD,
    decode_responses=True,
)

# ── Khởi tạo LLM client (dùng cho extract_and_store) ─────────────────────────
_llm = OpenAI(
    api_key=cfg.LLM_API_KEY,
    base_url=cfg.LLM_BASE_URL,
)

# ── Embedding model (lazy load — chỉ import khi cần) ─────────────────────────
_embed_model = None

def _get_embed_model():
    """Lazy-load sentence-transformers để không chậm startup."""
    global _embed_model
    if _embed_model is None:
        from sentence_transformers import SentenceTransformer
        _embed_model = SentenceTransformer(cfg.EMBED_MODEL)
        if cfg.DEBUG:
            print(f"[Memory] Embedding model loaded: {cfg.EMBED_MODEL}")
    return _embed_model


# ── Types ─────────────────────────────────────────────────────────────────────
MemoryType = Literal[
    "qa", "estimate", "preference", "error",   # episodic (per-user)
    "velocity", "cost_pattern",                 # semantic (org-wide)
    "sql_template", "tool_sequence",            # procedural
]


@dataclass
class MemoryItem:
    content:    str
    memory_type: MemoryType
    metadata:   dict          = field(default_factory=dict)
    user_id:    Optional[int] = None
    session_id: Optional[str] = None
    ttl_hours:  Optional[int] = None


# ─── Embedding ────────────────────────────────────────────────────────────────

def embed(text: str) -> list[float]:
    """
    Tạo vector embedding cho text.
    Cache trong Redis 1 giờ để tránh re-compute.
    """
    cache_key = f"emb:{hashlib.md5(text.encode()).hexdigest()}"
    cached = _redis.get(cache_key)
    if cached:
        return json.loads(cached)

    model = _get_embed_model()
    vec   = model.encode(text, normalize_embeddings=True).tolist()
    _redis.setex(cache_key, 3600, json.dumps(vec))
    return vec


# ─── Store ────────────────────────────────────────────────────────────────────

def store(item: MemoryItem) -> Optional[int]:
    """
    Lưu memory item vào đúng bảng.
    Trả về ID bản ghi được tạo/cập nhật.
    """
    vec = embed(item.content)
    meta_json  = json.dumps(item.metadata, ensure_ascii=False)
    expires_at = None
    if item.ttl_hours:
        expires_at = datetime.now() + timedelta(hours=item.ttl_hours)

    try:
        # ── Episodic (per-user) ──
        if item.memory_type in ("qa", "estimate", "preference", "error"):
            with db_cursor() as cur:
                cur.execute("""
                    INSERT INTO bb_agent_episodic
                        (user_id, session_id, memory_type, content, metadata,
                         embedding, expires_at)
                    VALUES (%s, %s, %s, %s, %s, %s::vector, %s)
                    RETURNING id
                """, (item.user_id, item.session_id, item.memory_type,
                      item.content, meta_json, vec, expires_at))
                return cur.fetchone()["id"]

        # ── Semantic (org-wide, upsert theo category+subject) ──
        elif item.memory_type in ("velocity", "cost_pattern"):
            subject = item.metadata.get("subject", item.content[:60])
            with db_cursor() as cur:
                cur.execute("""
                    INSERT INTO bb_agent_semantic
                        (category, subject, content, embedding, source)
                    VALUES (%s, %s, %s, %s::vector, %s)
                    ON CONFLICT (category, subject) DO UPDATE SET
                        content    = EXCLUDED.content,
                        embedding  = EXCLUDED.embedding,
                        updated_at = NOW()
                    RETURNING id
                """, (item.memory_type, subject, item.content,
                      vec, item.metadata.get("source", "auto_extracted")))
                return cur.fetchone()["id"]

        # ── Procedural (upsert theo type+intent, increment success_count) ──
        elif item.memory_type in ("sql_template", "tool_sequence"):
            intent = item.metadata.get("intent", item.content[:80])
            with db_cursor() as cur:
                cur.execute("""
                    INSERT INTO bb_agent_procedural
                        (pattern_type, intent, template, embedding)
                    VALUES (%s, %s, %s, %s::vector)
                    ON CONFLICT (pattern_type, intent) DO UPDATE SET
                        success_count = bb_agent_procedural.success_count + 1,
                        last_used     = NOW()
                    RETURNING id
                """, (item.memory_type, intent, item.content, vec))
                return cur.fetchone()["id"]

    except Exception as e:
        if cfg.DEBUG:
            print(f"[Memory] store() error: {e}")
        return None


# ─── Retrieve ─────────────────────────────────────────────────────────────────

def retrieve(
    query: str,
    user_id: int = None,
    memory_types: list = None,
    k: int = 5,
    min_score: float = 0.60,
) -> list[dict]:
    """
    Vector similarity search trên cả 3 bảng.
    Trả về top-k memories liên quan nhất (score >= min_score).
    """
    vec   = embed(query)
    types = memory_types or ["qa", "estimate", "velocity", "cost_pattern", "sql_template"]
    results = []

    # ── Search episodic ──
    ep_types = [t for t in types if t in ("qa", "estimate", "preference", "error")]
    if ep_types and user_id:
        try:
            with db_cursor() as cur:
                cur.execute("""
                    SELECT id, memory_type, content, metadata,
                           1 - (embedding <=> %s::vector) AS score
                    FROM bb_agent_episodic
                    WHERE user_id = %s
                      AND memory_type = ANY(%s)
                      AND (expires_at IS NULL OR expires_at > NOW())
                    ORDER BY embedding <=> %s::vector
                    LIMIT %s
                """, (vec, user_id, ep_types, vec, k))
                for row in cur.fetchall():
                    if float(row["score"]) >= min_score:
                        results.append({**dict(row), "source": "episodic"})
        except Exception as e:
            if cfg.DEBUG:
                print(f"[Memory] episodic search error: {e}")

    # ── Search semantic ──
    sem_types = [t for t in types if t in ("velocity", "cost_pattern")]
    if sem_types:
        try:
            with db_cursor() as cur:
                cur.execute("""
                    SELECT id, category AS memory_type, content,
                           CASE WHEN embedding IS NULL THEN 0
                                ELSE 1 - (embedding <=> %s::vector)
                           END AS score
                    FROM bb_agent_semantic
                    WHERE category = ANY(%s)
                    ORDER BY
                        CASE WHEN embedding IS NULL THEN 1 ELSE 0 END,
                        embedding <=> %s::vector
                    LIMIT %s
                """, (vec, sem_types, vec, k))
                for row in cur.fetchall():
                    score = float(row["score"]) if row["score"] is not None else 0.0
                    if score >= min_score or row["score"] is None:
                        results.append({**dict(row), "source": "semantic", "score": score})
        except Exception as e:
            if cfg.DEBUG:
                print(f"[Memory] semantic search error: {e}")

    # ── Search procedural ──
    proc_types = [t for t in types if t in ("sql_template", "tool_sequence")]
    if proc_types:
        try:
            with db_cursor() as cur:
                cur.execute("""
                    SELECT id, pattern_type AS memory_type, intent,
                           template AS content,
                           1 - (embedding <=> %s::vector) AS score
                    FROM bb_agent_procedural
                    WHERE pattern_type = ANY(%s)
                    ORDER BY embedding <=> %s::vector
                    LIMIT %s
                """, (vec, proc_types, vec, k))
                for row in cur.fetchall():
                    if float(row["score"]) >= min_score:
                        results.append({**dict(row), "source": "procedural"})
        except Exception as e:
            if cfg.DEBUG:
                print(f"[Memory] procedural search error: {e}")

    # Sắp xếp tất cả kết quả theo score giảm dần
    return sorted(results, key=lambda x: float(x["score"]), reverse=True)[:k]


def build_memory_context(query: str, user_id: int) -> str:
    """
    Tạo đoạn text memory để inject vào system prompt.
    Trả về chuỗi rỗng nếu không có memory liên quan.
    """
    memories = retrieve(query, user_id=user_id, k=5)
    if not memories:
        return ""

    lines = ["### Thông tin từ bộ nhớ hệ thống\n"]
    for m in memories:
        score = float(m["score"])
        src   = m["source"]
        if src == "episodic":
            lines.append(f"- [Lịch sử - {m['memory_type']}] {m['content']}")
        elif src == "semantic":
            lines.append(f"- [Kiến thức tổ chức] {m['content']}")
        elif src == "procedural":
            intent = m.get("intent", "")
            lines.append(f"- [Cách làm đã proven cho '{intent}'] {m['content']}")

        if cfg.DEBUG:
            lines[-1] += f"  (score={score:.2f})"

    return "\n".join(lines)


# ─── Working Memory (Redis session) ──────────────────────────────────────────

def wm_set(session_id: str, key: str, value: Any, ttl: int = 1800) -> None:
    """Lưu giá trị vào working memory của session. TTL mặc định 30 phút."""
    _redis.setex(
        f"wm:{session_id}:{key}",
        ttl,
        json.dumps(value, ensure_ascii=False, default=str),
    )


def wm_get(session_id: str, key: str) -> Any:
    """Lấy giá trị từ working memory. Trả về None nếu không có / hết hạn."""
    raw = _redis.get(f"wm:{session_id}:{key}")
    return json.loads(raw) if raw else None


# ─── Auto-extract memories sau session ───────────────────────────────────────

def extract_and_store(
    session_id: str,
    user_id: int,
    turns: list[dict],
    outcome: str,
) -> None:
    """
    Dùng LLM để rút ra thông tin đáng nhớ từ cuộc hội thoại vừa xong.
    Gọi sau khi đã response cho user (không block request).

    turns: [{"role": "user|assistant", "content": "..."}]
    outcome: câu trả lời cuối cùng của agent
    """
    if len(turns) < 2:
        return

    convo_text = "\n".join(
        f"{'User' if t['role'] == 'user' else 'Agent'}: {t['content']}"
        for t in turns[-6:]
    )

    prompt = f"""Phân tích hội thoại sau và trả về JSON với các thông tin đáng ghi nhớ.

HỘI THOẠI:
{convo_text}

KẾT QUẢ AGENT: {outcome[:400]}

Trả về đúng format JSON sau (chỉ JSON, không có text khác):
{{
  "episodic": [
    {{"type": "qa|estimate|preference", "content": "nội dung ngắn gọn, cụ thể"}}
  ],
  "semantic": [
    {{"category": "velocity|cost_pattern", "subject": "key_ngắn", "content": "fact rõ ràng"}}
  ],
  "procedural": [
    {{"type": "sql_template|tool_sequence", "intent": "mục đích", "template": "nội dung", "worked": true}}
  ]
}}

Quy tắc:
- Chỉ extract thông tin có GIÁ TRỊ LÂU DÀI (không extract thông tin nhất thời)
- Arrays rỗng [] nếu không có gì đáng nhớ
- "content" phải cụ thể và đầy đủ để hiểu mà không cần context"""

    try:
        response = _llm.chat.completions.create(
            model=cfg.LLM_MODEL,
            temperature=0,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=1024,
        )
        text = response.choices[0].message.content.strip()

        # Tìm JSON trong response
        match = re.search(r'\{.*\}', text, re.DOTALL)
        if not match:
            return
        data = json.loads(match.group())

    except Exception as e:
        if cfg.DEBUG:
            print(f"[Memory] extract_and_store error: {e}")
        return

    for ep in data.get("episodic", []):
        if ep.get("content"):
            store(MemoryItem(
                content=ep["content"],
                memory_type=ep.get("type", "qa"),
                user_id=user_id,
                session_id=session_id,
            ))

    for sem in data.get("semantic", []):
        if sem.get("content"):
            store(MemoryItem(
                content=sem["content"],
                memory_type=sem.get("category", "cost_pattern"),
                metadata={
                    "subject": sem.get("subject", sem["content"][:40]),
                    "source":  "auto_extracted",
                },
            ))

    for proc in data.get("procedural", []):
        if proc.get("worked") and proc.get("template"):
            store(MemoryItem(
                content=proc["template"],
                memory_type=proc.get("type", "tool_sequence"),
                metadata={"intent": proc.get("intent", "")},
            ))

    if cfg.DEBUG:
        ep_count   = len(data.get("episodic", []))
        sem_count  = len(data.get("semantic", []))
        proc_count = len([p for p in data.get("procedural", []) if p.get("worked")])
        print(f"[Memory] Stored: {ep_count} episodic, {sem_count} semantic, {proc_count} procedural")
