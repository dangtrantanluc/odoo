// Schema doc generator — reads Prisma DMMF, outputs markdown for agent
// system prompt. Includes:
//   - Bảng: tên DB (từ @@map) + cột DB (từ @map) + type + nullable
//   - Enum: tên + values
//   - Common scope hints (company_id check, status filter cho overdue/active)
//
// Generated once tại boot, cache trong module variable. Endpoint
// /agent/report/schema return cached value (fast).

import { Prisma } from "@prisma/client";

let cached: string | null = null;

export function getSchemaDoc(): string {
  if (cached) return cached;
  cached = buildSchemaDoc();
  return cached;
}

function buildSchemaDoc(): string {
  const dmmf = (Prisma as any).dmmf;
  if (!dmmf?.datamodel) return "(schema unavailable — Prisma client not generated?)";

  const models: any[] = dmmf.datamodel.models;
  const enums: any[] = dmmf.datamodel.enums;

  const lines: string[] = [];
  lines.push("# bb-pm DB Schema (Postgres) — for `report.query` SQL");
  lines.push("");
  lines.push("**LƯU Ý quan trọng:**");
  lines.push("- Cột DB là **snake_case** (vd `project_id`, `company_id`, `created_at`).");
  lines.push("- Tên model camelCase (vd `Task.projectId`) chỉ ở Prisma — SQL phải dùng tên cột DB.");
  lines.push("- Mọi query touch bảng có `company_id` PHẢI có `WHERE <alias>.company_id = $callerCompanyId` — server reject nếu thiếu.");
  lines.push("- Cột nhạy (password, jwt, secret, token) bị redact trong response.");
  lines.push("");

  // ── Tables (skip a few internal ones) ────────────
  const SKIP_MODELS = new Set([
    "Notification", // user-specific
    "Upload",
    "Activity",
  ]);
  const userVisibleModels = models.filter((m) => !SKIP_MODELS.has(m.name));

  lines.push("## Tables");
  lines.push("");
  for (const m of userVisibleModels) {
    const tableName = m.dbName ?? snakeCase(m.name);
    const cols: string[] = [];
    for (const f of m.fields) {
      if (f.kind === "object") continue; // skip relations — describe via FK below
      const colName = f.dbName ?? f.name;
      const type = f.kind === "enum" ? `enum:${f.type}` : f.type;
      const nullable = f.isRequired ? "" : "?";
      const flags: string[] = [];
      if (f.isId) flags.push("PK");
      if (f.isUnique) flags.push("UNIQUE");
      const flagStr = flags.length ? ` [${flags.join(",")}]` : "";
      cols.push(`${colName}: ${type}${nullable}${flagStr}`);
    }
    // Relations (FK info)
    const fks: string[] = [];
    for (const f of m.fields) {
      if (f.kind !== "object") continue;
      if (!f.relationFromFields?.length) continue;
      const fromCol = f.relationFromFields[0];
      const fromColDb = m.fields.find((x: any) => x.name === fromCol)?.dbName ?? snakeCase(fromCol);
      const targetModel = models.find((x: any) => x.name === f.type);
      const targetTable = targetModel?.dbName ?? snakeCase(f.type);
      fks.push(`${fromColDb} → ${targetTable}.id`);
    }

    lines.push(`### \`${tableName}\``);
    lines.push("");
    lines.push("Cột: " + cols.join(", "));
    if (fks.length) lines.push("FK: " + fks.join("; "));
    lines.push("");
  }

  // ── Enums ────────────────────────────────────────
  lines.push("## Enums");
  lines.push("");
  for (const e of enums) {
    const vals = e.values.map((v: any) => v.name).join(" | ");
    lines.push(`- **${e.name}**: ${vals}`);
  }
  lines.push("");

  // ── Common patterns ──────────────────────────────
  lines.push("## Common patterns (gợi ý)");
  lines.push("");
  lines.push("```sql");
  lines.push("-- Overdue tasks (deadline qua, chưa DONE)");
  lines.push("SELECT t.id, t.name, t.deadline, p.name AS project");
  lines.push("FROM tasks t JOIN projects p ON p.id = t.project_id");
  lines.push("WHERE p.company_id = $C AND t.status != 'DONE' AND t.deadline < NOW()");
  lines.push("ORDER BY t.deadline ASC LIMIT 50;");
  lines.push("");
  lines.push("-- My open tasks (caller userId = $U)");
  lines.push("SELECT t.id, t.name, t.status, t.deadline, p.name AS project");
  lines.push("FROM tasks t JOIN projects p ON p.id = t.project_id");
  lines.push("WHERE p.company_id = $C AND t.assignee_id = $U AND t.status != 'DONE';");
  lines.push("");
  lines.push("-- Workload theo dept (tasks chưa DONE)");
  lines.push("SELECT u.full_name, u.department, COUNT(t.id)::int AS open_tasks");
  lines.push("FROM users u LEFT JOIN tasks t ON t.assignee_id = u.id AND t.status != 'DONE'");
  lines.push("WHERE u.company_id = $C AND u.active = true");
  lines.push("GROUP BY u.id, u.full_name, u.department ORDER BY open_tasks ASC;");
  lines.push("```");
  return lines.join("\n");
}

function snakeCase(s: string): string {
  return s.replace(/([A-Z])/g, (_, c, i) => (i === 0 ? c.toLowerCase() : "_" + c.toLowerCase()));
}
