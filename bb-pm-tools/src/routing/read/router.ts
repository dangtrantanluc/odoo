import { toolsByName } from "../../tools";
import { normalizeLooseText } from "../../shared/text";

export type ReadRouteResult = { reply: string; pattern: string };

type ReadClassification = "read" | "action" | "ambiguous" | "other";

const ACTION_RE = /(^|\s)(tao|doi|giao|assign|danh\s*dau|update|xoa|gui|sua|chuyen)(?=\s|$)/u;
const QUESTION_RE = /\b(ai|gì|gi|nào|nao|bao\s+nhiêu|bao\s+nhieu)\b/iu;
const RANKING_RE = /\b(nhiều\s+nhất|nhieu\s+nhat|ít\s+nhất|it\s+nhat|nặng\s+nhất|nang\s+nhat|rảnh\s+nhất|ranh\s+nhat)\b/iu;
const ENTITY_RE = /\b(task|tasks|việc|viec|project|dự\s*án|du\s*an|deadline|blocker|workload|check[\s-]?in)\b/iu;
const STATUS_OR_TIME_RE = /\b(quá\s+hạn|qua\s+han|trễ\s+deadline|tre\s+deadline|done|hoàn\s+thành|hoan\s+thanh|tuần\s+này|tuan\s+nay|hôm\s+nay|hom\s+nay|sắp\s+đến\s+hạn|sap\s+den\s+han)\b/iu;
const READ_VERB_RE = /\b(thống\s+kê|thong\s+ke|liệt\s+kê|liet\s+ke|xem|cho\s+biết|cho\s+biet)\b/iu;

function normalize(q: string): string {
  return normalizeLooseText(q);
}

export function classifyReadTurn(text: string): ReadClassification {
  const q = text.trim();
  const n = normalize(q);
  if (!n) return "other";
  if (ACTION_RE.test(n)) return "action";

  const hasQuestion = QUESTION_RE.test(q);
  const hasRanking = RANKING_RE.test(q);
  const hasEntity = ENTITY_RE.test(q);
  const hasStatusOrTime = STATUS_OR_TIME_RE.test(q);
  const hasReadVerb = READ_VERB_RE.test(q);

  // Short fragments with a domain noun or name are not enough to query safely.
  const tokens = n.split(" ").filter(Boolean);
  if (
    tokens.length <= 3 &&
    !hasQuestion &&
    !hasRanking &&
    !hasStatusOrTime &&
    (hasEntity || looksLikeNameFragment(q))
  ) {
    return "ambiguous";
  }

  if (
    (hasQuestion && (hasEntity || hasStatusOrTime || hasRanking)) ||
    (hasRanking && hasEntity) ||
    (hasEntity && hasStatusOrTime) ||
    (hasEntity && hasReadVerb) ||
    (/^workload\s+/u.test(n) && tokens.length > 1)
  ) {
    return "read";
  }

  return "other";
}

function looksLikeNameFragment(q: string): boolean {
  const words = q.trim().split(/\s+/).filter(Boolean);
  return words.length >= 1 && words.length <= 3 && words.every((w) => /^[\p{L}]+$/u.test(w));
}

function clarifyRead(q: string): string {
  const n = normalize(q);
  if (n === "workload") return "Bạn muốn xem ai đang rảnh nhất hay ai đang nhận nhiều task nhất?";
  if (/^(project|du an)\s+\S+/u.test(n)) return `Bạn muốn xem tình hình dự án, task, hay thông tin nào của "${q.trim()}"?`;
  return `Bạn muốn tìm task, người dùng, hay thông tin gì liên quan đến "${q.trim()}"?`;
}

export async function tryTextToSqlRead(text: string): Promise<ReadRouteResult | null> {
  const q = text.trim();
  const classification = classifyReadTurn(q);
  if (classification === "action" || classification === "other") return null;
  if (classification === "ambiguous") {
    return { reply: clarifyRead(q), pattern: "read:ambiguous_clarified" };
  }

  const tool = toolsByName.get("report.query");
  if (!tool) return null;
  const result: any = await tool.handler({ question: q });
  if (result?.error) return null;

  if (Array.isArray(result?.rows)) {
    return { reply: formatRows(result.rows, result.rowCount), pattern: result?._translated ? "read:text_to_sql" : "read:keyword_fallback" };
  }
  if (Array.isArray(result)) {
    return { reply: formatRows(result, result.length), pattern: "read:keyword_fallback" };
  }
  if (Array.isArray(result?.tasks)) {
    return { reply: formatRows(result.tasks, result.total ?? result.tasks.length), pattern: "read:keyword_fallback" };
  }
  return null;
}

function formatRows(rows: any[], total = rows.length): string {
  if (!rows.length) return "0 kết quả.";
  const lines = rows.slice(0, 5).map((row) => Object.values(row).filter((v) => v !== null && v !== undefined).join(" · "));
  return `${total} kết quả: ${lines.join(" | ")}${total > 5 ? ` · và ${total - 5} kết quả khác` : ""}.`;
}
