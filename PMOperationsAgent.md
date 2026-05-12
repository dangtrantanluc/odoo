# PM Operations Agent (OpenClaw-based)

## 🎯 Mục tiêu hệ thống

Xây dựng một AI Agent có thể **cover phần lớn công việc hằng ngày của Project Manager (PM)**:

- Theo dõi tiến độ dự án
- Chủ động follow-up team
- Phát hiện rủi ro & blocker
- Tổng hợp báo cáo cho lãnh đạo
- Hỗ trợ họp & action items
- Giữ dữ liệu quản trị sạch

---

# 🧠 1. Vai trò của PM (Daily Work Breakdown)

## 1. Theo dõi tiến độ
- Task status (todo / in_progress / blocked / done)
- Task sắp tới hạn / quá hạn
- Task lâu chưa update
- Milestone progress
- Critical path
- Dependency giữa task

## 2. Follow-up đội ngũ
- Nhắc cập nhật tiến độ
- Hỏi blocker
- Hỏi ETA mới
- Nhắc review / test / deploy
- Ping đúng owner

## 3. Đồng bộ thông tin
- Gom update từ chat, task, meeting
- Chuẩn hóa thành structured data
- Cập nhật lại hệ thống

## 4. Quản lý blocker & risk
- Detect blocker
- Phân loại blocker
- Theo dõi blocker
- Escalate khi cần

## 5. Giao tiếp & điều phối
- Nhắn team
- Trả lời CEO/manager
- Gửi summary
- Điều phối giữa team

## 6. Báo cáo
- Daily summary
- Weekly report
- Milestone health
- Risk report
- Deadline confidence

## 7. Data hygiene
- Task thiếu owner
- Task thiếu due date
- Status lỗi thời
- Task bị bỏ quên

## 8. Họp & action items
- Ghi notes
- Extract action items
- Assign owner
- Theo dõi action

---

# ⚙️ 2. Capability của PM Agent

## Level 1: Quan sát
- Scan task DB
- Detect overdue / stale / blocked
- Compute risk

## Level 2: Follow-up
- Nhắc owner
- Hỏi progress / blocker / ETA

## Level 3: Tổng hợp
- Viết báo cáo
- Trả lời CEO
- Summarize data

## Level 4: Điều phối (có kiểm soát)
- Tạo action items
- Đề xuất escalation
- Đề xuất next steps

---

# 🔄 3. Các Flow chính

## Flow 1: Daily Project Scan
- Scan task
- Detect overdue / stale / blocked
- Generate snapshot
- Generate follow-up list

## Flow 2: Task Follow-up
1. Chọn task cần hỏi
2. Xác định owner
3. Check cooldown
4. Gửi message
5. Nhận reply
6. Parse reply
7. Update DB
8. Escalate nếu cần

## Flow 3: Blocker Management
- Parse blocker
- Classify blocker
- Assign resolver
- Track until resolved

## Flow 4: Meeting Assistant
- Ingest notes
- Extract decisions
- Extract action items
- Assign owner
- Create follow-up

## Flow 5: Executive Query
- Nhận câu hỏi CEO
- Lấy project snapshot
- Check data completeness
- Nếu thiếu → hỏi owner
- Generate report

## Flow 6: Reporting
- Daily digest
- Weekly summary
- Risk report

## Flow 7: Data Hygiene
- Detect missing owner
- Detect missing due date
- Detect stale status

## Flow 8: Planning Support
- Suggest priority
- Suggest risk mitigation
- Suggest next actions

---

# 🏗️ 4. Kiến trúc hệ thống

## Tổng quan

Hệ thống được chia thành **3 layer độc lập**, giao tiếp qua HTTP/JSON. Không layer nào chứa logic của layer khác — dễ thay thế, dễ test.

```
┌────────────────────────────────────────────────────────────────────┐
│                        CHANNELS (người dùng)                       │
│   Gapo Work   Zalo   Slack   Telegram   Email   Voice   Web Chat   │
└────────────────┬───────────────────────────────────────────────────┘
                 │  webhook / long-poll
                 ▼
┌────────────────────────────────────────────────────────────────────┐
│                    OPENCLAW  (AI orchestrator)                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ Channel      │  │ PM           │  │ PM Tool Plugin           │  │
│  │ Plugins      │─▶│ Orchestrator │─▶│ (bb-pm API client)       │  │
│  │ (Gapo/Slack) │  │ (ReAct LLM)  │  │                          │  │
│  └──────────────┘  └──────┬───────┘  └──────────┬───────────────┘  │
│                           │ memory              │ cron scheduler   │
│                           ▼                     ▼                  │
│                    ┌───────────────────────────────┐               │
│                    │ pgvector (agent memory)       │               │
│                    │ redis (cooldown, rate limit)  │               │
│                    └───────────────────────────────┘               │
└────────────────┬───────────────────────────────────────────────────┘
                 │  Bearer JWT (PM Agent service user)
                 ▼
┌────────────────────────────────────────────────────────────────────┐
│                    BB-PM API  (source of truth)                    │
│   Fastify + Prisma  ──▶  PostgreSQL 16 (projects/tasks/backlogs)   │
│                      ──▶  MinIO (attachments, reports)             │
└────────────────────────────────────────────────────────────────────┘
```

---

## 4.1 Phân chia trách nhiệm

| Layer | Sở hữu | KHÔNG chứa |
|---|---|---|
| **Channels** | Gửi/nhận message, auth với nền tảng gốc | Logic PM, LLM call |
| **OpenClaw** | Intent routing, LLM orchestration, scheduler, conversation state | Schema project/task, business rule |
| **bb-pm API** | Schema, CRUD, transition state machine, recompute cost | Chat history, LLM prompt |

**Nguyên tắc:** nếu một logic đồng thời dùng được cho con người (qua Web UI) và cho agent (qua chat), nó **phải nằm ở bb-pm API**. OpenClaw chỉ là consumer.

---

## 4.2 OpenClaw — 3 loại plugin

### a) Channel Plugins (đã có sẵn hoặc bundled)

Nhiệm vụ: adapter giữa nền tảng chat và OpenClaw core. Không biết gì về PM.

| Plugin | Trạng thái | Ghi chú |
|---|---|---|
| `gapo-work` | Skeleton đã có tại `openclaw/plugins/` — cần refactor theo `sdk-channel-plugins` | Kênh chính cho team nội bộ BlueBolt |
| `zalo` / `zalouser` | Bundled | CEO/khách hàng ngoài |
| `slack` | Core | Team kỹ thuật |
| `telegram` | Core | Dự phòng, cá nhân |
| `gmail` (MCP) | Wrap thành channel adapter | Gửi report định kỳ |

### b) PM Tool Plugin — `@openclaw/bb-pm-tools` (viết mới)

Expose bb-pm API dưới dạng tool contract theo `plugin-sdk/provider-entry.ts`. Agent sẽ gọi các tool này trong ReAct loop.

```ts
// tool signatures
get_project_snapshot(projectId: string)
list_overdue_tasks(projectId?: string, days?: number)
list_stale_tasks(projectId?: string, daysSinceUpdate: number)
list_blocked_tasks(projectId?: string)
get_task_owner(taskId: string)
update_task_status(taskId: string, status: Status, note?: string)
post_blocker(taskId: string, description: string, severity: 'low'|'med'|'high')
send_follow_up(userId: string, taskId: string, question: string)
create_action_item(source: string, title: string, ownerId: string, dueDate?: string)
generate_daily_digest(projectId: string)
check_data_hygiene(projectId: string)
```

Mỗi tool = 1 HTTP call đến `bb-pm API /api/v1/*` với Bearer token của **PM Agent service user** (role `MANAGER`, tạo seed khi deploy).

### c) PM Orchestrator Plugin — provider plugin (viết mới)

- **System prompt** đóng vai PM, có 4 level capability (Quan sát → Follow-up → Tổng hợp → Điều phối).
- **ReAct loop** dùng tool plugin (b).
- **Intent router** tiếng Việt: `view_tasks | update_status | report_blocker | ask_progress | ceo_query | meeting_note | help`.
- **Memory**:
  - Short-term: Redis key `conv:{channelId}:{userId}:{threadId}` TTL 24h.
  - Long-term: pgvector table `agent.memory` — embed conversation summary, follow-up history, blocker context.

---

## 4.3 Các flow chính chạy như thế nào

| Flow | Trigger | Thành phần tham gia |
|---|---|---|
| **1. Daily Project Scan** | Cron `0 8 * * *` (OpenClaw scheduler) | `list_overdue + list_stale + list_blocked` → digest → Gapo channel PM |
| **2. Task Follow-up** | Cron + inbound reply | `get_task_owner → send_follow_up` với Redis cooldown 24h, thread tracker |
| **3. Blocker Management** | Inbound chứa "blocker/kẹt/chưa xong" | Intent detect → `post_blocker` → assign theo rule (severity + team) |
| **4. Meeting Assistant** | Webhook upload transcript / file | LLM extract decision + action → `create_action_item` (pending PM approve) |
| **5. Executive Query** | CEO chat qua channel | `get_project_snapshot + check_data_hygiene` → nếu thiếu data thì chạy Flow 2 trước khi trả lời |
| **6. Reporting** | Cron daily/weekly | `generate_daily_digest` → markdown → Gmail MCP gửi stakeholder |
| **7. Data Hygiene** | Cron weekly | `check_data_hygiene` → tạo action item cho owner thiếu due/owner/update |
| **8. Planning Support** | Slash command `/plan <project>` | LLM + `get_project_snapshot` → đề xuất priority & risk (không auto-apply) |

---

## 4.4 Data flow — ví dụ Flow 5 (CEO hỏi tiến độ)

```
CEO (Zalo) ─────────► zalo-plugin
                         │  message event
                         ▼
                   PM Orchestrator
                         │  1. classify intent = ceo_query
                         │  2. load memory (pgvector)
                         ▼
                   Tool: get_project_snapshot(projectId)
                         │  HTTP GET /api/v1/projects/:id/snapshot
                         ▼
                    bb-pm API ───► Postgres
                         │  { tasks, overdue, blockers, % done }
                         ▼
                   Tool: check_data_hygiene(projectId)
                         │  → nếu stale → trigger Flow 2 ngầm
                         ▼
                   LLM compose answer (VI)
                         │
                         ▼
                   zalo-plugin ─────► CEO
                         │
                         └─► log vào agent.memory
```

---

## 4.5 Identity & permission

- **bb-pm** đã có 4 role: `ADMIN / MANAGER / MEMBER / VIEWER`.
- Thêm bảng `channel_identity`:
  ```
  id | userId | channel (gapo|slack|zalo|telegram) | externalId | preferred (bool)
  ```
  Cho phép `send_follow_up` route đến kênh ưa thích của từng người.
- PM Agent có **1 service user** role `MANAGER`, token cấp qua `.env`. Không cho agent lên `ADMIN` để tránh thao tác phá DB.
- Mọi tool call ghi audit vào `agent.audit_log` (actor = service user, correlation = channel message id).

---

## 4.6 Deployment

Bổ sung vào `bb-pm/docker-compose.yaml` (dùng chung network `pm_network`):

```yaml
services:
  openclaw:
    build: ../openclaw
    environment:
      - BB_PM_API_URL=http://bb_pm_api:4000/api/v1
      - BB_PM_AGENT_TOKEN=${BB_PM_AGENT_TOKEN}
      - REDIS_URL=redis://redis:6379
      - PGVECTOR_URL=postgres://admin:admin123@bb_pm_db:5432/bb_pm
      - LLM_BASE_URL=${LLM_BASE_URL}
      - LLM_API_KEY=${LLM_API_KEY}
    depends_on: [bb_pm_api, redis, bb_pm_db]

  redis:
    image: redis:7-alpine
    volumes: [redis_data:/data]
```

Migration `agent` schema vào Postgres hiện có:

```sql
CREATE SCHEMA agent;
CREATE TABLE agent.memory      (...vector(1536), conv_id, summary, ts);
CREATE TABLE agent.follow_ups  (task_id, user_id, asked_at, replied_at, status);
CREATE TABLE agent.audit_log   (actor, tool, args_json, result_json, ts);
```

---

## 4.7 Lộ trình build — 6 sprint (song song với bb-pm roadmap)

| Sprint | Level | Deliverable |
|---|---|---|
| **S1 Foundation** | — | Service user + token, scaffold plugin `@openclaw/bb-pm-tools`, 1 tool chạy được (`list_overdue_tasks`) từ Gapo |
| **S2 Observer** | L1 | Flow 1 + Flow 7: digest sáng 8h, data hygiene weekly |
| **S3 Follow-up** | L2 | Flow 2 + Flow 3: cooldown Redis, intent parser VN, reply thread |
| **S4 Summarizer** | L3 | Flow 5 + Flow 6: CEO query trả lời có số liệu, weekly report qua Gmail |
| **S5 Coordinator** | L4 | Flow 4 + Flow 8: meeting transcript → action items (human-approve), planning suggestions |
| **S6 Polish** | — | Multi-channel unified identity, audit dashboard, E2E test, load test |

Mỗi sprint = 2 tuần, kết thúc bằng demo live với dữ liệu thật của 1 dự án pilot.

---

## 4.8 Quyết định cần chốt trước S1

1. **Kênh MVP**: chốt Gapo Work là bắt buộc. CEO dùng kênh nào?
2. **Mức tự chủ của agent**: Flow 3/4/5 — auto-action hay chỉ đề xuất chờ PM approve? (khuyến nghị: đề xuất + approve ở tuần đầu để xây trust)
3. **LLM provider**: self-hosted Qwen/gpt-oss (rẻ, chậm) cho Flow 1-2-7; Anthropic API cho Flow 4-5-6 (summary chất lượng cao)?
4. **Agent memory scope**: dùng chung `bb_pm` DB với schema `agent.*` (đề xuất) hay tách DB riêng?
5. **Escalation path**: khi blocker severity=high, ai nhận ping đầu tiên — PM, tech lead, hay CEO?
