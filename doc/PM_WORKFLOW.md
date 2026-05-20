# PM Workflow — Quy trình làm việc & tracking dự án

**Đối tượng đọc**: Project Manager, BA, Tech Lead, Manager.
**Mục tiêu**: hiểu hệ thống vận hành như thế nào từ lúc lập kế hoạch đến lúc đóng dự án, ai làm gì ở mỗi bước, agent tự động hoá những gì, dữ liệu nào dùng để track tiến độ.

---

## 1. Tổng quan kiến trúc làm việc

Hệ thống quản lý dự án nội bộ gồm **3 thành phần** cộng tác với nhau:

```
┌────────────────────────────────────────────────────────────────────┐
│                    PM / Manager / Team Member                       │
│                              ▲     │                                │
│              chat trên Gapo  │     │  cập nhật trên Web bb-pm       │
│                              │     ▼                                │
│   ┌──────────────────┐   ┌──────────────────┐                      │
│   │  PM Agent (chat) │   │   bb-pm Web/API  │                      │
│   │                  │   │                  │                      │
│   │ • Planning Agent │◀──┤ • Source of truth│                      │
│   │ • Daily Exec.    │──▶│ • RBAC, audit    │                      │
│   │                  │   │ • PostgreSQL     │                      │
│   └──────────────────┘   └──────────────────┘                      │
└────────────────────────────────────────────────────────────────────┘
```

- **bb-pm** (Web + API + PostgreSQL): nơi lưu **toàn bộ dữ liệu thật** — Project, Milestone, Task, Backlog (worklog), Scope (estimate). PM xem báo cáo trực quan trên Web.
- **PM Agent** (Python, chạy nền): tiếp xúc team qua chat Gapo. Tự động hoá nhập worklog, sinh kế hoạch, cảnh báo rủi ro. **Không giữ dữ liệu** — mọi thao tác ghi đều đi qua bb-pm API.
- **Gapo**: kênh chat, dùng làm UX cho input/notification nhanh.

Hai loại "agent" trong PM Agent service đóng 2 vai khác nhau:

| Agent | Vai trò | Trigger | Quyền |
|---|---|---|---|
| **Planning Agent** | Lập kế hoạch dự án mới: chia epic, task, estimate, dependency, gợi ý assignee | `/plan` hoặc câu "lập kế hoạch …" | Chỉ Manager/Admin |
| **Daily Execution Agent** | Vận hành hằng ngày: nhắc/nhập worklog, báo cáo, hỏi đáp, cảnh báo rủi ro | Cron tự động + các slash command (`/checkin`, `/mytasks`, `/risk` …) | Mọi role, có filter theo quyền |

---

## 2. Cấu trúc thông tin dự án (Information Architecture)

Cấp bậc dữ liệu mà PM cần thuộc để track:

```
Project
  ├─ status: PLANNED → IN_PROGRESS → COMPLETED (hoặc ON_HOLD/CANCELLED)
  ├─ estimatedTotalHours      ← Planning Agent ước tính
  ├─ totalHours               ← cộng dồn tự động từ Backlog APPROVED
  ├─ taskCount, doneCount
  │
  ├── Milestone (≈ epic)
  │     ├─ dueDate, completionPct  ← roll-up từ Task
  │     │
  │     └── Task
  │           ├─ status: TODO → IN_PROGRESS → REVIEW → DONE
  │           ├─ priority: LOW | MEDIUM | HIGH | URGENT
  │           ├─ deadline
  │           ├─ assignee
  │           ├─ totalHours  ← cộng dồn từ Backlog APPROVED gắn task này
  │           ├── Scope (mục estimate)
  │           │     └─ estimatedHours  ← chuẩn so với totalHours để bắt over-estimate
  │           ├── TaskBlocker (vướng mắc)
  │           │     ├─ severity: LOW | MED | HIGH
  │           │     └─ resolvedAt? (null = còn vướng)
  │           └── Backlog (worklog gắn task)
  │                 ├─ workDate, hours, description
  │                 └─ status: PENDING → APPROVED | REJECTED
  │
  └── Backlog (worklog gắn project, không gắn task)  — dùng cho việc lẻ
```

Quy tắc đọc:
- "Task" là **đơn vị giao việc + đo tiến độ** quan trọng nhất. Mọi báo cáo của Daily Agent xoay quanh task.
- **Scope.estimatedHours là "ngân sách giờ" cho task**. Khi `Task.totalHours > Scope.estimatedHours × 1.2` → cảnh báo OVER_ESTIMATE.
- **Backlog (worklog) là đơn vị đo công thực tế**. Mỗi backlog APPROVED bơm `hours` vào `Task.totalHours` và `Project.totalHours`.
- **Milestone đóng vai epic** — nhóm task theo phase/giai đoạn dự án. Một dự án thường 3–8 milestone.

---

## 3. Vai trò & trách nhiệm (RACI thu gọn)

| Hoạt động | PM/Manager | Tech Lead | Member | Agent |
|---|---|---|---|---|
| Lập kế hoạch dự án mới | **A/R** | C | I | R (sinh draft) |
| Duyệt & tinh chỉnh kế hoạch | **A/R** | C | — | — |
| Giao task cho Member | **A** | R | — | C (suggest) |
| Cập nhật worklog hằng ngày | I | R | **R** | R (nhắc + ghi nhận) |
| Duyệt worklog (APPROVED) | **R** | R | — | — |
| Báo cáo blocker | I | R | **R** | R (parse từ worklog) |
| Theo dõi risk dự án | **A/R** | C | I | R (analyzer + digest) |
| Đóng task / đóng milestone | **A/R** | R | R | — |

**R**: thực hiện | **A**: chịu trách nhiệm cuối | **C**: tư vấn | **I**: được thông báo.

---

## 4. Quy trình end-to-end

### Giai đoạn 0 — Tiền đề

Trước khi vào hệ thống, cần làm xong:

1. Tài khoản bb-pm cho mọi thành viên (Manager seed sẵn role: `ADMIN`, `MANAGER`, `MEMBER`, `VIEWER`).
2. Mỗi user **liên kết Gapo identity** với bb-pm user (`ChannelIdentity` table) — không có liên kết thì agent không nhận diện được người gõ.
3. Bot Gapo đã add vào DM/thread của team, `GAPO_BOT_ID`/`GAPO_BOT_TOKEN` khớp.

### Giai đoạn 1 — Lập kế hoạch dự án (Planning)

```
┌─────────┐
│ Manager │  "/plan"  →  Planning Agent
└────┬────┘
     │
     ▼  Agent kiểm RBAC (Manager/Admin?)
┌─────────────────────────────────────────────────────────────┐
│  COLLECTING_BRIEF — Manager mô tả dự án                     │
│                                                             │
│  Manager: "Dự án MTL — chuyển đổi số. T5 → T1 năm sau.      │
│            Team: 3 dev. Mục tiêu: thay phần mềm cũ."        │
└────────────────────┬────────────────────────────────────────┘
                     ▼
            Agent load roster (open_tasks, department)
            Gọi LLM sinh PlanDraft (epic + task + estimate
                + dependency + assignee suggestion)
            Validate JSON + cross-reference
            Lưu draft vào AgentMemory (marker [PLAN_DRAFT v1])
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  DRAFT_REVIEW — Agent show kế hoạch                         │
│                                                             │
│  Dự án MTL  (≈480h, kết thúc 2026-01-31)                    │
│  E1. Phân tích yêu cầu (due 2025-07-15)                     │
│    T1. Khảo sát quy trình hiện tại    16h → Tuấn            │
│    T2. Viết SRS                       24h → Tuấn  ⟵ phụ thuộc T1
│  E2. Module quản lý kho (due 2025-09-30)                    │
│    T3. ERD + migration                20h → Hà              │
│    ...                                                      │
│                                                             │
│  [Tạo thật]  [Hủy]    hoặc gõ "sửa: …"                      │
└────────────────────┬────────────────────────────────────────┘
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
      "ok"     "sửa: gộp T1+T2"   "hủy"
        │            │            │
        ▼            ▼            ▼
   MATERIALIZE   apply_edit    delete session
        │      (lặp lại review)
        ▼
┌─────────────────────────────────────────────────────────────┐
│  Materialize — bb-pm API gọi thật (đúng thứ tự):           │
│   1. POST /projects                  → projectId            │
│   2. POST /milestones/by-project/N   × số epic              │
│   3. POST /tasks/by-project/N        × số task              │
│      PATCH /tasks/<id>  (milestoneId, priority, desc)       │
│   4. PATCH /tasks/<id>  (description += "Phụ thuộc: #X")    │
│   5. POST /scopes/by-project/N       (estimatedHours)       │
│   6. Lưu AgentMemory marker [PLAN_MATERIALIZED v1]          │
└─────────────────────────────────────────────────────────────┘
```

**Output cho PM**:
- Một Project mới status `PLANNED`, đầy đủ milestone/task/scope trên Web.
- Audit log ghi `planning.materialized` để truy vết ai tạo, lúc nào.
- PM mở Web bb-pm vào project → kiểm tra, sửa thủ công những chỗ LLM đoán chưa chính xác (đổi assignee, dời deadline), rồi chuyển status → `IN_PROGRESS`.

**Hạn chế cần biết**:
- Task **dependency** ghi dạng text trong `Task.description` ("Phụ thuộc: #42"), không có table riêng → không tự động khoá task khi prerequisite chưa DONE. PM tự enforce trong daily standup.
- LLM ước tính `estimate_hours` theo brief — phải xem lại trước khi dùng làm chuẩn đo. Không tin mù.

### Giai đoạn 2 — Vận hành hằng ngày (Daily Execution)

Diễn ra mỗi ngày làm việc. Lặp lại đến khi dự án xong.

#### 2.1. Member cập nhật worklog

```
11:50 — Cron nhắc lần 1 (noon)
17:50 — Cron nhắc lần 2 (EOD)
18:00 — Cron follow-up cho ai chưa điền

Agent → Member (DM Gapo):
  "Bạn cập nhật worklog hôm nay nhé. Chọn project gần đây:
   1. Dự án MTL
   2. Internal Tools
   3. Mobile App
   …"

Member chọn → Agent hỏi update:
  "Bạn cập nhật worklog hôm nay nhé: nội dung đã làm, số giờ,
   trạng thái (đang làm/review/xong) và blocker nếu có."

Member: "Viết xong API tạo task, 6h, review. Bị kẹt do design chưa rõ field giá"

Agent parse (LLM + regex fallback):
  - summary: "Viết xong API tạo task"
  - hours: 6
  - status: REVIEW
  - blocker: "design chưa rõ field giá" (severity tự suy luận = MED)

Agent có thể hỏi thêm "task nào?" nếu nhận diện được task khả dĩ.

→ Tạo Backlog (status=PENDING) gắn project (và task nếu chọn)
→ Nếu có status: PATCH task transition (TODO → IN_PROGRESS / REVIEW / DONE)
→ Nếu có blocker: POST /tasks/<id>/blocker
```

**Quy ước Member cần thuộc**:
- Mỗi worklog phải có **giờ** (định lượng) — không có giờ thì PM không đo được capacity.
- Khi task DONE: gõ "xong" trong worklog → agent tự chuyển status → PM thấy ngay.
- Khi kẹt: dùng từ "kẹt", "vướng", "không có" trong câu → agent tạo Blocker tự động → PM thấy trong digest.

#### 2.2. Manager duyệt worklog

Trên Web bb-pm:

```
PENDING → APPROVED   (đếm vào Task.totalHours, Project.totalHours)
PENDING → REJECTED   (kèm rejectedReason; Member sửa rồi tái nộp)
```

Tốc độ approve quyết định độ tươi của số liệu tracking. Khuyến nghị duyệt **mỗi sáng** (xem worklog hôm trước).

#### 2.3. Hệ thống tự roll-up

Sau khi APPROVED:
- `Task.totalHours += backlog.hours`
- `Project.totalHours += backlog.hours`
- `Milestone.completionPct = doneCount / taskCount` được tính lại.
- `Project.budgetRemaining = budget − totalCost`.

PM không cần can thiệp tay.

### Giai đoạn 3 — Theo dõi rủi ro (Risk Tracking)

```
Mỗi ngày (cron 18:30 T2–T6):
┌─────────────────────────────────────────────────────────┐
│  RiskAnalyzer.analyze_company()                         │
│                                                         │
│  for project in IN_PROGRESS:                            │
│    tasks    = GET /tasks?projectId=N                    │
│    scopes   = GET /scopes?projectId=N   (estimate)      │
│    worklogs = GET /agent/checkins/status (4 ngày gần)   │
│                                                         │
│    for task in tasks:                                   │
│      Quét 5 tín hiệu:                                   │
│        OVERDUE   → deadline < today & status != DONE    │
│        STALE     → IN_PROGRESS & ≥ 3 ngày không log     │
│        OVER_EST. → totalHours / estimatedHours ≥ 1.2    │
│        BLOCKER   → có TaskBlocker chưa resolve, HIGH    │
│        NO_CHECKIN→ IN_PROGRESS & assignee chưa log today│
│                                                         │
│    Score = Σ severity (LOW=1, MED=3, HIGH=8)            │
│    Phân loại: < 5 GREEN, < 15 YELLOW, ≥ 15 RED          │
└─────────────────────────────────────────────────────────┘
              │
              ▼
   Nếu YELLOW/RED → LLM tóm tắt worklog 3 ngày gần nhất
              │
              ▼
   Push Risk Digest cho Owner (DM Gapo):

   🟡 Risk — Dự án MTL  (score=11, YELLOW)

   Task có vấn đề:
   • #42 "Viết SRS" — OVERDUE, STALE 4d → Tuấn
   • #51 "ERD + migration" — OVER_ESTIMATE (30h/20h) → Hà
   • #60 "API tạo task" — HIGH_BLOCKER → Tuấn

   Tóm tắt:
   "3 ngày qua đội xử lý 8 task, hoàn thành 3. Hà chậm
    ERD do chờ business confirm field giá. Đề xuất: PM
    chốt field giá trong sáng mai."
```

PM hành động:
- **HIGH severity** → can thiệp ngay (gọi 1-1, dời deadline, thêm người).
- **MED** → đưa vào standup mai bàn cách gỡ.
- **LOW** → ghi nhận, theo dõi.

Ngoài cron, PM có thể chủ động bất cứ lúc nào:

```
/risk Dự án MTL      ← snapshot risk tức thì (không kèm narrative)
```

### Giai đoạn 4 — Hỏi đáp & báo cáo theo yêu cầu

Slash commands cho mọi role (filter dữ liệu theo quyền):

| Lệnh | Trả về | Dùng khi |
|---|---|---|
| `/mytasks` | Task đang mở của caller | Sáng đầu ngày |
| `/overdue` | Task quá hạn (filter quyền) | PM kiểm danh sách cần can thiệp |
| `/stale` | Task ≥ 14 ngày không update | PM cleanup data hygiene |
| `/projects` | Danh sách dự án IN_PROGRESS | Sếp / Manager xem tổng |
| `/digest` | Tổng hợp hôm nay | Đầu giờ chiều |
| `/weekly` | Báo cáo tuần | Cuối tuần |
| `/risk <project>` | Risk snapshot 1 project | PM trước họp standup |
| `/automations` | Cron đang chạy | DevOps check |
| `/help` | Danh sách lệnh | Lúc quên cú pháp |

NL query tự do (qua NL→SQL, chỉ-đọc): "task quá hạn của dự án MTL?", "ai có nhiều task mở nhất tuần này?". Agent dịch sang SQL chạy trên DB và trả kết quả văn bản.

### Giai đoạn 5 — Đóng dự án

PM thực hiện thủ công trên Web:

```
1. Kiểm tra: mọi task DONE? mọi blocker resolved?
2. Đóng từng Milestone (status = COMPLETED).
3. Đóng Project (status = COMPLETED, endDate = ngày thực tế).
4. Xuất báo cáo: Project.totalHours vs estimatedTotalHours
                 → bài học estimate cho dự án kế.
5. Lưu lessons learned vào ghi chú dự án.
```

---

## 5. State diagram quan trọng

### 5.1. Task lifecycle

```
       ┌─────┐ assign     ┌──────────────┐ submit      ┌────────┐ approve ┌──────┐
       │TODO │ ─────────▶ │ IN_PROGRESS  │ ──────────▶ │ REVIEW │ ──────▶│ DONE │
       └──┬──┘            └──────┬───────┘             └────┬───┘        └──────┘
          │                       │                          │
          │ cancel                │ blocked                  │ rework
          ▼                       ▼                          ▼
       (DELETE)              TaskBlocker              IN_PROGRESS
                              (chưa thay state)
```

Quy ước:
- Task chỉ DONE khi worklog cuối APPROVED (PM gác cổng).
- Có TaskBlocker chưa resolve thì task vẫn IN_PROGRESS — không tự đẩy lên TODO.

### 5.2. Backlog (worklog) lifecycle

```
   ┌─────────┐   approve  ┌──────────┐
   │ PENDING │ ─────────▶ │ APPROVED │  ─── cộng vào totalHours
   └────┬────┘            └──────────┘
        │ reject (kèm lý do)
        ▼
   ┌──────────┐  member sửa & nộp lại
   │ REJECTED │ ─────────────────────▶  PENDING (record mới)
   └──────────┘
```

### 5.3. Project lifecycle

```
   PLANNED ──kickoff──▶ IN_PROGRESS ──finish──▶ COMPLETED
      │                    │
      │ (cancel)            │ (pause)
      ▼                    ▼
   CANCELLED            ON_HOLD ── resume ──▶ IN_PROGRESS
```

Mỗi lần đổi status có audit log (ai, lúc nào, lý do nếu có).

---

## 6. Số liệu PM cần theo dõi mỗi tuần

| Chỉ số | Lấy ở đâu | Tần suất | Ngưỡng cảnh báo |
|---|---|---|---|
| **% worklog điền đúng giờ** | `GET /agent/checkins/missing` | Hằng ngày | < 80% → siết kỷ luật |
| **Số task OVERDUE** | `/overdue` | Hằng ngày | > 5/dự án → can thiệp |
| **Score risk dự án** | Risk digest cron | Hằng ngày | ≥ 15 (RED) → escalate |
| **Velocity tuần** | `/weekly` (Project.totalHours/tuần) | T2 hàng tuần | Giảm > 20% so 4 tuần trước |
| **Tỉ lệ task vượt estimate** | RiskAnalyzer | Cuối milestone | > 30% → soi lại cách estimate |
| **Số blocker HIGH chưa resolve** | `Project.blockerCount` (web) | Hằng ngày | > 2 → ưu tiên gỡ |
| **Worklog PENDING quá hạn duyệt** | Web filter status=PENDING, age > 24h | Hằng ngày | > 10 → duyệt ngay |

---

## 7. Quy ước đặt tên (cho mọi entity)

| Entity | Convention | Ví dụ |
|---|---|---|
| **Project name** | `<Khách hàng/Internal> <Tên gọn>` | "MTL Chuyển đổi số", "Internal PM Bot" |
| **Project code** | `<3 chữ in hoa>-<seq>` | "MTL-01", "INT-03" |
| **Milestone** | `M<n> — <Tên phase>` | "M1 — Phân tích yêu cầu" |
| **Task** | Động từ + đối tượng | "Viết SRS module kho", "Tích hợp Gapo OAuth" |
| **Scope** | `Estimate: <Task name>` (do agent tự đặt) | "Estimate: Viết SRS module kho" |

---

## 8. Anti-patterns — Tránh làm

1. **Task không có Scope → không track được estimate**. Khi tạo task thủ công ngoài Planning Agent, nhớ tạo Scope kèm theo (web có form).
2. **Worklog không gắn task** (chỉ gắn project). Worklog "lẻ" không bơm vào `Task.totalHours` → RiskAnalyzer không bắt được over-estimate. Chỉ dùng cho việc administrative.
3. **Đẩy task sang DONE mà chưa duyệt worklog cuối**. Số liệu `totalHours` sai → estimate kỳ sau sai.
4. **Tạo "Task khổng lồ" estimate > 40h**. Khó track tiến độ. Tách thành 2–3 task ≤ 16h/task.
5. **Sửa task description xoá luôn dòng "Phụ thuộc: #X"**. Đây là cách duy nhất hệ thống đang lưu dependency — xoá là mất thông tin.
6. **Bỏ qua risk digest**. Cron 18:30 gửi nhưng PM không đọc → agent trở thành tiếng ồn, sau này không tin.

---

## 9. Lộ trình nâng cấp (Roadmap rút gọn)

| Hạng mục | Trạng thái | Ưu tiên |
|---|---|---|
| Planning Agent v1 | ✅ Done | — |
| Risk Analyzer + digest | ✅ Done | — |
| TaskDependency table thật (thay text trong description) | 🔲 | P1 |
| Auto-update Scope khi đổi estimate trong chat | 🔲 | P2 |
| Re-plan: cho phép `/plan resume #N` để bổ sung epic/task | 🔲 | P2 |
| Capacity planning (workload forecast theo Member) | 🔲 | P3 |
| Velocity dashboard burn-down theo Milestone | 🔲 | P3 |

---

## 10. Phụ lục — Glossary

| Thuật ngữ | Định nghĩa |
|---|---|
| **Agent** | Service phần mềm tự động hoá tương tác — Planning hoặc Daily Execution |
| **Backlog** | Bản ghi worklog 1 ngày của 1 user (table tên là `backlogs`) |
| **Blocker** | Vướng mắc làm task không tiến triển được |
| **Brief** | Mô tả ngắn dự án Manager đưa cho Planning Agent ở bước đầu |
| **Draft Plan** | Kế hoạch LLM đề xuất, chưa materialize thành entity thật |
| **Epic** | Trong hệ này = Milestone (nhóm task theo phase) |
| **Materialize** | Hành động biến draft plan thành Project/Milestone/Task/Scope thật |
| **Roster** | Danh sách user khả dụng + open_tasks, để LLM gợi ý assignee |
| **Roll-up** | Tự cộng dồn số liệu từ entity con lên cha (backlog → task → project) |
| **Scope** | Mục estimate gắn 1 task — chứa `estimatedHours` |
| **Stale** | Task IN_PROGRESS nhưng không có worklog ≥ 3 ngày |
| **State machine** | Bộ trạng thái + transition — dùng cho checkin & planning flow |

---

*Phiên bản 1.0 — 2026-05-20. Đề nghị review lại sau mỗi sprint nếu workflow đổi.*
