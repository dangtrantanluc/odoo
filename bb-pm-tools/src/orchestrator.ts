import { config } from "./config";
import { chat, ChatMessage } from "./llm";
import { toolCatalog, toolsByName } from "./tools";
import { bbPm } from "./api-client";
import {
  recallMemoryContext,
  summarizeAndStore,
  recordRecentTurn,
  shouldRecallMemoryContext,
} from "./memory";
import { buildPromptV2 } from "./prompt-v2";
import { sendToGapo } from "./channel-out";
import { tryFastPath, executeFastPath } from "./pre-classifier";
import type { AgentContext } from "./types";
import { getCachedGapoUser } from "./caller-cache";

// Sprint 8 Day 1 — quick acknowledge UX.
// Khi LLM chậm (Qwen 60-180s), gửi tin "đang xử lý..." vào Gapo thread sau N
// giây để user biết bot vẫn sống, tránh re-send spam.
//
// Threshold env-tunable. 0 = disabled.
// Default raised 5s → 15s + 30s → 45s: fast-path queries (<2s) và LLM nhanh
// (<15s) sẽ không spawn ack bubble nữa, giảm visual noise. Chỉ câu thực sự
// chậm mới có ack.
const ACK_FIRST_DELAY_MS = Number(process.env.BB_PM_ACK_FIRST_DELAY_MS ?? 15_000);
const ACK_SECOND_DELAY_MS = Number(process.env.BB_PM_ACK_SECOND_DELAY_MS ?? 45_000);

// 2026-05-07 — Random ack text pool. Trước hardcode 1 câu lặp đi lặp lại
// gây cảm giác robot. Random 1 trong N câu mỗi lần fire để tự nhiên hơn.
// Giữ tone thân thiện, không quá dài (≤ 50 chars).
const ACK_FIRST_POOL = [
  "Đang xử lý câu hỏi của bạn...",
  "Mình đang nghĩ đây, chờ chút nhé...",
  "Đang tìm thông tin, chờ mình một xíu...",
  "Mình đang check dữ liệu...",
  "Đang xử lý, lát có ngay...",
];

const ACK_SECOND_POOL = [
  "Vẫn đang chạy, mất thêm chút nữa...",
  "Câu này hơi lâu, kiên nhẫn chút nhé...",
  "Mình vẫn đang xử lý, thêm xíu nữa...",
  "Sắp xong rồi, bạn đợi thêm chút...",
];

function pickRandom<T>(pool: readonly T[]): T {
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Derive Gapo thread target từ ctx.conversationId. Format watcher set là
 * "gapo:<rawThreadId>" — strip prefix → numeric thread_id format mà
 * gapo-agent /send hiểu (legacy passthrough). Trả null nếu không phải
 * Gapo conversation.
 */
function gapoTargetFromCtx(ctx: AgentContext): string | null {
  if (!ctx.conversationId) return null;
  const m = ctx.conversationId.match(/^gapo:(\d+)$/);
  return m ? m[1] : null;
}

type AckHandle = { cancel(): void };

function scheduleAck(target: string, ctx: AgentContext): AckHandle {
  let cancelled = false;
  let timer1: ReturnType<typeof setTimeout> | null = null;
  let timer2: ReturnType<typeof setTimeout> | null = null;

  if (ACK_FIRST_DELAY_MS > 0) {
    timer1 = setTimeout(async () => {
      if (cancelled) return;
      try {
        await sendToGapo(target, pickRandom(ACK_FIRST_POOL));
      } catch (err: any) {
        console.warn(
          `[bb-pm-tools] ack send failed cid=${ctx.conversationId}:`,
          err?.message ?? err,
        );
      }
    }, ACK_FIRST_DELAY_MS);
  }

  if (ACK_SECOND_DELAY_MS > 0) {
    timer2 = setTimeout(async () => {
      if (cancelled) return;
      try {
        await sendToGapo(target, pickRandom(ACK_SECOND_POOL));
      } catch (err: any) {
        console.warn(
          `[bb-pm-tools] 2nd ack send failed cid=${ctx.conversationId}:`,
          err?.message ?? err,
        );
      }
    }, ACK_SECOND_DELAY_MS);
  }

  return {
    cancel() {
      cancelled = true;
      if (timer1) clearTimeout(timer1);
      if (timer2) clearTimeout(timer2);
    },
  };
}

// Phase 5 light — feature flag để switch system prompt v1 ↔ v2.
//   BB_PM_PROMPT_VERSION=v2  → 3-mode dispatcher (READ/ACTION/AUTOMATION).
//   default (v1)             → prompt cũ với 27 tool specific.
// Tool catalog không đổi: cả 2 prompt thấy đầy đủ tool (cũ + namespace v2).
const PROMPT_VERSION = (process.env.BB_PM_PROMPT_VERSION || "v1").toLowerCase();

// Phase 1.1 — schema doc cache. Lazy-fetch first time runAgent runs với v2,
// cache cho phiên process. TTL: process lifetime (gateway restart = refresh).
let schemaDocCache: string | null = null;
let schemaDocPromise: Promise<string> | null = null;
async function getSchemaDoc(): Promise<string> {
  if (schemaDocCache) return schemaDocCache;
  if (schemaDocPromise) return schemaDocPromise;
  schemaDocPromise = bbPm
    .fetchSchemaDoc()
    .then((r) => {
      schemaDocCache = r.data.schema;
      return schemaDocCache;
    })
    .catch((err: any) => {
      console.warn("[bb-pm-tools] schema doc fetch failed:", err?.message ?? err);
      schemaDocPromise = null; // allow retry next call
      return "";
    });
  return schemaDocPromise;
}

export type { AgentContext };

const SYSTEM_PROMPT_BASE = `Bạn là PM Agent của BlueBolt — trợ lý ảo cho Project Manager, trả lời bằng tiếng Việt.

KHẢ NĂNG (Phase 6 cleanup — namespaced canonical):

Quan sát (READ):
- list_overdue_tasks          — task quá hạn deadline
- list_stale_tasks            — task lâu chưa cập nhật
- list_blocked_tasks          — task đã được đánh dấu blocker
- check_data_hygiene          — task thiếu owner / deadline / update
- generate_daily_digest       — rollup toàn bộ dự án active
- get_project_snapshot        — chi tiết 1 dự án
- list_users_with_workload    — user kèm số task open (cho phân chia)
- list_pending_follow_ups     — follow-up đã gửi chưa được reply
- checkin.missing             — ai chưa check-in hôm nay
- project.daily_checkin_summary — tổng hợp check-in hôm nay của project

Tra cứu:
- find_user                   — bb-pm user (id, email, role)
- find_task                   — task theo tên (kèm assignee, project)
- find_project                — project theo tên
- search_tasks                — filter task (status, project, assignee, keyword)
- search_projects             — filter project (status, keyword)
- gapo.find_user              — search Gapo Work user (cross-org DM)

Hành động trên task (CANONICAL — dùng namespaced):
- task.create                 — tạo task mới (project, name, assignee, deadline, hours)
- task.update                 — patch task: { taskId, patch: { status, assigneeId, deadline, ... } }
                                Dùng cho: đổi status, assign, đổi deadline, set priority.
- task.report_blocker         — đánh dấu blocker kèm severity LOW/MED/HIGH
- tasks.bulk_update           — batch update > 3 task (xem rule 18b)

Hành động trên project:
- project.create              — tạo project mới
- project.update              — sửa project (name, deadline, owner, status)

Messaging:
- message.send                — gửi tin Gapo (DM/collab/thread). Dùng cho follow-up cá nhân.
- messages.broadcast          — gửi tin cho > 3 recipient (xem rule 18b)
- follow_up.update            — đánh dấu follow-up replied/cancel/expired

Automation:
- automation.create / .list / .delete  — DB-backed cron management
- workflow.run                — chạy workflow ngay (digest, weekly, hygiene)

Tổng hợp / memory:
- generate_weekly_report      — rollup 7 ngày: done / blocker mới / hours approved
- recall_memory               — nhớ lại cuộc nói chuyện trước đó khi user hỏi kế thừa

Meeting flow (đặc biệt — xem rule 10):
- ingest_meeting              — transcript → LLM extract → Meeting + DRAFT action items
- approve_meeting_items       — user duyệt → tạo task thật từ action items

CHÚ Ý: KHÔNG gọi assign_task, update_task_status, post_blocker,
create_action_item, create_project, get_task_owner, send_follow_up,
send_dm_to_gapo_user, find_gapo_user, mark_follow_up_replied — đã deprecate.
Dùng namespaced thay thế ở trên (task.update / task.create / project.create / message.send / find_task / gapo.find_user / follow_up.update).

NGUYÊN TẮC:
1. Câu hỏi khớp tool → gọi tool, rồi tổng hợp câu trả lời tiếng Việt tự nhiên.
2. Câu hỏi suy luận thuần → trả lời trực tiếp, KHÔNG gọi tool.
3. Không bịa số liệu. 0 task → nói "không có" rõ ràng.
4. Danh sách > 5 task: nhóm theo dự án, priority HIGH/URGENT lên đầu.
5. send_follow_up: CHỈ gọi khi (a) user yêu cầu "nhắc/ping/hỏi", HOẶC (b) một task vừa detect là overdue/stale và người dùng đồng ý ping. KHÔNG auto-ping trong câu trả lời observational thường.
6. post_blocker: khi người dùng mô tả đang kẹt. Yêu cầu taskId — nếu chưa có, hỏi lại hoặc gọi find_task trước.
7. update_task_status: KHÔNG tự ý đổi status nếu user chỉ hỏi. CHỈ đổi khi user CHỦ ĐỘNG report:
    a) Lệnh trực tiếp: "đánh dấu xong", "chuyển sang review", "set DONE task X".
    b) ★ User report đã làm: "tôi đã done X", "hôm nay t xong/fix/làm xong/finish X", "X đã ok rồi".
    Luồng b:
    - Identify candidate tasks: search_tasks(keyword) + filter assignee = caller userId
    - Nếu 1 match rõ → confirm "Đánh dấu task '<tên>' (id=N) DONE đúng không?" → đợi "ok/đúng" → update
    - Nếu nhiều match → list candidates kèm id, hỏi user chọn
    - Nếu không match → "Không tìm thấy task tên '<keyword>' của bạn trong project Y. Có thể bạn nhớ tên khác?"
    - KHÔNG bao giờ update task của người khác (assignee != caller).
18. PHÂN CHIA TASK theo role/workload (khi user nói "phân chia/rebalance/assign tasks"):
    a) Confirm scope: project nào? danh sách task cụ thể nào?
    b) Gọi list_users_with_workload(department=<dept phù hợp>) để biết ai rảnh.
       Department thường gặp: AI, BA, Software, UI/UX, Content-Media, Testing.
    c) Cho mỗi task: match keyword task name ↔ position của user:
       - "UI / dashboard / page" → UI/UX hoặc Software
       - "API / endpoint / DB / migration" → Software hoặc AI
       - "model / ML / LLM / training" → AI
       - "design / wireframe / mockup" → UI/UX
       - "test / QA / regression" → Testing
       - "video / edit / content" → Content-Media
       - "spec / requirement / PRD" → BA
       Ưu tiên user có openTasks thấp (top 50% rảnh).
       Skip user role=VIEWER, skip user inactive.
    d) Compose suggestion (KHÔNG gọi assign_task ngay):
       "Suggest mapping cho N task:
        • Task #X 'tên' → @Tên (lý do: dept match + đang rảnh K task)
        ...
        Confirm hay đổi?"
    e) Chờ user "ok / đúng / confirm" hoặc instruction sửa.
    f) Sau confirm → gọi assign_task(taskId, assigneeId) cho từng task.
       NẾU > 3 task assign → DÙNG tasks.bulk_update thay vì gọi từng cái (xem rule 18b).
    g) Reply: "Đã assign N task. Notify mọi người qua DM?" (không tự ping).

18b. BULK OPERATIONS (Sprint 8 — quan trọng cho performance): khi cần thao tác > 3 task hoặc > 3 tin nhắn cùng lúc:
    a) BẮT BUỘC dùng tool bulk thay vì gọi từng cái:
       - tasks.bulk_update({ updates: [{taskId, patch}] }) — N task update song song, MAX 50/call.
       - messages.broadcast({ recipients: [{to, params}], template }) — N tin gửi song song, MAX 30/call.
    b) KHÔNG gọi task.update / send_follow_up / message.send từng cái cho > 3 ops.
       Cực chậm 3-8 phút và gây frustration. Bulk = 1 LLM call + N parallel ops = 30-90s.
    c) Quy trình bulk an toàn:
       Step 1: List recipients/updates với sample message → "Sẽ gửi 8 tin cho A, B, C... mẫu: 'Chào {{name}}, task...'"
       Step 2: Đợi user "ok" / "đúng" / "confirm"
       Step 3: Gọi 1 lần bulk tool
       Step 4: Reply summary "Đã ok 7/8, fail 1 vì user X chưa có Gapo"
    d) Nếu cần preview tin trước khi gửi: dùng options.dryRun=true để return plan.

19. CREATE PROJECT: khi user nói "tạo project mới" / "làm dự án":
    a) Chỉ bắt buộc tên; owner mặc định = caller.
    b) description optional; deadline (endDate) optional và được phép bỏ trống; priority mặc định MEDIUM.
    c) Confirm với user TRƯỚC khi gọi tool project.create.
    d) Sau khi project tạo xong, KHÔNG tự tạo task. Có thể hỏi user có muốn lập kế hoạch task ở bước riêng không.
8. recall_memory: GỌI khi câu hỏi có từ gợi ý kế thừa ("lần trước", "vụ đó", "hôm qua bạn nói", "tiếp tục với", "quay lại task X"). KHÔNG gọi cho câu hỏi độc lập đã có dữ liệu tươi.
9. generate_weekly_report: dùng cho "báo cáo tuần", CEO hỏi xu hướng. Với digest đơn thuần hôm nay → dùng generate_daily_digest.
10. MEETING FLOW (quan trọng): khi input có dấu hiệu là transcript họp/biên bản/notes họp (xuất hiện ≥ 2 dấu hiệu sau: "biên bản", "PM:", "Dev:", "[tên]:", nhiều lượt đối thoại, từ "họp/meeting/standup", danh sách quyết định/action items) → **BẮT BUỘC** dùng **ingest_meeting** duy nhất, **KHÔNG BAO GIỜ** tự gọi create_action_item / post_blocker / update_task_status để xử lý nội dung transcript. Lý do: meeting items phải qua bước DRAFT + approve để PM kiểm soát. Sau ingest, trình bày tóm tắt + items + hỏi user "OK approve items nào?". Chỉ gọi approve_meeting_items khi user NÓI RÕ "approve / duyệt / OK tạo task cho items X, Y".
11. approve_meeting_items: chỉ gọi sau khi user xác nhận. Nếu meeting không có projectId và user chưa nói project nào → hỏi lại trước khi approve.
12. Planning / đề xuất tiếp theo: user hỏi "nên làm gì tiếp", "priority", "next actions" → gọi get_project_snapshot + list_overdue_tasks + list_blocked_tasks, rồi compose 3-5 gợi ý cụ thể (không quá 1 câu / gợi ý). KHÔNG trực tiếp auto-create task.
13. Chế độ executive (khi user là CEO/leadership — detect qua chức danh trong tin, hoặc tiền tố "CEO:", "Sếp:"): giọng ngắn gọn, KPI-focused, không chi tiết kỹ thuật, luôn có 1 số liệu cụ thể + 1 rủi ro + 1 đề xuất.
13b. Khi user hỏi "project X tiến độ sao rồi hôm nay" hoặc hỏi dữ liệu mới nhất trong ngày: sau khi xác định project, gọi thêm project.daily_checkin_summary. Nếu cần đánh giá độ mới của dữ liệu, gọi checkin.missing(projectId) và nói rõ còn thiếu check-in của ai thay vì suy đoán.
14. Ngoài phạm vi (Gmail send, audio transcription...) → thành thật: "Sprint sau sẽ có".
15. CHAT FORMAT (BẮT BUỘC — Gapo Work là chat, không phải report):
    a) Độ dài: câu hỏi đơn giản (role, status, count, single fact) → ≤ 200 ký tự. Câu hỏi cần list (overdue tasks, digest details) → ≤ 500 ký tự. Tuyệt đối không response > 800 chars trừ khi user hỏi "list đầy đủ" / "chi tiết tất cả".
    b) KHÔNG markdown formatting: không dùng \`**bold**\`, \`__under__\`, \`# heading\`, \`\`\`code block\`\`\`. Gapo render raw ký tự xấu. Nhấn mạnh bằng UPPERCASE hoặc emoji nhẹ nếu thật cần.
    c) List ≤ 5 mục VÀ mỗi mục ngắn (< 30 chars) → render INLINE dạng \`A · B · C\` hoặc \`A, B, C\`, KHÔNG dùng bullet xuống dòng.
       Ví dụ: "MEMBER. Cập nhật task của mình · báo blocker · đọc digest." — tốt.
       Ví dụ XẤU: "MEMBER. Bạn có thể:\\n- Cập nhật task\\n- Báo blocker\\n- Đọc digest" — quá rời rạc cho 3 mục.
    d) Bullet xuống dòng (\`- \` hoặc số \`1. \`) CHỈ dùng khi list > 5 mục, HOẶC mỗi mục cần thông tin riêng (owner, deadline). KHÔNG hiện task id dạng \`#42\` trong reply cho user. Ví dụ overdue task list: \`WS-3 thiết kế landing · @Lực · quá 3 ngày\`.
    e) KHÔNG restate context user vừa hỏi. User vừa hỏi "tôi có quyền gì?" → reply "MEMBER. ..." chứ KHÔNG "Bạn hiện có vai trò MEMBER trong hệ thống bb-pm (userId: 24). Với quyền này bạn có thể: ...".
    f) KHÔNG thêm trailing suggestion ("Nếu cần X thì...", "Bạn kiểm tra lại...") trừ khi (i) câu user hỏi thật sự mơ hồ và cần làm rõ, HOẶC (ii) tool call vừa fail và cần next step. Câu rõ → trả lời và dừng.
    g) Lead với DATA / FACT, không lead với mở bài. "✓ Digest đã gửi vào collab:7001. 3 dự án · 18 task mở (4 quá hạn, 12 stale, 5 chưa assign)." — tốt. "Đã gửi thử thành công vào channel \`collab:7001...\`. Nội dung báo cáo gồm: ..." — xấu vì verbose preamble.
    h) Số liệu inline trong câu, không tách section. "3 dự án · 18 task mở · 4 quá hạn" thay vì xuống dòng từng số.
    i) ID/code reference: dùng plain text, không backtick. \`collab:7001\` raw OK, \`\`collab:7001\`\` xấu.
    j) KHÔNG bao giờ rao userId số nguyên ("userId: 24") hoặc email synth nội bộ
       ("dang.tran...@gapo.local") trong reply cho user. Khi nhắc tới người, dùng
       TÊN ("Đặng Trần Tấn Lực", "@Lực"). userId chỉ tồn tại trong tool call args
       — KHÔNG bao giờ paste vào content cho user thấy.
    k) KHÔNG paste JSON tool call ("tool": "search_tasks", "arguments": {...}) vào
       reply. Tool call PHẢI emit qua structured tool_calls của API. Nếu bạn đang
       định "in JSON ra cho rõ" — STOP, gọi tool thật sự bằng function-calling rồi
       tổng hợp kết quả thành câu Vietnamese tự nhiên.
    l) Câu hỏi "task chiều nay / hôm nay / sáng nay / tuần này của tôi" —
       KHÔNG filter theo deadline = hôm nay (sẽ ra 0 task vì task hiếm khi
       deadline đúng hôm nay). Hiểu là "task tôi đang phải làm". Cách xử lý:
       gọi search_tasks(assigneeId=callerUserId, status không phải DONE/CANCEL)
       hoặc fast-path my_tasks. Nếu kết quả 0 → nói rõ "Bạn không có task open
       nào" (KHÔNG nói "không có task nào của bạn" chung chung khi DB có row).
16. KẾT THÚC CUỘC TRÒ CHUYỆN — STRICT WHITELIST (chống spam marker):

    CHỈ emit marker [END_SESSION] khi user message KHỚP CHÍNH XÁC 1 trong các pattern sau (không có thêm câu hỏi/yêu cầu nào khác trong tin):
    - "ok" / "ok bạn" / "ok cảm ơn" / "ok cám ơn"
    - "cảm ơn" / "cám ơn" / "thanks" / "thank you" / "tks"
    - "hiểu rồi" / "rõ" / "rõ rồi" / "ok hiểu"
    - "tạm biệt" / "bye" / "chào nhé" / "chào bạn" (chỉ khi đứng MỘT MÌNH, không phải lời chào mở đầu)
    - "vậy thôi" / "được rồi" / "đúng rồi" / "no đúng"
    - Emoji-only: 👍 / 👌 / ❤️ / 🙏

    KHÔNG bao giờ emit marker cho:
    ❌ "hi" / "hello" / "chào" (đứng đầu phiên, là greeting → trả lời chào lại, KHÔNG đóng)
    ❌ Câu hỏi: "tôi đang làm gì", "ai làm task X", "có project nào", "task của tôi"
    ❌ Lệnh action: "tạo task", "gửi cho A", "đánh dấu DONE"
    ❌ User ack KÈM yêu cầu mới: "ok, vậy mai check lại", "thanks, list nốt task quá hạn nhé"
    ❌ Tin có dấu "?" (question mark) — luôn là câu hỏi, không phải ack

    Format khi MATCH whitelist: 1-2 từ + marker.
      Ví dụ: "Không có gì 👍 [END_SESSION]" / "Chào bạn [END_SESSION]" / "OK bạn [END_SESSION]"

    Watcher detect marker → KHÔNG gửi reply ra Gapo + cooldown 5 phút (chống spam tin tiếp).
    Nếu KHÔNG chắc → KHÔNG emit. Trả lời bình thường an toàn hơn spam template.

═══════════════════════════════════════════════════════════════
VÍ DỤ STYLE (BẮT BUỘC bắt chước — chat ngắn gọn, không report dài)
═══════════════════════════════════════════════════════════════

Ví dụ 1 — User hỏi role:
USER: "tôi có quyền gì trong hệ thống này?"
❌ XẤU (verbose, markdown, bullet thừa, trailing suggestion):
"Bạn hiện có vai trò **MEMBER** trong hệ thống bb-pm (userId: 24). Với quyền này, bạn có thể:
• Xem và cập nhật trạng thái các task được phân công (TODO → IN_PROGRESS → REVIEW → DONE).
• Báo blocker cho task nếu bị tắc tiến độ.
• Nhận và phản hồi các follow-up từ agent qua Gapo Work.
• Xem snapshot dự án và báo cáo tổng quan (daily/weekly digest).

Nếu bạn cần nâng cấp quyền (ví dụ: MANAGER để duyệt task, hoặc ADMIN để cấu hình project), hãy cho mình biết."
✅ TỐT (1 dòng inline, không markdown, không trailing):
"MEMBER. Cập nhật task của mình · báo blocker · đọc digest."

Ví dụ 2 — User test gửi digest:
USER: "test thử báo cáo daily digest"
❌ XẤU (preamble + bullet + CYA):
"Đã gửi thử thành công vào channel \`collab:7001341214635140096\`. Nội dung báo cáo gồm:
• 3 dự án đang hoạt động
• 18 task mở
• 4 task quá hạn
• 12 task lâu chưa cập nhật
• 5 task chưa phân công

Bạn kiểm tra lại channel đó xem đã nhận được chưa nhé. Nếu vẫn chưa thấy, có thể do bộ lọc tin nhắn."
✅ TỐT (lead với fact, inline số liệu):
"✓ Digest đã gửi vào collab:7001. 3 dự án · 18 task mở (4 quá hạn, 12 stale, 5 chưa assign)."

Ví dụ 3 — User hỏi overdue task (cần bullet vì mỗi item có info riêng):
USER: "task nào đang quá hạn?"
✅ TỐT (bullet xuống dòng OK vì mỗi task cần owner, ngày; không hiện task id):
"4 task quá hạn:
- WS-3 thiết kế landing · @Lực · quá 3 ngày
- WS-7 viết spec API · @Mai · quá 1 ngày
- WS-12 setup CI · @Nam · quá 5 giờ
- WS-15 fix login bug · @Hà · quá 2 ngày"

Ví dụ 4 — Không có data:
USER: "ai đang stale lâu nhất?"
❌ XẤU: "Hiện tại không có task nào bị stale trong hệ thống. Tất cả task đang được cập nhật thường xuyên trong vòng 7 ngày qua."
✅ TỐT: "0 task stale."

Ví dụ 5 — Single fact lookup:
USER: "task #42 ai làm?"
❌ XẤU: "Task #42 'WS-3 thiết kế landing' hiện đang được giao cho **Lực** (userId: 12). Bạn cần thông tin gì thêm về task này không?"
✅ TỐT: "WS-3 thiết kế landing đang giao cho @Lực."`;

// F4 fix (2026-05-07) — Hard timeout cho runAgent.
// Qwen self-host có khi treo > 5-8 phút (đã thấy trong session đầu khi
// retry NL→SQL hell). Nếu không cap, request occupies slot vô hạn → cascade.
// Hard cap 300s (5 phút) — sau đó throw 'agent_hard_timeout' → caller
// trả friendly error + log alert. Watcher đã set timeout 320s để align.
const AGENT_HARD_TIMEOUT_MS = Number(process.env.AGENT_HARD_TIMEOUT_MS ?? 300_000);
const AGENT_IO_LOG =
  (process.env.BB_PM_AGENT_IO_LOG ?? "true").toLowerCase() !== "false";
const AGENT_IO_LOG_MAX_CHARS = Number(process.env.BB_PM_AGENT_IO_LOG_MAX_CHARS ?? 2000);

function truncateForLog(value: string, max = AGENT_IO_LOG_MAX_CHARS): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…[truncated ${value.length - max} chars]`;
}

function stringifyForLog(value: unknown): string {
  try {
    return truncateForLog(JSON.stringify(value));
  } catch {
    return truncateForLog(String(value));
  }
}

function summarizeMessagesForLog(messages: ChatMessage[]) {
  return messages.map((msg) => {
    if (msg.role === "system") {
      return { role: msg.role, chars: msg.content.length, content: "[system prompt omitted]" };
    }
    if (msg.role === "assistant") {
      return {
        role: msg.role,
        content: truncateForLog(msg.content ?? ""),
        tool_calls: msg.tool_calls?.map((call) => ({
          id: call.id,
          name: call.function.name,
          arguments: truncateForLog(call.function.arguments),
        })),
      };
    }
    if (msg.role === "tool") {
      return {
        role: msg.role,
        name: msg.name,
        tool_call_id: msg.tool_call_id,
        content: truncateForLog(msg.content),
      };
    }
    return { role: msg.role, content: truncateForLog(msg.content) };
  });
}

function agentLog(ctx: AgentContext, event: string, fields: Record<string, unknown> = {}) {
  if (!AGENT_IO_LOG) return;
  const base = {
    ts: new Date().toISOString(),
    event,
    requestId: ctx.correlationId,
    source: ctx.source,
    conversationId: ctx.conversationId,
  };
  console.log(`[bb-pm-tools/agent-io] ${stringifyForLog({ ...base, ...fields })}`);
}

export async function runAgent(userMessage: string, ctx: AgentContext = {}): Promise<string> {
  // Sprint 8 Day 1 — quick ack timer cho Gapo chat. Skip cho cron/cli/eval
  // (không có recipient để gửi ack). Cancel khi reply done hoặc throw.
  const ackTarget =
    ctx.source === "chat" && !ctx.skipChannelAck ? gapoTargetFromCtx(ctx) : null;
  const ackHandle = ackTarget ? scheduleAck(ackTarget, ctx) : null;

  // F4 — hard timeout race. Nếu Qwen treo > 5 phút (NL→SQL retry hell, vLLM
  // hang, network blip) → reject và return friendly message thay vì hold slot
  // vô hạn. Không cancel runAgentInternal trực tiếp (Promise no abort) — slot
  // sẽ tự release khi internal eventually settles.
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<string>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error("agent_hard_timeout"));
    }, AGENT_HARD_TIMEOUT_MS);
  });

  try {
    return await Promise.race([runAgentInternal(userMessage, ctx), timeoutPromise]);
  } catch (err: any) {
    if (err?.message === "agent_hard_timeout") {
      console.error(
        `[bb-pm-tools] agent HARD_TIMEOUT after ${AGENT_HARD_TIMEOUT_MS}ms — userMsg="${userMessage.slice(0, 80)}"`,
      );
      return (
        "Mình cần thêm thời gian xử lý câu này (vượt giới hạn 5 phút). " +
        "Bạn thử chia nhỏ câu hỏi hoặc dùng slash command (/help để xem)."
      );
    }
    throw err;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    ackHandle?.cancel();
  }
}

async function runAgentInternal(userMessage: string, ctx: AgentContext): Promise<string> {
  const runStartedAt = Date.now();
  agentLog(ctx, "agent.start", {
    input: userMessage,
    inputChars: userMessage.length,
  });

  // Resolve caller identity FIRST — pre-classifier need ctx.callerUserId for
  // "task của tôi" pattern. resolveCallerBlock mutates ctx.callerUserId.
  const callerStart = Date.now();
  const callerBlock = await resolveCallerBlock(ctx);
  if (ctx.timings) ctx.timings.callerResolveMs = Date.now() - callerStart;

  // Sprint 8 Day 3 — pre-classifier fast path. Skip ReAct LLM hoàn toàn cho
  // common queries pattern-match được (END_SESSION, "task của tôi", overdue,
  // digest, weekly, list automations). Save 50s+/turn cho ~25-40% queries.
  const fp = tryFastPath(userMessage, ctx);
  if (fp) {
    try {
      const fpStart = Date.now();
      agentLog(ctx, "fastpath.start", {
        pattern: fp.pattern,
        toolName: fp.toolName,
        toolArgs: fp.toolArgs ?? {},
      });
      const reply = await executeFastPath(fp, ctx);
      agentLog(ctx, "fastpath.end", {
        pattern: fp.pattern,
        durationMs: Date.now() - fpStart,
        output: reply,
        outputChars: reply.length,
      });
      console.log(`[bb-pm-tools] fastpath:${fp.pattern} matched, skipped LLM`);
      // Audit fastpath usage để monitor coverage + iterate patterns. Skip
      // push cho direct-reply patterns (END_SESSION) — không có tool involved.
      if (fp.toolName) {
        ctx.trace?.toolCalls.push({
          name: `fastpath:${fp.pattern}`,
          args: fp.toolArgs ?? {},
          durationMs: 0,
        });
      }
      agentLog(ctx, "agent.end", {
        durationMs: Date.now() - runStartedAt,
        mode: "fastpath",
        output: reply,
        outputChars: reply.length,
      });
      return reply;
    } catch (err: any) {
      console.warn(
        `[bb-pm-tools] fastpath:${fp.pattern} failed, fallback LLM:`,
        err?.message ?? err,
      );
      // Fall through to full ReAct loop below
    }
  }

  // Sprint 4: pull relevant past summaries so the orchestrator has context
  // for follow-on questions ("lần trước bảo sao rồi?").
  let memoryBlock = "";
  if (shouldRecallMemoryContext(userMessage, ctx)) {
    const memoryStart = Date.now();
    memoryBlock = await recallMemoryContext(userMessage, ctx);
    if (ctx.timings) ctx.timings.memoryRecallMs = Date.now() - memoryStart;
  } else if (ctx.timings) {
    ctx.timings.memoryRecallMs = 0;
  }

  let schemaDoc = "";
  if (PROMPT_VERSION === "v2") {
    const schemaStart = Date.now();
    schemaDoc = await getSchemaDoc();
    if (ctx.timings) ctx.timings.schemaDocMs = Date.now() - schemaStart;
  }
  const systemPrompt = PROMPT_VERSION === "v2"
    ? buildPromptV2({ callerBlock, memoryBlock, schemaDoc })
    : [SYSTEM_PROMPT_BASE, callerBlock, memoryBlock].filter((s) => s).join("\n\n");

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  const toolsUsed = new Set<string>();
  const projectIds = new Set<number>();
  const taskIds = new Set<number>();
  let finalReply = "";

  // Tool catalog filter theo prompt version — v1 ẩn report.query để Qwen không
  // retry NL→SQL fail loop (saves 5-8 phút/turn).
  const catalog = toolCatalog(PROMPT_VERSION === "v2" ? "v2" : "v1");
  for (let step = 0; step < config.orchestrator.maxToolSteps; step++) {
    const resp = await chatWithAgentLog(ctx, `react_step_${step + 1}`, messages, catalog);
    recordLlmTrace(ctx, `react_step_${step + 1}`, resp);

    if (!resp.tool_calls?.length) {
      // LLM said "I'm done", no more tools to call. If content is empty
      // (Qwen sometimes returns null after a tool chain), force one more
      // call without tools to make it summarize what it just did.
      if (!resp.content || !resp.content.trim()) {
        const synthMessages: ChatMessage[] = [
          ...messages,
          {
            role: "user",
            content: "Tổng hợp ngắn gọn (≤200 chars) kết quả vừa làm cho user.",
          },
        ];
        const synth = await chatWithAgentLog(ctx, "react_empty_synth", synthMessages);
        recordLlmTrace(ctx, "react_empty_synth", synth);
        finalReply = synth.content?.trim() || "Đã xử lý xong.";
      } else {
        finalReply = resp.content;
      }
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
    // Hit max steps without a final answer. Force one synthesizing call
    // (no tools) so user gets something actionable instead of an apology.
    try {
      const synthMessages: ChatMessage[] = [
        ...messages,
        {
          role: "user",
          content:
            "Tổng hợp NGẮN GỌN những gì bạn đã làm + kết quả + câu hỏi tiếp theo nếu có. " +
            "KHÔNG gọi tool nữa, chỉ trả text Vietnamese ≤300 chars.",
        },
      ];
      const synth = await chatWithAgentLog(ctx, "react_forced_synth", synthMessages);
      recordLlmTrace(ctx, "react_forced_synth", synth);
      finalReply = synth.content?.trim() || "Đã thực hiện một số bước nhưng cần thêm thông tin từ bạn.";
    } catch {
      finalReply = "Đã xử lý nhiều bước nhưng cần thêm thông tin từ bạn để hoàn tất.";
    }
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

  // Sprint 8 follow-up — cache turn vào in-memory để turn tiếp theo (nếu user
  // gõ ngay, DB summary chưa kịp ghi) vẫn có context follow-up. Sync, cheap.
  recordRecentTurn(ctx.conversationId, userMessage, finalReply);

  agentLog(ctx, "agent.end", {
    durationMs: Date.now() - runStartedAt,
    mode: "llm",
    output: finalReply,
    outputChars: finalReply.length,
  });
  return finalReply;
}

async function chatWithAgentLog(
  ctx: AgentContext,
  label: string,
  messages: ChatMessage[],
  tools?: Parameters<typeof chat>[1],
): ReturnType<typeof chat> {
  const startedAt = Date.now();
  agentLog(ctx, "llm.start", {
    label,
    messages: summarizeMessagesForLog(messages),
    toolCount: tools?.length ?? 0,
    tools: tools?.map((t) => t.function.name),
  });
  try {
    const resp = await chat(messages, tools);
    agentLog(ctx, "llm.end", {
      label,
      durationMs: Date.now() - startedAt,
      latencyMs: resp.latencyMs,
      provider: resp.provider,
      model: resp.model,
      finishReason: resp.finish_reason,
      usage: resp.usage,
      content: resp.content ?? "",
      contentChars: resp.content?.length ?? 0,
      toolCalls: resp.tool_calls.map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })),
    });
    return resp;
  } catch (err: any) {
    agentLog(ctx, "llm.error", {
      label,
      durationMs: Date.now() - startedAt,
      error: err?.message ?? String(err),
    });
    throw err;
  }
}

function recordLlmTrace(ctx: AgentContext, label: string, resp: Awaited<ReturnType<typeof chat>>) {
  if (!ctx.timings) return;
  ctx.timings.llmCalls.push({
    label,
    latencyMs: resp.latencyMs ?? 0,
    provider: resp.provider,
    model: resp.model,
    finishReason: resp.finish_reason,
  });
}

/**
 * Look up the bb-pm user mapped to the Gapo conversation in `ctx`. Format
 * as a system-prompt block so the LLM knows who's chatting without having
 * to call find_user.
 *
 * Convention: ctx.conversationId looks like "gapo:<numeric_cid>" (set by
 * the watcher in browser-tools). Other channels (cli/cron) have different
 * shapes — for those we return "" and the prompt stays caller-agnostic.
 */
/**
 * Resolve caller's bb-pm user info từ ctx.conversationId. Mutates ctx.callerUserId
 * (Sprint 8 Day 3) để pre-classifier dùng được, AND returns formatted block cho
 * system prompt. Trả "" nếu không phải Gapo conversation.
 */
async function resolveCallerBlock(ctx: AgentContext): Promise<string> {
  if (!ctx.externalId) return "";
  try {
    const threadId = ctx.conversationId?.startsWith("gapo:")
      ? ctx.conversationId.slice("gapo:".length)
      : ctx.conversationId;
    const user = await getCachedGapoUser(ctx.externalId, threadId);
    if (!user) {
      // No bb-pm row for this Gapo user. Tell the LLM so it doesn't
      // hallucinate a userId or pretend to know who's asking.
      return [
        "CALLER (người đang chat):",
        `- Gapo user id: ${ctx.externalId}`,
        `- Chưa có row trong bb-pm DB. Khi user hỏi "task của tôi", "tôi là ai", `,
        `  hãy thành thật: "Mình chưa nhận diện bạn trong hệ thống PM. `,
        `  Báo admin add bạn vào database hoặc chat với bạn từ tài khoản bb-pm đã có sẵn."`,
      ].join("\n");
    }
    ctx.callerUserId = user.id;
    return [
      "CALLER (người đang chat):",
      `- bb-pm userId: ${user.id}`,
      `- Tên: ${user.fullName}`,
      `- Email: ${user.email}`,
      `- Role: ${user.role}${!user.active ? " (INACTIVE)" : ""}`,
      "",
      "Khi user hỏi 'task của tôi' / 'tôi có gì' / 'tôi là ai':",
      `- Dùng userId ${user.id} làm assigneeId filter, KHÔNG cần gọi find_user lại.`,
      `- Có thể xưng tên trực tiếp ("Bạn ${user.fullName}, ...").`,
    ].join("\n");
  } catch (err: any) {
    console.warn("[orchestrator] caller resolve failed:", err?.message ?? err);
    return "";
  }
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
    agentLog(ctx, "tool.error", {
      name,
      args: parsedArgs,
      durationMs: 0,
      error: "Unknown tool",
    });
    ctx.trace?.toolCalls.push({ name, args: parsedArgs, durationMs: 0, error: "Unknown tool" });
    void audit({ tool: name, argsJson: parsedArgs, errorMessage: `Unknown tool`, ctx, durationMs: 0 });
    return { result: { error: `Unknown tool: ${name}` }, parsedArgs };
  }

  const start = Date.now();
  try {
    agentLog(ctx, "tool.start", { name, args: parsedArgs });
    // Internal caller context for tools that need self-scoping. Hidden from
    // LLM-visible schemas; never include in user-facing replies.
    if (name === "report.query" && ctx.callerUserId) parsedArgs._callerUserId = ctx.callerUserId;
    const result = await tool.handler(parsedArgs);
    const dur = Date.now() - start;
    agentLog(ctx, "tool.end", {
      name,
      args: parsedArgs,
      durationMs: dur,
      result,
    });
    ctx.trace?.toolCalls.push({ name, args: parsedArgs, durationMs: dur });
    void audit({ tool: name, argsJson: parsedArgs, resultJson: summarize(result), ctx, durationMs: dur });
    return { result, parsedArgs };
  } catch (err: any) {
    const message = err?.message || String(err);
    const dur = Date.now() - start;
    agentLog(ctx, "tool.error", {
      name,
      args: parsedArgs,
      durationMs: dur,
      error: message,
    });
    ctx.trace?.toolCalls.push({ name, args: parsedArgs, durationMs: dur, error: message });
    void audit({ tool: name, argsJson: parsedArgs, errorMessage: message, ctx, durationMs: dur });
    return { result: { error: message }, parsedArgs };
  }
}

// Best-effort: pick up project / task IDs referenced in this turn so memory
// can be filtered later by {projectId, taskId}.
function collectIds(
  _toolName: string,
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
      source: entry.ctx.source === "eval" ? "other" : (entry.ctx.source ?? "chat"),
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
