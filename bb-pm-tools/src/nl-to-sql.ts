// Phase 1.2 — NL→SQL inner translator. Called từ report.query handler khi
// LLM gọi với question (không kèm sql). Inner chat() call với schema doc
// trong system prompt + question + JSON output mode.
//
// Trả ra { sql, explanation } hoặc throw nếu translate fail.
//
// Dùng cùng LLM provider configured (default Qwen, override gemini). Token
// cost: ~2k schema + ~200 query + ~300 response = ~2.5k tokens/translation.

import { chat, ChatMessage } from "./llm";
import { config } from "./config";

export type TranslationResult = {
  sql: string;
  explanation?: string;
};

const SYSTEM_TEMPLATE = (schemaDoc: string, callerCompanyId: number, callerUserId?: number) => `
Bạn là SQL writer chuyên cho bb-pm Postgres database. Nhiệm vụ: dịch câu hỏi
natural-language → 1 SELECT statement an toàn.

QUY TẮC:
1. Output JSON: { "sql": "<SELECT statement>", "explanation": "<1 câu mô tả>" }.
2. CHỈ SELECT — KHÔNG INSERT/UPDATE/DELETE/DROP/ALTER.
3. PHẢI có WHERE company_id filter:
   - Caller company_id = ${callerCompanyId} (CỐ ĐỊNH, không sửa)
   - Bảng có company_id: projects, tasks, users, customers, agent_audit_log,
     agent_memory, agent_follow_ups, automations, companies.
   - JOIN multiple tables → qualify với alias: "p.company_id = ${callerCompanyId}".
4. Caller user_id = ${callerUserId ?? "(unknown)"} — dùng cho câu "task của tôi".
5. SELECT cụ thể cột (không SELECT *), trừ trường hợp single-row sample.
6. Cột DB là snake_case: project_id, assignee_id, deadline, updated_at, ...
   KHÔNG dùng tên Prisma camelCase.
7. Mặc định LIMIT 50 nếu không phải aggregate.
8. Status filter:
   - Overdue: t.status != 'DONE' AND t.deadline < NOW()
   - Stale: t.updated_at < NOW() - INTERVAL '7 days'
9. Date format: ISO timestamps (YYYY-MM-DD HH:mm:ss). Postgres functions:
   NOW(), CURRENT_DATE, INTERVAL '7 days', DATE_TRUNC('week', NOW()).

SCHEMA REFERENCE:
${schemaDoc}

TRẢ JSON THUẦN — KHÔNG markdown, KHÔNG \`\`\`, KHÔNG giải thích ngoài JSON.`;

const MAX_QUESTION_LEN = 1000;

/**
 * Translate natural-language question → SQL via inner LLM call.
 * Throws nếu LLM trả non-JSON / SQL không parseable.
 */
export async function translateQuestionToSql(
  question: string,
  schemaDoc: string,
  callerCompanyId: number,
  callerUserId?: number,
  options?: { provider?: "default" | "gemini" },
): Promise<TranslationResult> {
  if (!question || question.length > MAX_QUESTION_LEN) {
    throw new Error(`Question rỗng hoặc quá dài (max ${MAX_QUESTION_LEN}).`);
  }
  if (!schemaDoc) {
    throw new Error("Schema doc rỗng — không thể translate.");
  }

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_TEMPLATE(schemaDoc, callerCompanyId, callerUserId) },
    { role: "user", content: question.trim() },
  ];

  const provider = options?.provider ?? config.llm.activeProvider;
  let raw = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const resp = await chat(messages, undefined, {
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 2000,
      provider,
    });
    raw = (resp.content ?? "").trim();
    if (raw) break;
  }
  if (!raw) throw new Error("Translator returned empty response after 2 attempts");

  const parsed = parseJsonLoose(raw);
  if (!parsed.sql || typeof parsed.sql !== "string") {
    throw new Error(`Translator output missing sql field: ${raw.slice(0, 200)}`);
  }
  return { sql: parsed.sql.trim(), explanation: parsed.explanation };
}

function parseJsonLoose(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fenced) {
      try {
        return JSON.parse(fenced[1]);
      } catch {}
    }
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {}
    }
    // Last resort: regex-extract sql field. Qwen + response_format=json_object
    // có lúc miss closing brace nhưng SQL value đã complete.
    const sqlMatch = raw.match(/"sql"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (sqlMatch) {
      const sql = sqlMatch[1].replace(/\\n/g, " ").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      const expl = raw.match(/"explanation"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      return { sql, explanation: expl?.[1]?.replace(/\\n/g, " ") };
    }
    throw new Error(`SQL translator output not valid JSON: ${raw.slice(0, 200)}`);
  }
}
