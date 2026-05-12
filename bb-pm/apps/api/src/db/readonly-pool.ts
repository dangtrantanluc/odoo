// Phase 1.1: Separate Postgres pool dùng role bb_pm_readonly cho report.query.
// Defense layer cuối — nếu sql-guard bypass, DML từ readonly role vẫn fail.
//
// Lazy-init: chỉ tạo pool khi env BB_PM_READONLY_PWD có giá trị. Nếu thiếu,
// fallback về Prisma client (warning, không secure đúng nghĩa).
//
// Connection string: derive từ DATABASE_URL nhưng thay user/password.

import { Pool, PoolConfig } from "pg";

let pool: Pool | null = null;
let initFailed = false;

export function getReadonlyPool(): Pool | null {
  if (initFailed) return null;
  if (pool) return pool;

  const dbUrl = process.env.DATABASE_URL;
  const roPwd = process.env.BB_PM_READONLY_PWD;
  if (!dbUrl || !roPwd) {
    console.warn(
      "[bb-pm/readonly-pool] BB_PM_READONLY_PWD or DATABASE_URL missing — readonly enforcement DISABLED, falling back to main client.",
    );
    initFailed = true;
    return null;
  }

  try {
    const url = new URL(dbUrl);
    const cfg: PoolConfig = {
      host: url.hostname,
      port: url.port ? Number(url.port) : 5432,
      database: url.pathname.replace(/^\//, ""),
      user: "bb_pm_readonly",
      password: roPwd,
      max: Number(process.env.READONLY_POOL_MAX ?? 5),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      // statement_timeout có thể set ở connection string options=
      // hoặc per-query SET. Per-query an toàn hơn (đa user) — set trong handler.
    };
    pool = new Pool(cfg);
    pool.on("error", (err) => {
      console.error("[bb-pm/readonly-pool] idle client error:", err.message);
    });
    return pool;
  } catch (err: any) {
    console.error("[bb-pm/readonly-pool] init failed:", err?.message ?? err);
    initFailed = true;
    return null;
  }
}

export async function shutdownReadonlyPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
