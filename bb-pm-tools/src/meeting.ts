import { chat, ChatMessage } from "./llm";

// ---------------------------------------------------------------------------
// Meeting transcript extraction (Sprint 5).
//
// 1 inner LLM call that returns strict JSON. We ask for JSON with
// `response_format: {type: "json_object"}` if the serving stack honours it;
// otherwise we fall back to regex-extracting the first JSON block.
// ---------------------------------------------------------------------------

export type ExtractedActionItem = {
  title: string;
  description?: string;
  ownerName?: string;
  dueDate?: string; // ISO 8601 date string, YYYY-MM-DD
  priority?: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
};

export type ExtractedMeeting = {
  title?: string;
  summary: string;
  decisions: string[];
  participants: string[];
  actionItems: ExtractedActionItem[];
};

const SYSTEM_PROMPT = `Bạn là meeting analyst. Từ transcript hội họp nhận được, trích xuất STRICT JSON đúng schema:

{
  "title": "tiêu đề ngắn gọn (optional, null nếu không rõ)",
  "summary": "tóm tắt ≤ 3 câu tiếng Việt",
  "decisions": ["quyết định 1", "quyết định 2", ...],
  "participants": ["Tên A", "Tên B", ...],
  "actionItems": [
    {
      "title": "ngắn gọn ≤ 200 ký tự — phải bắt đầu bằng động từ",
      "description": "chi tiết thêm nếu có, optional",
      "ownerName": "tên người phụ trách đúng như trong transcript, optional",
      "dueDate": "YYYY-MM-DD, optional",
      "priority": "LOW|MEDIUM|HIGH|URGENT, default MEDIUM"
    }
  ]
}

YÊU CẦU:
- Trả về **CHỈ JSON**, KHÔNG markdown, KHÔNG giải thích, KHÔNG wrap \`\`\`.
- Nếu không tìm thấy field nào → mảng rỗng/null, KHÔNG bịa.
- Mỗi actionItem phải là nhiệm vụ cụ thể, actionable (ai làm gì, hoặc cần làm gì).
- KHÔNG trích xuất câu nhận xét/chia sẻ thành action item.
- Chỉ dùng thông tin có trong transcript.`;

export async function extractMeetingFromTranscript(
  transcript: string,
): Promise<ExtractedMeeting> {
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `TRANSCRIPT:\n\n${truncate(transcript, 40_000)}` },
  ];

  const resp = await chat(messages, undefined, {
    // Ask for JSON. Some OpenAI-compatible servers (vLLM, Ollama) honour
    // this; others silently ignore it. We still parse defensively below.
    response_format: { type: "json_object" },
    // Extraction needs more room than a chat reply.
    max_tokens: 4096,
    // Keep deterministic-ish.
    temperature: 0.1,
  });

  const raw = (resp.content ?? "").trim();
  if (!raw) throw new Error("Empty extraction response");

  const parsed = parseJsonLoose(raw);
  return normalizeExtraction(parsed);
}

// ── helpers ────────────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 20) + "\n...[truncated]";
}

function parseJsonLoose(raw: string): any {
  // Try direct parse first.
  try {
    return JSON.parse(raw);
  } catch {
    // Strip markdown fences + try again.
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fenced) {
      try {
        return JSON.parse(fenced[1]);
      } catch {}
    }
    // Last resort: grab the first {...} block by balanced braces.
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const block = raw.slice(start, end + 1);
      return JSON.parse(block);
    }
    throw new Error("Extraction did not return parseable JSON");
  }
}

function normalizeExtraction(raw: any): ExtractedMeeting {
  const out: ExtractedMeeting = {
    title: typeof raw?.title === "string" ? raw.title.trim() : undefined,
    summary: typeof raw?.summary === "string" ? raw.summary.trim() : "",
    decisions: Array.isArray(raw?.decisions)
      ? raw.decisions.filter((d: unknown): d is string => typeof d === "string")
      : [],
    participants: Array.isArray(raw?.participants)
      ? raw.participants.filter((p: unknown): p is string => typeof p === "string")
      : [],
    actionItems: Array.isArray(raw?.actionItems)
      ? raw.actionItems
          .map((it: any) => normalizeItem(it))
          .filter((it: ExtractedActionItem | null): it is ExtractedActionItem => it !== null)
      : [],
  };
  return out;
}

function normalizeItem(raw: any): ExtractedActionItem | null {
  if (!raw || typeof raw !== "object") return null;
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) return null;
  const priority = ["LOW", "MEDIUM", "HIGH", "URGENT"].includes(raw.priority)
    ? (raw.priority as ExtractedActionItem["priority"])
    : "MEDIUM";
  return {
    title: title.slice(0, 500),
    description: typeof raw.description === "string" && raw.description.trim()
      ? raw.description.trim().slice(0, 4000)
      : undefined,
    ownerName: typeof raw.ownerName === "string" && raw.ownerName.trim()
      ? raw.ownerName.trim().slice(0, 200)
      : undefined,
    dueDate: typeof raw.dueDate === "string" && /^\d{4}-\d{2}-\d{2}/.test(raw.dueDate)
      ? raw.dueDate.slice(0, 10)
      : undefined,
    priority,
  };
}
