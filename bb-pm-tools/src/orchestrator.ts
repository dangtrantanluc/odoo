import { config } from "./config";
import { chat, ChatMessage } from "./llm";
import { toolCatalog, toolsByName } from "./tools";
import { bbPm } from "./api-client";
import { recallMemoryContext, summarizeAndStore } from "./memory";
import type { AgentContext } from "./types";

export type { AgentContext };

const SYSTEM_PROMPT_BASE = `Bạn là PM Agent của BlueBolt — trợ lý ảo cho Project Manager, trả lời bằng tiếng Việt.

KHẢ NĂNG (Sprint 1-5 — Level 1 + 2 + 3 + 4):

Quan sát (L1):
- list_overdue_tasks          — task quá hạn deadline
- list_stale_tasks            — task lâu chưa cập nhật
- list_blocked_tasks          — task đã được đánh dấu blocker
- check_data_hygiene          — task thiếu owner / deadline / update
- generate_daily_digest       — rollup toàn bộ dự án active
- get_project_snapshot        — chi tiết 1 dự án
- get_task_owner              — assignee của 1 task

Follow-up (L2):
- send_follow_up              — nhắn Gapo hỏi tiến độ (có cooldown 24h / task), tự ghi vào agent_follow_ups
- list_pending_follow_ups     — list các follow-up đã gửi nhưng chưa được reply
- mark_follow_up_replied      — đánh dấu 1 follow-up đã được reply / cancel / expired
- post_blocker                — ghi nhận blocker kèm severity LOW/MED/HIGH
- update_task_status          — transition task (TODO ↔ IN_PROGRESS ↔ REVIEW ↔ DONE)
- create_action_item          — tạo task mới trong dự án

Tổng hợp (L3 — Sprint 4):
- generate_weekly_report      — rollup 7 ngày: done / blocker mới / hours approved / upcoming deadline
- recall_memory               — nhớ lại cuộc nói chuyện trước đó khi user hỏi kế thừa context

Điều phối (L4 — Sprint 5):
- ingest_meeting              — transcript → LLM extract → Meeting + DRAFT action items
- approve_meeting_items       — user duyệt → tạo task thật từ action items

Tra cứu:
- find_project / find_task / find_user
- search_projects / search_tasks

NGUYÊN TẮC:
1. Câu hỏi khớp tool → gọi tool, rồi tổng hợp câu trả lời tiếng Việt tự nhiên.
2. Câu hỏi suy luận thuần → trả lời trực tiếp, KHÔNG gọi tool.
3. Không bịa số liệu. 0 task → nói "không có" rõ ràng.
4. Danh sách > 5 task: nhóm theo dự án, priority HIGH/URGENT lên đầu.
5. send_follow_up: CHỈ gọi khi (a) user yêu cầu "nhắc/ping/hỏi", HOẶC (b) một task vừa detect là overdue/stale và người dùng đồng ý ping. KHÔNG auto-ping trong câu trả lời observational thường.
6. post_blocker: khi người dùng mô tả đang kẹt. Yêu cầu taskId — nếu chưa có, hỏi lại hoặc gọi find_task trước.
7. update_task_status: KHÔNG tự ý đổi status nếu user chỉ hỏi, chỉ đổi khi user ra lệnh rõ ("đánh dấu xong", "chuyển sang review"…).
8. recall_memory: GỌI khi câu hỏi có từ gợi ý kế thừa ("lần trước", "vụ đó", "hôm qua bạn nói", "tiếp tục với", "quay lại task X"). KHÔNG gọi cho câu hỏi độc lập đã có dữ liệu tươi.
9. generate_weekly_report: dùng cho "báo cáo tuần", CEO hỏi xu hướng. Với digest đơn thuần hôm nay → dùng generate_daily_digest.
10. MEETING FLOW (quan trọng): khi input có dấu hiệu là transcript họp/biên bản/notes họp (xuất hiện ≥ 2 dấu hiệu sau: "biên bản", "PM:", "Dev:", "[tên]:", nhiều lượt đối thoại, từ "họp/meeting/standup", danh sách quyết định/action items) → **BẮT BUỘC** dùng **ingest_meeting** duy nhất, **KHÔNG BAO GIỜ** tự gọi create_action_item / post_blocker / update_task_status để xử lý nội dung transcript. Lý do: meeting items phải qua bước DRAFT + approve để PM kiểm soát. Sau ingest, trình bày tóm tắt + items + hỏi user "OK approve items nào?". Chỉ gọi approve_meeting_items khi user NÓI RÕ "approve / duyệt / OK tạo task cho items X, Y".
11. approve_meeting_items: chỉ gọi sau khi user xác nhận. Nếu meeting không có projectId và user chưa nói project nào → hỏi lại trước khi approve.
12. Planning / đề xuất tiếp theo: user hỏi "nên làm gì tiếp", "priority", "next actions" → gọi get_project_snapshot + list_overdue_tasks + list_blocked_tasks, rồi compose 3-5 gợi ý cụ thể (không quá 1 câu / gợi ý). KHÔNG trực tiếp auto-create task.
13. Chế độ executive (khi user là CEO/leadership — detect qua chức danh trong tin, hoặc tiền tố "CEO:", "Sếp:"): giọng ngắn gọn, KPI-focused, không chi tiết kỹ thuật, luôn có 1 số liệu cụ thể + 1 rủi ro + 1 đề xuất.
14. Ngoài phạm vi (Gmail send, audio transcription...) → thành thật: "Sprint sau sẽ có".
15. Giọng ngắn gọn, data-first, không chào hỏi dài dòng.`;

export async function runAgent(userMessage: string, ctx: AgentContext = {}): Promise<string> {
  // Sprint 4: pull relevant past summaries so the orchestrator has context
  // for follow-on questions ("lần trước bảo sao rồi?").
  const memoryBlock = await recallMemoryContext(userMessage, ctx);
  const systemPrompt = memoryBlock
    ? `${SYSTEM_PROMPT_BASE}\n\n${memoryBlock}`
    : SYSTEM_PROMPT_BASE;

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  const toolsUsed = new Set<string>();
  const projectIds = new Set<number>();
  const taskIds = new Set<number>();
  let finalReply = "";

  for (let step = 0; step < config.orchestrator.maxToolSteps; step++) {
    const resp = await chat(messages, toolCatalog());

    if (!resp.tool_calls?.length) {
      finalReply = resp.content ?? "(trả lời rỗng)";
      break;
    }

    messages.push({
      role: "assistant",
      content: resp.content ?? "",
      tool_calls: resp.tool_calls,
    });

    for (const call of resp.tool_calls) {
      toolsUsed.add(call.function.name);
      const { result, parsedArgs } = await invokeTool(call.function.name, call.function.arguments, ctx);
      collectIds(call.function.name, parsedArgs, result, projectIds, taskIds);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: JSON.stringify(result),
      });
    }
  }

  if (!finalReply) {
    finalReply = "Xin lỗi, mình chưa tổng hợp được câu trả lời (vượt giới hạn số bước).";
  }

  // Sprint 4: summarize + persist this run to memory. Fire-and-forget — if
  // the memory store is down, the user still gets their reply.
  void summarizeAndStore({
    userText: userMessage,
    replyText: finalReply,
    toolsUsed: Array.from(toolsUsed),
    projectIds: Array.from(projectIds),
    taskIds: Array.from(taskIds),
    ctx,
  });

  return finalReply;
}

async function invokeTool(
  name: string,
  argsRaw: string,
  ctx: AgentContext,
): Promise<{ result: unknown; parsedArgs: any }> {
  const tool = toolsByName.get(name);
  let parsedArgs: any = {};
  try {
    parsedArgs = argsRaw ? JSON.parse(argsRaw) : {};
  } catch {
    parsedArgs = { _raw: argsRaw };
  }

  if (!tool) {
    void audit({ tool: name, argsJson: parsedArgs, errorMessage: `Unknown tool`, ctx, durationMs: 0 });
    return { result: { error: `Unknown tool: ${name}` }, parsedArgs };
  }

  const start = Date.now();
  try {
    const result = await tool.handler(parsedArgs);
    void audit({ tool: name, argsJson: parsedArgs, resultJson: summarize(result), ctx, durationMs: Date.now() - start });
    return { result, parsedArgs };
  } catch (err: any) {
    const message = err?.message || String(err);
    void audit({ tool: name, argsJson: parsedArgs, errorMessage: message, ctx, durationMs: Date.now() - start });
    return { result: { error: message }, parsedArgs };
  }
}

// Best-effort: pick up project / task IDs referenced in this turn so memory
// can be filtered later by {projectId, taskId}.
function collectIds(
  toolName: string,
  args: any,
  result: any,
  projectIds: Set<number>,
  taskIds: Set<number>,
): void {
  const add = (val: unknown, target: Set<number>) => {
    if (typeof val === "number" && Number.isInteger(val) && val > 0) target.add(val);
  };
  add(args?.projectId, projectIds);
  add(args?.taskId, taskIds);
  // Some tools return the id in their payload.
  if (result && typeof result === "object") {
    const r = result as any;
    add(r?.taskId, taskIds);
    if (Array.isArray(r?.tasks)) {
      for (const t of r.tasks) {
        add(t?.id, taskIds);
        add(t?.projectId, projectIds);
        add(t?.project?.id, projectIds);
      }
    }
  }
}

// Fire-and-forget audit; never block the agent on audit failures.
async function audit(entry: {
  tool: string;
  argsJson: unknown;
  resultJson?: unknown;
  errorMessage?: string;
  durationMs: number;
  ctx: AgentContext;
}) {
  try {
    await bbPm.postAudit({
      tool: entry.tool,
      argsJson: entry.argsJson,
      resultJson: entry.resultJson,
      errorMessage: entry.errorMessage,
      durationMs: entry.durationMs,
      correlationId: entry.ctx.correlationId,
      source: entry.ctx.source ?? "chat",
    });
  } catch (err: any) {
    console.warn("[bb-pm-tools] audit post failed:", err?.message || err);
  }
}

// Keep audit.resultJson small — store counts, not full task lists.
function summarize(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const r = result as any;
  if (Array.isArray(r)) return { length: r.length };
  const summary: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (Array.isArray(v)) summary[k] = { length: v.length };
    else if (v && typeof v === "object") summary[k] = { keys: Object.keys(v).length };
    else summary[k] = v;
  }
  return summary;
}
