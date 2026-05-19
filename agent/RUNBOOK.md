# GapoWork PM Agent - Release Runbook

Runbook nay mo ta duong production noi bo hien tai:

```text
GapoWork -> gapo-agent -> bb-pm-tools -> bb-pm API -> Postgres
```

Python agent trong workspace nay chi la sandbox/prototype, khong phai production path.

## Stack dang chay

- `bb_pm_db`
- `bb_pm_redis`
- `bb_pm_api`
- `bb_pm_web`
- `openclaw`

Public webhook can cau hinh:

```text
https://open-claw.maximus-nhon.online/api/plugins/gapo-agent/webhook
```

Health endpoints can xanh:

```text
bb-pm API: ok
gapo-agent: ok
bb-pm-tools: ok
```

## Things da duoc xu ly

- Da dung runtime cu chiem port `4000` va `18789`.
- Volume cu cua OpenClaw co state `gapo-work`, da bo load loi plugin.
- `bb-pm-tools` va `gapo-agent` tung bi load trung, co the lam scheduler chay doi.
- Smoke script da duoc lam cung hon khi gateway chua boot xong.
- Seed da chuyen sang chay tu host repo, khong phu thuoc runtime image.

## Smoke test bot that

Thu tu test:

1. Gui `/checkin`
2. Chọn 1 trong 3 project gần đây bằng quick reply/số, hoặc nhập tên project khác
3. Gửi update
4. Gui `/report`

`/checkin` la lenh chat, khong phai endpoint hien UI rieng. Ket qua se hien trong hop chat, con log chi nam trong container/service log.

Neu muon xem log, dung:

```bash
docker compose logs -f openclaw
```

Neu gui `/checkin` ma khong thay quick reply hoac reply, thu lai voi user da duoc map va co it nhat 1 open task.

Nếu muốn test nhanh, dùng bot test và quan sát prompt recent-first:

```text
Hôm nay bạn làm project nào?

Gần đây:
1. ...
2. ...
3. ...

Hoặc nhập tên project khác.
```

## Bat reminder sau khi smoke on

Chi bat sau khi bot that da on:

```env
CRON_CHECKIN_ENABLED=true
```

Sau do recreate `openclaw`:

```bash
docker compose up -d --force-recreate openclaw
```

## Luu y

- `GAPO_DRY_RUN=false` nghia la stack da san sang gui that.
- Reminder check-in van phai tat trong rollout dau.
- Production path hien tai la `gapo-agent -> bb-pm-tools`, khong con dung container cu `openclaw-gapo-agent`.


## Debug check-in

- Flow hiện tại: `AWAITING_PROJECT -> AWAITING_UPDATE -> COMPLETED`.
- Nếu không thấy prompt, kiểm tra user đã map Gapo identity và có ít nhất 1 task open được assign.
- Nếu reminder không gửi, kiểm tra `CRON_CHECKIN_ENABLED`, user có session đang mở hay chưa, và log `checkin.reminder_*`.
- Nếu parse update thất bại, xem telemetry `parseFallback`; plugin vẫn có regex fallback để không gãy flow.


## Prototype code map

`agent/` không nằm trong production path, nhưng sandbox Python hiện được tổ chức theo boundary rõ ràng để dễ thử nghiệm:

```text
app/             FastAPI app + HTTP routes
core/            config
services/        check-in / reminder business flow
infrastructure/  bb-pm, Gapo, LLM clients
domain/          schemas và domain types
```

Các file Python ở root (`main.py`, `bbpm_client.py`, ...) chỉ là shim tương thích; code mới nên import từ package canonical ở trên.
