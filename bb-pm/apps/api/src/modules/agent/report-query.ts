// POST /api/v1/agent/report/query — Phase 1 SQL gateway.
//
// Phase 1 MVP scope:
//   - Accept { sql: string } (raw SELECT)
//   - guardSql(): AST validate, reject DML, inject LIMIT
//   - Inject companyId scope at app layer (TODO Phase 1.1 — sau khi
//     readonly role được tạo)
//   - Execute via prisma.$queryRawUnsafe (re-uses existing pool —
//     readonly role là Phase 1.1)
//   - Return { rows, rowCount, sqlExecuted, warnings, durationMs }
//
// Phase 1.1 (next session):
//   - Readonly Postgres role + separate pool
//   - Inner LLM call cho NL→SQL khi caller chỉ truyền {question}
//   - Schema doc generator để LLM biết cấu trúc

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { guardSql } from "../../lib/sql-guard.js";
import { getSchemaDoc } from "../../lib/schema-doc.js";
import { getReadonlyPool } from "../../db/readonly-pool.js";

const reportQueryBody = z.object({
  question: z.string().max(2000).optional(),
  sql: z.string().min(8).max(8000).optional(),
  hint: z
    .object({
      entity: z.string().max(64).optional(),
      filters: z.record(z.any()).optional(),
    })
    .optional(),
});

const STMT_TIMEOUT_MS = 5000;

const reportQueryRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  // GET /agent/report/schema — returns markdown schema doc cho agent prompt.
  // Generate 1 lần ở first call, cached. Plugin fetch + cache ở boot.
  app.get("/schema", async (_req) => {
    return { data: { schema: getSchemaDoc(), generatedAt: new Date().toISOString() } };
  });

  app.post("/query", { schema: { body: reportQueryBody } }, async (req, reply) => {
    const body = req.body as z.infer<typeof reportQueryBody>;
    if (!body.sql && !body.question) {
      return reply.code(400).send({
        error: { code: "MISSING_INPUT", message: "Cần truyền `sql` hoặc `question`." },
      });
    }

    // Phase 1 MVP: chỉ support raw SQL. NL→SQL translator sẽ build ở Phase 1.1.
    if (!body.sql) {
      return reply.code(501).send({
        mode: "MISSING",
        reason:
          "NL→SQL translator chưa build (Phase 1.1). Tạm thời truyền `sql` SELECT trực tiếp. " +
          "Schema sẽ có ở Phase 1.1.",
        suggested_tool: {
          name: "report.query",
          description: "NL→SQL translation pending",
          params: { question: "string", sql: "string" },
        },
      });
    }

    // 1. AST guard
    const guard = guardSql(body.sql);
    if (!guard.ok) {
      return reply.code(400).send({
        error: { code: guard.code, message: guard.message },
      });
    }

    // 2. Company scope check.
    // Tables có cột company_id trong bb-pm: projects, users, customers,
    // companies, tasks, agent_audit_log... Auto-inject với JOIN sẽ gây
    // ambiguous, nên Phase 1 MVP đòi LLM phải tự thêm scope filter.
    // Phase 1.1 sẽ inject AST-level (qualify với alias đúng).
    let sqlToRun = guard.sql;
    const userScope = (req as any).user;
    if (userScope && !userScope.isSuperAdmin) {
      const companyId = userScope.companyId;
      const COMPANY_SCOPED = [
        "projects",
        "users",
        "customers",
        "companies",
        "tasks",
        "agent_audit_log",
        "agent_memory",
        "agent_follow_ups",
      ];
      const touchedScoped = guard.tables.filter((t) =>
        COMPANY_SCOPED.includes(t.split(".").pop() ?? ""),
      );
      const hasCompanyFilter = /\bcompany_id\b/i.test(sqlToRun);
      if (touchedScoped.length > 0 && !hasCompanyFilter) {
        return reply.code(400).send({
          error: {
            code: "MISSING_COMPANY_SCOPE",
            message:
              `Query touch table có company_id (${touchedScoped.join(", ")}) ` +
              `nhưng thiếu WHERE company_id filter. Thêm 'WHERE <alias>.company_id = ${companyId}' ` +
              `(hoặc đưa vào JOIN ON). Note: column DB là snake_case "company_id" (không phải "companyId").`,
          },
        });
      }
      // Sanity: nếu agent đặt company_id khác companyId của caller → reject
      // (tránh impersonation). Best-effort regex; Phase 1.1 dùng AST.
      const explicitCompanyMatch = sqlToRun.match(/\bcompany_id\s*=\s*(\d+)/i);
      if (explicitCompanyMatch && parseInt(explicitCompanyMatch[1], 10) !== companyId) {
        return reply.code(403).send({
          error: {
            code: "WRONG_COMPANY_SCOPE",
            message: `Caller company_id=${companyId} nhưng SQL ép company_id=${explicitCompanyMatch[1]}. Reject.`,
          },
        });
      }
    }

    // 3. Execute với statement_timeout. Ưu tiên readonly pool (defense layer);
    //    fallback Prisma client nếu chưa setup readonly role.
    const t0 = Date.now();
    let rows: any[] = [];
    let rowCount = 0;
    const readonlyPool = getReadonlyPool();
    try {
      if (readonlyPool) {
        // Real readonly enforcement — DB role không có DML privilege.
        const client = await readonlyPool.connect();
        try {
          await client.query(`SET statement_timeout = ${STMT_TIMEOUT_MS}`);
          const result = await client.query(sqlToRun);
          rows = result.rows;
          rowCount = result.rowCount ?? rows.length;
        } finally {
          client.release();
        }
      } else {
        // Fallback: Prisma client (full DB access — guard chỉ là defense ở app layer)
        const result: any[] = await app.prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${STMT_TIMEOUT_MS}`);
          return await tx.$queryRawUnsafe(sqlToRun);
        });
        rows = Array.isArray(result) ? result : [];
        rowCount = rows.length;
        guard.warnings.push("readonly role not configured — fell back to main DB client");
      }
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (/statement timeout/i.test(msg) || /canceling statement due to statement timeout/i.test(msg)) {
        return reply.code(408).send({
          error: { code: "QUERY_TIMEOUT", message: `Query > ${STMT_TIMEOUT_MS}ms` },
          sqlExecuted: sqlToRun,
        });
      }
      return reply.code(500).send({
        error: { code: "SQL_ERROR", message: truncate(msg, 500) },
        sqlExecuted: sqlToRun,
      });
    }
    const durationMs = Date.now() - t0;

    // 4. Sanitize: strip cột nhạy + truncate big strings
    const sanitized = rows.map(sanitizeRow);

    // 5. Cap response size
    const MAX_ROWS = 200;
    const truncated = sanitized.length > MAX_ROWS;
    const finalRows = truncated ? sanitized.slice(0, MAX_ROWS) : sanitized;

    return {
      data: {
        rows: finalRows,
        rowCount,
        truncated,
        sqlExecuted: sqlToRun,
        warnings: guard.warnings,
        durationMs,
      },
    };
  });
};

const SECRET_KEYS = /password|hash|jwt|secret|apikey|api_key|token/i;

function sanitizeRow(row: any): any {
  if (!row || typeof row !== "object") return row;
  const out: any = Array.isArray(row) ? [] : {};
  for (const [k, v] of Object.entries(row)) {
    if (SECRET_KEYS.test(k)) {
      out[k] = "[REDACTED]";
      continue;
    }
    if (typeof v === "string" && v.length > 2000) {
      out[k] = v.slice(0, 2000) + "...[truncated]";
      continue;
    }
    if (typeof v === "bigint") {
      // Prisma trả BigInt từ COUNT — JSON.stringify chết. Convert sang Number
      // (an toàn vì COUNT của bb-pm scale < 2^53).
      out[k] = Number(v);
      continue;
    }
    out[k] = v;
  }
  return out;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "..." : s;
}

export default reportQueryRoutes;
