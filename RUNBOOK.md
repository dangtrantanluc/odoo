# GapoWork PM Agent - Release Runbook

Runbook nay mo ta duong production noi bo duy nhat:

```text
GapoWork -> gapo-agent -> bb-pm-tools -> bb-pm API -> Postgres
```

Python `/agent` chi la prototype/sandbox, khong nam trong production path.

## 1. Stack can chay

`docker-compose.yaml` root chay 5 service:

| Service | Vai tro | Port host |
| --- | --- | --- |
| `bb_pm_db` | Postgres | `5433` |
| `bb_pm_redis` | Redis cho cooldown/rate limit | `6379` |
| `bb_pm_api` | Fastify + Prisma backend | `4000` |
| `bb_pm_web` | React UI | `5173` |
| `openclaw` | Gateway chua `gapo-agent` + `bb-pm-tools` | `18789` |

Public webhook chuan:

```text
POST /api/plugins/gapo-agent/webhook
```

Health endpoints chuan:

```text
GET /api/plugins/gapo-agent/health
GET /api/plugins/bb-pm/health
GET /api/v1/health
```

## 2. Chuan bi env

```bash
cd /home/bbsw/pm
cp .env.docker.example .env
```

Bat buoc dien:

```env
AGENT_API_TOKEN=<openssl rand -hex 32>
GAPO_SEND_TOKEN=<openssl rand -hex 32>
JWT_SECRET=<secret manh>
GAPO_BOT_TOKEN=<token bot GapoWork>
GAPO_BOT_ID=<bot id>
LLM_BASE_URL=<openai-compatible endpoint>
LLM_API_KEY=<neu can>
LLM_MODEL=<model id>
```

Token phai khop:

- `AGENT_API_TOKEN` tren `bb_pm_api` = `BB_PM_AGENT_TOKEN` trong `bb-pm-tools`
- `GAPO_SEND_TOKEN` dung chung cho `gapo-agent` va `bb-pm-tools`

Cho local smoke test khong cham Gapo that:

```env
GAPO_DRY_RUN=true
CRON_CHECKIN_ENABLED=false
```

Cho staging/prod that:

```env
GAPO_DRY_RUN=false
CRON_CHECKIN_ENABLED=false
```

Cron check-in de tat o lan deploy dau. Chi bat sau khi smoke test bot that dat:

```env
CRON_CHECKIN_ENABLED=true
CRON_NOON_CHECKIN=50 11 * * 1-5
CRON_EOD_CHECKIN=50 17 * * 1-5
CRON_MISSING_CHECKIN_FOLLOWUP=0 18 * * 1-5
```

## 3. Deploy lan dau

```bash
cd /home/bbsw/pm
docker compose up -d --build
cd /home/bbsw/pm/bb-pm
pnpm --filter @bb-pm/api prisma db seed
```

`bb_pm_api` tu chay `prisma migrate deploy` luc boot. Seed chay tu host repo vi runtime image API la image toi gian; can chay it nhat mot lan de co agent user.

Kiem tra stack:

```bash
curl http://localhost:4000/api/v1/health
curl http://localhost:18789/api/plugins/gapo-agent/health
curl http://localhost:18789/api/plugins/bb-pm/health
```

Neu dung volume cu, entrypoint OpenClaw se tu dam bao ca `gapo-agent` va `bb-pm-tools` deu duoc enable.

## 4. Test code truoc release

```bash
cd /home/bbsw/pm/gapo-agent
pnpm test && pnpm typecheck && pnpm build

cd /home/bbsw/pm/bb-pm-tools
pnpm test && pnpm typecheck && pnpm build

cd /home/bbsw/pm/bb-pm
pnpm --filter @bb-pm/api prisma generate
pnpm --filter @bb-pm/api lint
pnpm --filter @bb-pm/api build
```

## 5. Local smoke test, chua can bot that

Dat `GAPO_DRY_RUN=true`, build lai `openclaw`, roi chay:

```bash
cd /home/bbsw/pm
docker compose up -d --build openclaw
./scripts/gapo-local-smoke.sh
```

Script kiem tra:

- health cua API + 2 plugin
- payload `thread_created`
- `message_created:text`
- `message_created:quick_reply`
- group co mention / khong mention
- file khong text
- metrics cua `bb-pm-tools`

De test full check-in flow, can mot user da map trong DB:

```bash
SMOKE_GAPO_USER_ID=<gapo_user_id> \
SMOKE_THREAD_ID=<thread_id> \
./scripts/gapo-local-smoke.sh
```

Script sẽ tự lấy quick reply project đầu tiên trong nhóm 3 project gần đây, gửi update mẫu, và nếu cần thì chọn task đầu tiên để tạo backlog.

## 6. Staging voi bot test that

1. Dung bot test rieng.
2. Public gateway bang reverse proxy/TLS hoac tunnel.
3. Cau hinh webhook URL tren GapoWork:

```text
https://<public-host>/api/plugins/gapo-agent/webhook
```

4. Smoke test bat buoc:
   - hoi task qua han
   - `/checkin`
   - chọn 1 trong 3 project gần đây bằng quick reply/số, hoặc nhập tên project khác
   - gui update co blocker
   - chon task neu co nhieu task
   - `/report`
   - group mention bot
   - duplicate webhook/retry
   - downstream fail nhung webhook van tra ack hop le

5. Kiem tra outbound Gapo:
   - text gui duoc
   - quick replies gui duoc
   - moi request chi co dung mot trong `thread_id | receiver_id | collab_id`

## 6.1. Flow `/checkin` cần xác nhận khi smoke test

Prompt đầu phiên phải có dạng recent-first, không đổ toàn bộ project ra màn hình:

```text
Hôm nay bạn làm project nào?

Gần đây:
1. ...
2. ...
3. ...

Hoặc nhập tên project khác.
```

Người dùng phải chọn được bằng quick reply, bằng số và bằng cách gõ tên project khác ngoài 3 gợi ý. Flow hợp lệ:

```text
AWAITING_PROJECT -> AWAITING_UPDATE -> COMPLETED
```

Khi debug `/checkin`, kiểm tra lần lượt: mapping Gapo của user, open task được assign, session hiện tại, LLM parse fallback và cờ `CRON_CHECKIN_ENABLED` nếu đang test reminder.

## 7. Test automation truoc khi bat cron

Chay one-shot workflow bang CLI:

```bash
cd /home/bbsw/pm/bb-pm-tools
pnpm cli --workflow noon_checkin_reminder
pnpm cli --workflow eod_checkin_reminder
pnpm cli --workflow missing_checkin_followup
```

Xac nhan:

- user da check-in khong bi nhac
- session dang mo khong bi nhac lap
- user khong co Gapo thread duoc audit/skip
- missing check-in hien dung trong report

Chi sau khi qua cac buoc tren moi doi:

```env
CRON_CHECKIN_ENABLED=true
```

roi recreate `openclaw`:

```bash
docker compose up -d --build openclaw
```

## 8. Go-live noi bo

1. Dat `GAPO_DRY_RUN=false`.
2. Verify health endpoints deu xanh.
3. Chuyen webhook cua bot production sang endpoint moi.
4. Lap lai smoke test bot that.
5. Bat `CRON_CHECKIN_ENABLED=true`.
6. Theo doi ngay dau:
   - send success rate
   - parse failure
   - backlog create
   - missing check-in
   - tool error
   - LLM timeout

Metrics/audit huu ich:

```bash
curl http://localhost:18789/api/plugins/bb-pm/agent/metrics
TOKEN=$(grep '^AGENT_API_TOKEN=' .env | cut -d= -f2-)
curl -H "X-Agent-Token: $TOKEN" http://localhost:4000/api/v1/agent/audit/stats
```

## 9. Rollback va rotate token

Rollback:

```bash
git checkout <last-good-release>
docker compose up -d --build
```

Giu nguyen webhook URL neu endpoint path khong doi. Neu nghi lo token:

1. tao `GAPO_SEND_TOKEN` moi
2. cap nhat `.env`
3. recreate `openclaw`
4. kiem tra lai 2 health endpoint plugin

Khi debug, xem log:

```bash
docker compose logs -f openclaw
docker compose logs -f bb_pm_api
docker compose logs --tail 100 bb_pm_db
```
