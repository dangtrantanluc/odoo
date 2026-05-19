import { buildKnowledgeDocs, extractRetrievalHints, retrieveSqlKnowledge } from "../src/text-to-sql-kb";
import { extractTables, validateGeneratedSql } from "../src/nl-to-sql";

const schema = `### \`tasks\`\n\nCột: id: Int, name: String, status: enum:TaskStatus, deadline: DateTime?, assignee_id: Int?, project_id: Int, company_id: Int\n\n### \`projects\`\n\nCột: id: Int, name: String, status: enum:ProjectStatus, company_id: Int\n\n### \`users\`\n\nCột: id: Int, full_name: String, company_id: Int\n`;
function ok(v: unknown, msg: string) { if (!v) throw new Error(msg); }
const hints = extractRetrievalHints("ai có nhiều task quá hạn nhất");
ok(hints.entity === "tasks", "entity tasks");
ok(hints.keywords.includes("task"), "keywords");
const docs = buildKnowledgeDocs(schema);
ok(docs.some((d) => d.id === "table:tasks"), "table generated");
ok(docs.some((d) => d.id === "ex:overdue-owner"), "curated example");
const tables = extractTables("SELECT t.id FROM tasks t JOIN projects p ON p.id=t.project_id WHERE p.company_id = 1");
ok(tables.join(",") === "tasks,projects", "table extraction");
ok(validateGeneratedSql("SELECT t.id FROM tasks t JOIN projects p ON p.id=t.project_id WHERE p.company_id = 1", docs, 1).length === 0, "valid sql");
ok(validateGeneratedSql("SELECT t.id FROM tasks t", docs, 1).includes("missing_company_scope"), "scope validation");
retrieveSqlKnowledge("task của tôi", schema).then((r) => {
  ok(r.docs.length > 0, "retrieval docs");
  ok(r.docs.some((d) => d.id === "ex:my-open-tasks"), "retrieval ranked example");
  console.log("✅ nl-to-sql tests pass");
});
