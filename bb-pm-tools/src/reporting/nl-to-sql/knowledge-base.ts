import { normalizeVietnameseText } from "../../shared/text";
import fetch from "node-fetch";

export type KbDocType = "table" | "column" | "example" | "query_log";
export type KbDoc = {
  id: string;
  type: KbDocType;
  entity?: string;
  table?: string;
  column?: string;
  tables?: string[];
  columns?: string[];
  keywords?: string[];
  aliases?: string[];
  description?: string;
  question?: string;
  sql?: string;
  tags?: string[];
};
export type RetrievalHints = {
  entity: string;
  keywords: string[];
  metric?: string;
  timeFilter?: string;
  selfReference: boolean;
};
export type RetrievalResult = { docs: KbDoc[]; source: "opensearch" | "local"; hints: RetrievalHints };

const OPENSEARCH_URL = process.env.BB_PM_SQL_KB_URL || "";
const OPENSEARCH_INDEX = process.env.BB_PM_SQL_KB_INDEX || "bb-pm-text-to-sql-kb";
const OPENSEARCH_USER = process.env.BB_PM_SQL_KB_USER || "";
const OPENSEARCH_PASSWORD = process.env.BB_PM_SQL_KB_PASSWORD || "";
const OPENSEARCH_ENABLED = Boolean(OPENSEARCH_URL) && process.env.BB_PM_SQL_KB_ENABLED !== "0";
let seededSchemaFingerprint = "";

const ENTITY_ALIASES: Record<string, string[]> = {
  tasks: ["task", "việc", "công việc", "deadline", "quá hạn", "overdue", "stale", "blocker"],
  projects: ["project", "dự án", "du an"],
  users: ["user", "người", "nhân viên", "assignee", "phụ trách", "workload"],
  checkins: ["checkin", "check-in", "cập nhật tiến độ"],
};
const SYNONYMS: Record<string, string[]> = {
  "quá hạn": ["overdue", "trễ hạn", "trễ deadline"],
  "task": ["việc", "công việc"],
  "người phụ trách": ["assignee", "owner"],
  "dự án active": ["project active", "dự án đang chạy"],
};

const CURATED_COLUMNS: KbDoc[] = [
  { id: "col:tasks.status", type: "column", entity: "tasks", table: "tasks", column: "status", aliases: ["trạng thái", "done", "đang mở"], description: "Trạng thái task: TODO, IN_PROGRESS, REVIEW, DONE." },
  { id: "col:tasks.deadline", type: "column", entity: "tasks", table: "tasks", column: "deadline", aliases: ["hạn", "deadline", "quá hạn"], description: "Hạn hoàn thành task; overdue = deadline < NOW() và status != DONE." },
  { id: "col:tasks.assignee_id", type: "column", entity: "tasks", table: "tasks", column: "assignee_id", aliases: ["người phụ trách", "assignee", "task của"], description: "User được giao task." },
  { id: "col:projects.status", type: "column", entity: "projects", table: "projects", column: "status", aliases: ["active", "đang chạy"], description: "Trạng thái dự án; active thường gồm PLANNED, IN_PROGRESS, ON_HOLD." },
  { id: "col:users.full_name", type: "column", entity: "users", table: "users", column: "full_name", aliases: ["tên", "nhân viên"], description: "Tên hiển thị của user nội bộ." },
];
const CURATED_EXAMPLES: KbDoc[] = [
  { id: "ex:my-open-tasks", type: "example", entity: "tasks", question: "task của tôi", keywords: ["task", "của tôi", "open"], tables: ["tasks", "projects"], sql: "SELECT t.id, t.name, t.status, t.deadline, p.name AS project FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.company_id = $C AND t.assignee_id = $U AND t.status != 'DONE' ORDER BY t.deadline ASC NULLS LAST LIMIT 50;" },
  { id: "ex:person-tasks", type: "example", entity: "tasks", question: "task của Phương Thảo", keywords: ["task", "người phụ trách"], tables: ["tasks", "projects", "users"], sql: "SELECT t.id, t.name, t.status, p.name AS project FROM tasks t JOIN projects p ON p.id = t.project_id JOIN users u ON u.id = t.assignee_id WHERE p.company_id = $C AND u.full_name ILIKE '%Phương Thảo%' AND t.status != 'DONE' LIMIT 50;" },
  { id: "ex:overdue-owner", type: "example", entity: "tasks", question: "ai có nhiều task quá hạn nhất", keywords: ["quá hạn", "nhiều nhất"], tables: ["tasks", "projects", "users"], sql: "SELECT u.full_name, COUNT(t.id)::int AS overdue_tasks FROM tasks t JOIN projects p ON p.id = t.project_id JOIN users u ON u.id = t.assignee_id WHERE p.company_id = $C AND t.status != 'DONE' AND t.deadline < NOW() GROUP BY u.id, u.full_name ORDER BY overdue_tasks DESC LIMIT 10;" },
  { id: "ex:blocked-projects", type: "example", entity: "projects", question: "dự án nào còn nhiều blocker", keywords: ["dự án", "blocker"], tables: ["tasks", "projects", "task_blockers"], sql: "SELECT p.name, COUNT(b.id)::int AS blocker_count FROM projects p JOIN tasks t ON t.project_id = p.id JOIN task_blockers b ON b.task_id = t.id WHERE p.company_id = $C AND t.status != 'DONE' GROUP BY p.id, p.name ORDER BY blocker_count DESC LIMIT 10;" },
  { id: "ex:done-week", type: "example", entity: "tasks", question: "tuần này có bao nhiêu task done", keywords: ["tuần này", "done", "bao nhiêu"], tables: ["tasks", "projects"], sql: "SELECT COUNT(t.id)::int AS done_tasks FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.company_id = $C AND t.status = 'DONE' AND t.updated_at >= DATE_TRUNC('week', NOW());" },
];

export function extractRetrievalHints(question: string): RetrievalHints {
  const q = normalize(question);
  const entity = Object.entries(ENTITY_ALIASES).find(([, words]) => words.some((w) => q.includes(normalize(w))))?.[0] ?? "tasks";
  const keywords = Array.from(new Set(q.split(/\s+/).filter(Boolean).flatMap((w) => [w, ...(SYNONYMS[w] ?? [])]))).slice(0, 16);
  const metric = /bao nhieu|count|nhiều nhất/.test(q) ? "count" : undefined;
  const timeFilter = /tuan nay|tuần này/.test(q) ? "this_week" : /hom nay|hôm nay/.test(q) ? "today" : undefined;
  return { entity, keywords, metric, timeFilter, selfReference: /cua toi|của tôi|cua minh|của mình/.test(q) };
}

export function buildKnowledgeDocs(schemaDoc: string): KbDoc[] {
  const tableDocs: KbDoc[] = [];
  const re = /### `([^`]+)`\s*\n\s*Cột: ([^\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(schemaDoc))) {
    const table = m[1];
    const columns = m[2].split(", ").map((c) => c.split(":")[0]);
    tableDocs.push({ id: `table:${table}`, type: "table", entity: inferEntity(table), table, tables: [table], columns, description: `Bảng ${table}. Cột: ${columns.join(", ")}` });
  }
  return [...tableDocs, ...CURATED_COLUMNS, ...CURATED_EXAMPLES];
}

export async function retrieveSqlKnowledge(question: string, schemaDoc: string, topK = 8): Promise<RetrievalResult> {
  const hints = extractRetrievalHints(question);
  const localDocs = rankLocal(buildKnowledgeDocs(schemaDoc), question, hints).slice(0, topK);
  if (!OPENSEARCH_ENABLED) return { docs: localDocs, source: "local", hints };
  try {
    await ensureKnowledgeBase(schemaDoc);
    const docs = await searchOpenSearch(question, hints, topK);
    return { docs: docs.length ? docs : localDocs, source: docs.length ? "opensearch" : "local", hints };
  } catch (err: any) {
    console.warn("[text-to-sql-kb] retrieval failed, using local KB:", String(err?.message ?? err).slice(0, 180));
    return { docs: localDocs, source: "local", hints };
  }
}

async function ensureKnowledgeBase(schemaDoc: string) {
  const fp = `${schemaDoc.length}:${schemaDoc.slice(-80)}`;
  if (seededSchemaFingerprint === fp) return;
  const exists = await osFetch(`/${OPENSEARCH_INDEX}`, { method: "HEAD" });
  if (exists.status === 404) {
    await osFetch(`/${OPENSEARCH_INDEX}`, { method: "PUT", body: JSON.stringify({ mappings: { properties: { type: { type: "keyword" }, entity: { type: "keyword" }, table: { type: "keyword" }, column: { type: "keyword" }, tables: { type: "keyword" }, columns: { type: "keyword" }, keywords: { type: "text" }, aliases: { type: "text" }, description: { type: "text" }, question: { type: "text" }, sql: { type: "text" }, tags: { type: "keyword" } } } }) });
  }
  const docs = buildKnowledgeDocs(schemaDoc);
  const body = docs.flatMap((doc) => [JSON.stringify({ index: { _index: OPENSEARCH_INDEX, _id: doc.id } }), JSON.stringify(doc)]).join("\n") + "\n";
  await osFetch("/_bulk?refresh=true", { method: "POST", headers: { "Content-Type": "application/x-ndjson" }, body });
  seededSchemaFingerprint = fp;
}

async function searchOpenSearch(question: string, hints: RetrievalHints, topK: number): Promise<KbDoc[]> {
  const expanded = `${question} ${hints.keywords.join(" ")}`;
  const body = { size: topK, query: { bool: { should: [
    { term: { entity: { value: hints.entity, boost: 3 } } },
    { multi_match: { query: expanded, fields: ["question^5", "keywords^4", "aliases^4", "description^2", "sql"], type: "best_fields" } },
    { term: { type: { value: "example", boost: 2 } } },
  ], minimum_should_match: 1 } } };
  const res = await osFetch(`/${OPENSEARCH_INDEX}/_search`, { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`OpenSearch search ${res.status}`);
  const payload: any = await res.json();
  return (payload.hits?.hits ?? []).map((h: any) => h._source as KbDoc);
}

function rankLocal(docs: KbDoc[], question: string, hints: RetrievalHints): KbDoc[] {
  const q = normalize(`${question} ${hints.keywords.join(" ")}`);
  return docs.map((doc) => ({ doc, score: scoreDoc(doc, q, hints) })).sort((a, b) => b.score - a.score).map((x) => x.doc);
}
function scoreDoc(doc: KbDoc, q: string, hints: RetrievalHints): number {
  let s = doc.type === "example" ? 2 : 0;
  if (doc.entity === hints.entity) s += 3;
  for (const text of [doc.question, doc.description, ...(doc.keywords ?? []), ...(doc.aliases ?? [])]) if (text && q.includes(normalize(text))) s += 2;
  return s;
}
function inferEntity(table: string) { if (table.startsWith("project")) return "projects"; if (table.startsWith("user")) return "users"; if (table.includes("checkin")) return "checkins"; return "tasks"; }
function normalize(s: string) { return normalizeVietnameseText(s); }
async function osFetch(path: string, init: any) {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(init.headers ?? {}) };
  if (OPENSEARCH_USER) headers.authorization = `Basic ${Buffer.from(`${OPENSEARCH_USER}:${OPENSEARCH_PASSWORD}`).toString("base64")}`;
  return fetch(`${OPENSEARCH_URL.replace(/\/$/, "")}${path}`, { ...init, headers });
}
