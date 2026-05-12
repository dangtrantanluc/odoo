"""
Database: kết nối PostgreSQL Odoo.

Cách dùng:
    from core.database import db_cursor

    with db_cursor() as cur:
        cur.execute("SELECT id, name FROM bb_project LIMIT 5")
        rows = cur.fetchall()   # rows là list[dict] nhờ RealDictCursor

Lưu ý:
    - Odoo tạo DB tên "odoo", KHÔNG phải "project_management"
    - Mỗi lần gọi db_cursor() tạo connection mới → dùng connection pool
      nếu load cao (psycopg2.pool.ThreadedConnectionPool)
"""
from contextlib import contextmanager

import psycopg2
import psycopg2.extras

from core.config import cfg


def get_connection() -> psycopg2.extensions.connection:
    """Tạo một connection mới tới Odoo PostgreSQL."""
    return psycopg2.connect(
        host=cfg.DB_HOST,
        port=cfg.DB_PORT,
        dbname=cfg.DB_NAME,
        user=cfg.DB_USER,
        password=cfg.DB_PASSWORD,
        # Trả kết quả dạng dict thay vì tuple
        cursor_factory=psycopg2.extras.RealDictCursor,
        connect_timeout=10,
    )


@contextmanager
def db_cursor():
    """
    Context manager: mở connection, trả cursor, tự commit/rollback, đóng.

    Ví dụ:
        with db_cursor() as cur:
            cur.execute("SELECT ...")
            rows = cur.fetchall()
    """
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            yield cur
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def test_connection() -> bool:
    """Kiểm tra kết nối DB còn sống. Dùng cho /health endpoint."""
    try:
        with db_cursor() as cur:
            cur.execute("SELECT 1")
        return True
    except Exception as e:
        if cfg.DEBUG:
            print(f"[DB] Connection failed: {e}")
        return False
