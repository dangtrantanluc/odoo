# @openclaw/bb-pm-tools

`bb-pm-tools` là OpenClaw plugin đóng vai trò **PM Agent orchestrator**. Plugin nhận turn chat đã normalize từ channel adapter, chạy fast-path hoặc LLM, gọi `bb-pm API`, audit tool call, format reply và điều phối workflow định kỳ.

Production path:

```text
GapoWork -> gapo-agent -> bb-pm-tools -> bb-pm API -> PostgreSQL
```

## 1. Trách nhiệm

- Nhận request channel-agnostic tại `POST /api/plugins/bb-pm/agent/run`.
- Xử lý slash command và fast-path trước khi dùng LLM.
- Điều phối LLM OpenAI-compatible; mặc định hiện tại là Qwen self-hosted.
- Gọi tool qua HTTP client tới `bb-pm API`; không chạm DB trực tiếp.
- Chạy workflow cron như digest, hygiene, check-in reminder.
- Gửi outbound qua `gapo-agent /send`; plugin này không giữ credential Gapo.

## 2. Check-in flow hiện tại

Khi user gửi `/checkin` hoặc nhận reminder, bot mở session và hỏi:

```text
Hôm nay bạn làm project nào?

Gần đây:
1. AI PM Agent
2. Logistics Dashboard
3. CRM Internal

Hoặc nhập tên project khác.
```

Chỉ 3 project gần đây được hiển thị để tránh danh sách dài; user vẫn có thể:

- bấm quick reply;
- nhập số `1`, `2`, `3`;
- hoặc gõ tên project khác không nằm trong 3 lựa chọn.

State machine:

```text
AWAITING_PROJECT -> AWAITING_UPDATE -> COMPLETED
```

Sau khi user gửi update, agent parse nội dung và tạo worklog `GAPO_CHECKIN` trực tiếp cho project. Nếu project có task open, task vẫn là lớp gắn thêm tùy chọn; nếu không có task, check-in vẫn hoàn tất bình thường. Nếu LLM parse lỗi, code dùng regex fallback để giữ flow không bị gãy.

## 3. Slash command chính

- `/checkin` — bắt đầu cập nhật tiến độ hôm nay.
- `/project` — mở lại bước chọn project cho phiên check-in.
- `/report` — báo cáo hôm nay.
- `/blocker` — hướng dẫn báo blocker.
- `/help`, `/digest`, `/weekly`, `/mytasks`, `/overdue`, `/blocked`, `/stale`, `/projects`, `/role`, `/automations`.

## 4. Workflow định kỳ

| Workflow | Mục đích |
| --- | --- |
| `daily_digest` | Gửi digest ngày |
| `weekly_report` | Gửi báo cáo tuần |
| `hygiene_check` | Kiểm tra hygiene dữ liệu |
| `role_based_digest` | Digest theo role |
| `noon_checkin_reminder` | Nhắc check-in giữa ngày |
| `eod_checkin_reminder` | Nhắc check-in cuối ngày |
| `missing_checkin_followup` | Follow-up user còn thiếu check-in |

Reminder check-in chỉ gửi cho user còn thiếu check-in, có Gapo identity, không có session đang mở, và có project open để chọn.

## 5. Runtime contracts

### Endpoint

```text
POST /api/plugins/bb-pm/agent/run
GET  /api/plugins/bb-pm/health
GET  /api/plugins/bb-pm/agent/metrics
```

### Request tối thiểu

```json
{
  "text": "/checkin",
  "source": "chat",
  "conversationId": "gapo:123",
  "externalId": "gapo-user-id"
}
```

### Response có quick reply

```json
{
  "reply": "Hôm nay bạn làm project nào?...",
  "channelReply": {
    "type": "quick_replies",
    "text": "Hôm nay bạn làm project nào?...",
    "metadata": { "options": [] }
  },
  "fastPath": "checkin:start"
}
```

## 6. Env quan trọng

| Env | Vai trò |
| --- | --- |
| `BB_PM_API_URL` | Base URL của backend |
| `BB_PM_AGENT_TOKEN` | Auth tới backend |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | LLM provider |
| `GAPO_SEND_URL`, `GAPO_SEND_TOKEN` | Outbound tới `gapo-agent` |
| `REDIS_URL` | Runtime support |
| `CRON_CHECKIN_ENABLED` | Bật/tắt reminder check-in |
| `CRON_NOON_CHECKIN`, `CRON_EOD_CHECKIN`, `CRON_MISSING_CHECKIN_FOLLOWUP` | Lịch cron |

## 7. Test và debug

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm cli --workflow noon_checkin_reminder
pnpm cli --workflow eod_checkin_reminder
pnpm cli --workflow missing_checkin_followup
```

Khi debug `/checkin`, kiểm tra theo thứ tự:

1. user có `channel_identity` Gapo hay chưa;
2. user có tham gia project nào hoặc có task open được assign hay chưa;
3. `CRON_CHECKIN_ENABLED` có bật đúng lúc cần reminder hay chưa;
4. log `checkin:*` trong plugin;
5. metrics `checkin.sessionsStarted`, `projectsSelected`, `completed`, `parseSuccess`, `parseFallback`.

## 8. File map

Source mới đi theo feature-first layout; các file top-level cũ như `src/tools.ts` và `src/pre-classifier.ts` là shim tương thích mỏng để tránh phá import path cũ.

- `src/routing/` — action router, read router, fast-path.
- `src/checkin/` — check-in state machine.
- `src/reporting/nl-to-sql/` — translator và knowledge retrieval.
- `src/tools/catalog.ts` — tool catalog hiện tại.
- `src/workflows/` — workflow registry và scheduler.
- `src/agent/` — memory và prompt assets.
- `src/infrastructure/` — bb-pm API, channel, LLM, Redis clients.
- `src/shared/` — config, types, telemetry, template và text helpers.
- `src/webhook.ts`, `src/orchestrator.ts` — HTTP entrypoint và ReAct path; đây là các boundary còn lại sẽ tiếp tục được tách dần khi có nhu cầu thực tế.

Đọc tiếp: [../README.md](../README.md), [../RUNBOOK.md](../RUNBOOK.md), [../ARCHITECTURE.md](../ARCHITECTURE.md).
