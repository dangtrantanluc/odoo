import { chat, ChatMessage } from "../../infrastructure/llm-client";
import { config } from "../../shared/config";
import { KbDoc, RetrievalHints, retrieveSqlKnowledge } from "./knowledge-base";

export type TranslationResult = {
  sql: string;
  explanation?: string;
  metadata?: {
    retrievalSource: "opensearch" | "local" | "schema_fallback";
    retrievedContextIds: string[];
    tablesUsed: string[];
    hints?: RetrievalHints;
    repairCount: number;
    validationErrors: string[];
    timingsMs?: Record<string, number>;
  };
};

const MAX_QUESTION_LEN = 1000;
const KNOWN_SCOPED_TABLES = ["projects", "tasks", "users", "customers", "companies", "agent_audit_log", "agent_memory", "agent_follow_ups", "automations"];

export async function translateQuestionToSql(
  question: string,
  schemaDoc: string,
  callerCompanyId: number,
  callerUserId?: number,
  options?: { provider?: "default" | "gemini"; forceSchemaFallback?: boolean },
): Promise<TranslationResult> {
  validateInput(question, schemaDoc);
  const started = Date.now();
  if (options?.forceSchemaFallback) {
    return translateWithSchemaDoc(question, schemaDoc, callerCompanyId, callerUserId, options, started);
  }
  const retrievalStarted = Date.now();
  const retrieved = await retrieveSqlKnowledge(question, schemaDoc);
  const retrievalMs = Date.now() - retrievalStarted;
  if (!retrieved.docs.length) return translateWithSchemaDoc(question, schemaDoc, callerCompanyId, callerUserId, options, started);

  const raw = await generateSql(
    question,
    retrievalPrompt(retrieved.docs, retrieved.hints, callerCompanyId, callerUserId),
    options?.provider,
  );
  const parsed = parseSqlPayload(raw);
  const validationErrors = validateGeneratedSql(parsed.sql, retrieved.docs, callerCompanyId);
  return {
    sql: parsed.sql,
    explanation: parsed.explanation,
    metadata: {
      retrievalSource: retrieved.source,
      retrievedContextIds: retrieved.docs.map((d) => d.id),
      tablesUsed: extractTables(parsed.sql),
      hints: retrieved.hints,
      repairCount: 0,
      validationErrors,
      timingsMs: { retrieval: retrievalMs, total: Date.now() - started },
    },
  };
}

export async function repairQuestionSql(
  question: string,
  previousSql: string,
  executionError: string,
  schemaDoc: string,
  callerCompanyId: number,
  callerUserId?: number,
  previous?: TranslationResult,
  options?: { provider?: "default" | "gemini" },
): Promise<TranslationResult> {
  const docs = previous?.metadata?.retrievedContextIds?.length
    ? (await retrieveSqlKnowledge(question, schemaDoc)).docs
    : [];
  const context = docs.length ? renderContext(docs) : schemaDoc;
  const raw = await generateSql(
    question,
    `${baseRules(callerCompanyId, callerUserId)}\n\nCONTEXT:\n${context}\n\nSQL trước bị lỗi:\n${previousSql}\n\nLỗi backend:\n${executionError}\n\nSửa SQL, trả JSON thuần.`,
    options?.provider,
  );
  const parsed = parseSqlPayload(raw);
  return {
    sql: parsed.sql,
    explanation: parsed.explanation,
    metadata: {
      retrievalSource: docs.length ? "local" : "schema_fallback",
      retrievedContextIds: docs.map((d) => d.id),
      tablesUsed: extractTables(parsed.sql),
      repairCount: (previous?.metadata?.repairCount ?? 0) + 1,
      validationErrors: validateGeneratedSql(parsed.sql, docs, callerCompanyId),
    },
  };
}

async function translateWithSchemaDoc(question: string, schemaDoc: string, callerCompanyId: number, callerUserId: number | undefined, options: any, started: number): Promise<TranslationResult> {
  const raw = await generateSql(question, `${baseRules(callerCompanyId, callerUserId)}\n\nSCHEMA REFERENCE:\n${schemaDoc}`, options?.provider);
  const parsed = parseSqlPayload(raw);
  return { sql: parsed.sql, explanation: parsed.explanation, metadata: { retrievalSource: "schema_fallback", retrievedContextIds: [], tablesUsed: extractTables(parsed.sql), repairCount: 0, validationErrors: validateGeneratedSql(parsed.sql, [], callerCompanyId), timingsMs: { total: Date.now() - started } } };
}

function retrievalPrompt(docs: KbDoc[], hints: RetrievalHints, companyId: number, userId?: number): string {
  return `${baseRules(companyId, userId)}\n\nRETRIEVAL HINTS:\n${JSON.stringify(hints)}\n\nRELEVANT KNOWLEDGE:\n${renderContext(docs)}`;
}
function renderContext(docs: KbDoc[]): string {
  return docs.map((d) => {
    if (d.type === "example") return `EXAMPLE: ${d.question}\nSQL: ${d.sql}`;
    if (d.type === "column") return `COLUMN: ${d.table}.${d.column}\nMeaning: ${d.description}\nAliases: ${(d.aliases ?? []).join(", ")}`;
    return `TABLE: ${d.table}\nColumns: ${(d.columns ?? []).join(", ")}\nDescription: ${d.description ?? ""}`;
  }).join("\n\n");
}
function baseRules(companyId: number, userId?: number): string {
  return `Bạn là SQL writer chuyên cho bb-pm Postgres database. Dịch câu hỏi thành 1 SELECT an toàn.\nQUY TẮC:\n1. Output JSON: { "sql": "<SELECT>", "explanation": "<1 câu>" }.\n2. CHỈ SELECT; không DML/DDL.\n3. Mọi bảng có company_id phải scope company_id = ${companyId}; JOIN thì qualify alias.\n4. Caller user_id = ${userId ?? "(unknown)"}; dùng cho \"task của tôi\".\n5. Dùng snake_case; không SELECT *; LIMIT 50 nếu không aggregate.\n6. Overdue = status != 'DONE' AND deadline < NOW(); stale = updated_at < NOW() - INTERVAL '7 days'.\n7. Chỉ dùng bảng/cột trong context. Trả JSON thuần, không markdown.`;
}
async function generateSql(question: string, system: string, provider?: "default" | "gemini"): Promise<string> {
  const messages: ChatMessage[] = [{ role: "system", content: system }, { role: "user", content: question.trim() }];
  const chosen = provider ?? config.llm.activeProvider;
  for (let attempt = 0; attempt < 2; attempt++) {
    const resp = await chat(messages, undefined, { response_format: { type: "json_object" }, temperature: 0.1, max_tokens: 1200, provider: chosen });
    const raw = (resp.content ?? "").trim();
    if (raw) return raw;
  }
  throw new Error("Translator returned empty response after 2 attempts");
}
function validateInput(question: string, schemaDoc: string) { if (!question || question.length > MAX_QUESTION_LEN) throw new Error(`Question rỗng hoặc quá dài (max ${MAX_QUESTION_LEN}).`); if (!schemaDoc) throw new Error("Schema doc rỗng — không thể translate."); }
export function validateGeneratedSql(sql: string, docs: KbDoc[], companyId: number): string[] {
  const errors: string[] = [];
  if (!/^\s*select\b/i.test(sql)) errors.push("not_select");
  if (/\b(insert|update|delete|drop|alter|truncate)\b/i.test(sql)) errors.push("contains_mutation");
  const tables = extractTables(sql);
  if (tables.some((t) => KNOWN_SCOPED_TABLES.includes(t)) && !/\bcompany_id\s*=\s*\d+/i.test(sql)) errors.push("missing_company_scope");
  if (/\bcompany_id\s*=\s*(\d+)/i.test(sql) && Number(sql.match(/\bcompany_id\s*=\s*(\d+)/i)?.[1]) !== companyId) errors.push("wrong_company_scope");
  const contextTables = new Set(docs.flatMap((d) => [d.table, ...(d.tables ?? [])]).filter(Boolean));
  if (contextTables.size && tables.some((t) => !contextTables.has(t))) errors.push("table_outside_context");
  return errors;
}
export function extractTables(sql: string): string[] { return Array.from(sql.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)/gi)).map((m) => m[1].toLowerCase()); }
function parseSqlPayload(raw: string): { sql: string; explanation?: string } {
  const parsed = parseJsonLoose(raw);
  if (!parsed.sql || typeof parsed.sql !== "string") throw new Error(`Translator output missing sql field: ${raw.slice(0, 200)}`);
  return { sql: parsed.sql.trim(), explanation: parsed.explanation };
}
function parseJsonLoose(raw: string): any {
  try { return JSON.parse(raw); } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/); if (fenced) { try { return JSON.parse(fenced[1]); } catch {} }
  const start = raw.indexOf("{"); const end = raw.lastIndexOf("}"); if (start >= 0 && end > start) { try { return JSON.parse(raw.slice(start, end + 1)); } catch {} }
  const sqlMatch = raw.match(/"sql"\s*:\s*"((?:[^"\\]|\\.)*)"/); if (sqlMatch) return { sql: sqlMatch[1].replace(/\\n/g, " ").replace(/\\"/g, '"').replace(/\\\\/g, "\\"), explanation: raw.match(/"explanation"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1] };
  throw new Error(`SQL translator output not valid JSON: ${raw.slice(0, 200)}`);
}
