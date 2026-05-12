// SQL guard — validate + scope-inject + limit-inject SQL từ agent trước khi
// chạy. Mục đích defense-in-depth ngoài Postgres readonly role.
//
// Pipeline:
//   1. Parse với node-sql-parser (Postgres dialect).
//   2. AST validation: phải là single SELECT, reject DML keyword, reject
//      pg_catalog/information_schema, reject COPY/CALL/EXECUTE.
//   3. Limit injection: nếu thiếu LIMIT → append LIMIT N (default 200,
//      cap 1000).
//   4. (Caller responsibility) — companyId scope inject ở layer trên,
//      vì cần biết req.user.
//
// Trả ra { ok, sql, warnings } hoặc { ok:false, error }.

// node-sql-parser ships CJS — use namespace import for ESM compat under tsx.
import sqlParser from "node-sql-parser";

const parser = new (sqlParser as any).Parser();

const FORBIDDEN_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "TRUNCATE",
  "DROP",
  "ALTER",
  "CREATE",
  "GRANT",
  "REVOKE",
  "COPY",
  "CALL",
  "EXECUTE",
  "REINDEX",
  "VACUUM",
  "CLUSTER",
  "REFRESH",
  "LOCK",
  "SET",
  "RESET",
  "DECLARE",
  "FETCH",
  "MOVE",
  "LISTEN",
  "NOTIFY",
  "UNLISTEN",
];

const FORBIDDEN_TABLE_PREFIXES = ["pg_", "_prisma_"];
const FORBIDDEN_SCHEMAS = ["information_schema", "pg_catalog", "pg_toast"];

export type GuardResult =
  | { ok: true; sql: string; tables: string[]; warnings: string[] }
  | { ok: false; code: string; message: string };

export type GuardOptions = {
  /** Default 200, hard cap 1000. */
  defaultLimit?: number;
  /** Hard cap (no SELECT may exceed this). Default 1000. */
  maxLimit?: number;
};

export function guardSql(rawSql: string, opts: GuardOptions = {}): GuardResult {
  const defaultLimit = opts.defaultLimit ?? 200;
  const maxLimit = opts.maxLimit ?? 1000;

  const trimmed = rawSql.trim().replace(/;\s*$/, "");
  if (!trimmed) return { ok: false, code: "EMPTY_SQL", message: "SQL rỗng." };

  // Multi-statement reject — splitting by ';' is naive but cheap defense
  // against trailing INSERT/etc. Statements with ';' inside string literals
  // would parse-fail at next stage anyway.
  if (/;[^;]*\S/.test(trimmed)) {
    return { ok: false, code: "MULTI_STATEMENT", message: "Chỉ chấp 1 câu lệnh." };
  }

  let ast: any;
  try {
    ast = parser.astify(trimmed, { database: "postgresql" });
  } catch (err: any) {
    return { ok: false, code: "PARSE_ERROR", message: `SQL không parse được: ${err?.message ?? err}` };
  }

  // node-sql-parser trả mảng nếu multi-statement, object nếu single
  if (Array.isArray(ast)) {
    if (ast.length !== 1) {
      return { ok: false, code: "MULTI_STATEMENT", message: "Chỉ chấp 1 câu lệnh." };
    }
    ast = ast[0];
  }

  if (!ast || typeof ast !== "object" || ast.type !== "select") {
    return {
      ok: false,
      code: "NOT_SELECT",
      message: `Chỉ chấp SELECT. Nhận: ${ast?.type ?? "unknown"}.`,
    };
  }

  // Walk full AST string to detect forbidden keywords / table refs (defense
  // even if parser miscategorizes). Cheap belt-and-braces.
  for (const kw of FORBIDDEN_KEYWORDS) {
    // Word-boundary match — "UPDATE" inside "task.updatedAt" should not trigger.
    const re = new RegExp(`\\b${kw}\\b`, "i");
    if (re.test(trimmed) && !isInsideStringLiteral(trimmed, kw)) {
      // Special-case SELECT INTO (creates table) — reject. Plain SELECT OK.
      if (kw === "CREATE" || kw === "INSERT" || kw === "DROP" || kw === "ALTER" ||
          kw === "UPDATE" || kw === "DELETE" || kw === "MERGE" || kw === "TRUNCATE" ||
          kw === "COPY" || kw === "CALL" || kw === "EXECUTE" || kw === "GRANT" ||
          kw === "REVOKE") {
        return { ok: false, code: "FORBIDDEN_KEYWORD", message: `Cấm keyword: ${kw}` };
      }
    }
  }

  // Collect table refs from AST + reject system tables
  const tables = collectTables(ast);
  for (const t of tables) {
    const lc = t.toLowerCase();
    for (const prefix of FORBIDDEN_TABLE_PREFIXES) {
      if (lc.startsWith(prefix)) {
        return { ok: false, code: "FORBIDDEN_TABLE", message: `Cấm bảng: ${t}` };
      }
    }
    for (const schema of FORBIDDEN_SCHEMAS) {
      if (lc.includes(`${schema}.`) || lc === schema) {
        return { ok: false, code: "FORBIDDEN_SCHEMA", message: `Cấm schema: ${schema}` };
      }
    }
  }

  // Ensure LIMIT clause present + within cap
  const warnings: string[] = [];
  let finalSql = trimmed;
  const limitMatch = trimmed.match(/\bLIMIT\s+(\d+)\b/i);
  if (limitMatch) {
    const n = parseInt(limitMatch[1], 10);
    if (n > maxLimit) {
      finalSql = trimmed.replace(/\bLIMIT\s+\d+\b/i, `LIMIT ${maxLimit}`);
      warnings.push(`LIMIT ${n} → cap ${maxLimit}`);
    }
  } else {
    finalSql = `${trimmed} LIMIT ${defaultLimit}`;
    warnings.push(`Đã thêm LIMIT ${defaultLimit}`);
  }

  return { ok: true, sql: finalSql, tables, warnings };
}

// Recursively walk AST node + collect table refs from FROM/JOIN.
function collectTables(node: any, acc: Set<string> = new Set()): string[] {
  if (!node || typeof node !== "object") return Array.from(acc);
  // FROM clause: array of { table, db, schema, ... } or join nodes
  if (Array.isArray(node.from)) {
    for (const f of node.from) {
      if (f.table) {
        const ref = f.db || f.schema ? `${f.db || f.schema}.${f.table}` : f.table;
        acc.add(String(ref).toLowerCase());
      }
      collectTables(f, acc);
    }
  }
  // Subqueries / CTEs
  if (node.with && Array.isArray(node.with)) {
    for (const w of node.with) collectTables(w?.stmt, acc);
  }
  for (const key of ["where", "having", "left", "right", "expr", "ast", "stmt", "args"]) {
    if (node[key] !== undefined) collectTables(node[key], acc);
  }
  if (Array.isArray(node.columns)) {
    for (const c of node.columns) collectTables(c, acc);
  }
  return Array.from(acc);
}

// Crude check — does keyword appear inside a single-quoted string literal?
// e.g., SELECT 'I love UPDATE' — should not trigger UPDATE keyword check.
function isInsideStringLiteral(sql: string, keyword: string): boolean {
  const re = new RegExp(`'[^']*\\b${keyword}\\b[^']*'`, "i");
  return re.test(sql);
}
