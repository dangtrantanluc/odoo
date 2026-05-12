# PM Operations Agent — Runbook

Hướng dẫn vận hành đầy đủ: setup từ đầu, chạy hằng ngày, troubleshoot.

> Tham chiếu thiết kế: [PMOperationsAgent.md](./PMOperationsAgent.md) · Trạng thái: [PROCESS.md](./PROCESS.md) · Project context: [CLAUDE.md](./CLAUDE.md)

---

## 1. Tổng quan kiến trúc cần chạy

```
                            ┌─ User local browser ─┐
                            │ http://localhost:6080 │
                            └──────────┬────────────┘
                                       │ SSH tunnel
                                       ▼
┌──────────────────────────── SERVER (124.158.15.142) ────────────────┐
│                                                                      │
│  ┌─ noVNC/x11vnc/Xvfb (systemd user) ─┐  → cho bạn xem Chromium     │
│  │  :6080 (web), :5900 (vnc), :99 (X) │                              │
│  └────────────────────────────────────┘                              │
│                                                                      │
│  ┌─ OpenClaw gateway :18789 (systemd user) ─────────────────────┐   │
│  │  ┌─ bb-pm-tools plugin ──────┐  /api/plugins/bb-pm/agent/run │   │
│  │  ├─ gapo-work plugin ────────┤  /api/plugins/gapo-work/...   │   │
│  │  └─ browser-tools plugin ────┘  /api/plugins/browser-tools/* │   │
│  │     ├─ Watcher (auto-start)                                  │   │
│  │     └─ Headed Chromium → Xvfb :99                            │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌─ Postgres :5433 (Docker) ─────────────────────────────────────┐  │
│  │  bb_pm DB                                                     │  │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌─ bb-pm API :4000 (pnpm dev hoặc systemd) ─────────────────────┐  │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌─ Qwen LLM :8000 (host khác hoặc local) ───────────────────────┐  │
│  │  http://100.108.110.17:8000/v1                                │  │
│  └──────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

3 layers cần biết:

- **Hạ tầng** (Postgres, Xvfb stack, gateway) — systemd, run forever
- **API** (bb-pm) — có thể `pnpm dev` hoặc systemd
- **Agent** (watcher trong browser-tools plugin) — auto-start theo gateway

---

## 2. Setup lần đầu (chỉ làm 1 lần)

### 2.1 Yêu cầu hệ thống

| Cần có | Verify |
|---|---|
| Ubuntu 22.04+ / Debian 12+ | `lsb_release -a` |
| Node.js 22+ | `node --version` |
| pnpm | `pnpm --version` |
| Docker + Docker Compose | `docker compose version` |
| Sudo quyền (để install apt packages) | `sudo -v` |

### 2.2 Cài system packages

```bash
# Playwright Chromium runtime libs
sudo apt update && sudo apt install -y \
  libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 \
  libxkbcommon0 libatspi2.0-0t64 libxcomposite1 libxdamage1 libxfixes3 \
  libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2t64

# Virtual display + remote viewer (cho headed Chromium trên server)
sudo apt install -y xvfb x11vnc novnc websockify
```

### 2.3 Clone code + install deps

```bash
cd /home/bbsw
# git clone <repo> pm  (skip nếu đã có)
cd pm

# bb-pm (API + DB)
cd bb-pm && pnpm install && cd ..

# bb-pm-tools (orchestrator plugin)
cd bb-pm-tools && pnpm install && cd ..

# gapo-work (channel adapter — sub-folder của openclaw)
cd openclaw/openclaw && pnpm install && cd ../..

# browser-tools (Playwright watcher + actions)
cd browser-tools && pnpm install && pnpm exec playwright install chromium && cd ..
```

### 2.4 Build TypeScript cho 3 plugins

```bash
cd /home/bbsw/pm/bb-pm-tools && node node_modules/typescript/bin/tsc
cd /home/bbsw/pm/openclaw/openclaw/plugins/gapo-work && node ../../node_modules/typescript/bin/tsc
cd /home/bbsw/pm/browser-tools && node node_modules/typescript/bin/tsc
```

### 2.5 Khởi động Postgres + bb-pm API

```bash
cd /home/bbsw/pm/bb-pm

# Start Postgres :5433
docker compose up bb_pm_db -d

# Apply migrations + seed
pnpm --filter @bb-pm/api prisma migrate deploy
pnpm --filter @bb-pm/api prisma db seed
```

### 2.6 Tạo các secret + env file

```bash
# Generate 3 shared secrets
AGENT_TOKEN=$(openssl rand -hex 32)        # bb-pm ↔ bb-pm-tools
BROWSER_TOKEN=$(openssl rand -hex 32)      # bb-pm-tools ↔ browser-tools
GAPO_SEND_TOKEN=$(openssl rand -hex 32)    # bb-pm-tools ↔ gapo-work

echo "AGENT_TOKEN=$AGENT_TOKEN"
echo "BROWSER_TOKEN=$BROWSER_TOKEN"
echo "GAPO_SEND_TOKEN=$GAPO_SEND_TOKEN"
# LƯU 3 GIÁ TRỊ NÀY — sẽ paste vào nhiều file
```

#### File 1: `bb-pm/.env`

```env
DATABASE_URL=postgresql://bbpm:bbpm@localhost:5433/bb_pm
JWT_SECRET=<openssl rand -hex 32>
AGENT_API_TOKEN=<AGENT_TOKEN trên>
AGENT_USER_EMAIL=pm-agent@bluebolt.local
```

#### File 2: `~/.openclaw/plugins/bb-pm-tools/.env`

```env
BB_PM_API_URL=http://localhost:4000/api/v1
BB_PM_AGENT_TOKEN=<AGENT_TOKEN>

LLM_BASE_URL=http://100.108.110.17:8000/v1
LLM_API_KEY=nokey
LLM_MODEL=Qwen/Qwen3.6-27B-FP8
LLM_MAX_TOKENS=2048
LLM_TEMPERATURE=0.2

AGENT_MAX_STEPS=5

GAPO_SEND_URL=http://localhost:18789/api/plugins/gapo-work/send
GAPO_SEND_TOKEN=<GAPO_SEND_TOKEN>

BROWSER_TOOLS_TOKEN=<BROWSER_TOKEN>
BROWSER_TOOLS_SEND_URL=http://localhost:18789/api/plugins/browser-tools/send-dm
BROWSER_TOOLS_FIND_URL=http://localhost:18789/api/plugins/browser-tools/find-user
```

#### File 3: `~/.openclaw/plugins/gapo-work/config.json`

```json
{
  "gapo": {
    "apiUrl": "https://api.gapowork.vn/3rd-bot/v1.0/3rd/messages",
    "botToken": "(unused — chuyển sang user account)",
    "botId": "0"
  },
  "orchestrator": {
    "url": "http://localhost:18789/api/plugins/bb-pm/agent/run",
    "timeoutMs": 90000
  },
  "sendToken": "<GAPO_SEND_TOKEN>"
}
```

#### File 4: `~/.openclaw/plugins/browser-tools/.env`

```env
GAPO_WORK_URL=https://www.gapowork.vn
BROWSER_HEADLESS=0
BROWSER_DISPLAY=:99
BROWSER_SLOWMO_MS=0
BROWSER_TOOLS_TOKEN=<BROWSER_TOKEN>
BROWSER_MAX_DMS_PER_HOUR=30
BROWSER_TOOLS_AUTO_START_WATCHER=1
```

### 2.7 Setup hạ tầng systemd (Xvfb + VNC + gateway)

```bash
mkdir -p ~/.config/systemd/user

# Xvfb — virtual X display
cat > ~/.config/systemd/user/xvfb.service <<'EOF'
[Unit]
Description=Xvfb virtual display :99
After=default.target
[Service]
Type=simple
ExecStart=/usr/bin/Xvfb :99 -screen 0 1280x800x24 +extension RANDR
Restart=always
RestartSec=5
[Install]
WantedBy=default.target
EOF

# x11vnc — expose Xvfb qua VNC (bind localhost only)
cat > ~/.config/systemd/user/x11vnc.service <<'EOF'
[Unit]
Description=x11vnc bridge to Xvfb :99
Requires=xvfb.service
After=xvfb.service
[Service]
Type=simple
ExecStart=/usr/bin/x11vnc -display :99 -forever -nopw -localhost -shared -quiet
Restart=always
RestartSec=5
[Install]
WantedBy=default.target
EOF

# noVNC — web bridge (truy cập từ browser qua SSH tunnel)
cat > ~/.config/systemd/user/novnc.service <<'EOF'
[Unit]
Description=noVNC web bridge :6080
Requires=x11vnc.service
After=x11vnc.service
[Service]
Type=simple
ExecStart=/usr/bin/websockify --web=/usr/share/novnc 127.0.0.1:6080 localhost:5900
Restart=always
RestartSec=5
[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now xvfb x11vnc novnc

# Verify
systemctl --user status xvfb x11vnc novnc | grep Active
```

### 2.8 Install OpenClaw plugins

```bash
openclaw plugins install --link --dangerously-force-unsafe-install /home/bbsw/pm/bb-pm-tools
openclaw plugins install --link /home/bbsw/pm/openclaw/openclaw/plugins/gapo-work
openclaw plugins install --link --dangerously-force-unsafe-install /home/bbsw/pm/browser-tools

openclaw gateway restart
sleep 8
openclaw gateway status
```

### 2.9 Login Gapo Work bằng Playwright (1 lần)

**Trên máy local của bạn**, tạo SSH tunnel:

```bash
ssh -L 6080:localhost:6080 bbsw@124.158.15.142
```

**Trên browser local**, mở: `http://localhost:6080/vnc.html` → Connect.

**Trên server (terminal SSH)**, chạy:

```bash
cd /home/bbsw/pm/browser-tools
DISPLAY=:99 pnpm auth
```

→ Chromium hiện trong noVNC tab → login Gapo Work bằng account bot (vd Bot Project Manager) → vào tab Tin nhắn, đợi danh sách load → quay terminal bấm **ENTER** → file `storage-state.json` được tạo.

Verify:

```bash
ls -la ~/.openclaw/plugins/browser-tools/storage-state.json
# Phải có file ~10KB, mtime mới
```

---

## 3. Day-to-day — chạy hệ thống

### 3.1 Khởi động đầy đủ stack

Sau khi setup lần đầu, mọi thứ tự bật khi server boot. Verify:

```bash
cd /home/bbsw/pm
./bot-cli.sh health
```

Expected output:

```
── Systemd services ──
xvfb                 active
x11vnc               active
novnc                active
openclaw-gateway     active

── bb-pm API ──
{ "status": "ok", "checks": { "db": ..., "redis": ... } }

── Watcher ──
{ "state": "running", ... }
```

Nếu bb-pm API DOWN, start nó:

```bash
cd /home/bbsw/pm/bb-pm
pnpm --filter @bb-pm/api dev
# Hoặc viết systemd unit cho nó (xem 3.4)
```

### 3.2 Test bot phản hồi

Từ tài khoản Gapo bất kỳ (KHÔNG phải bot account), gửi DM cho bot:

```
hello
```

→ Đợi 30-90s (Qwen LLM chậm) → bot reply.

Theo dõi live:

```bash
./bot-cli.sh tail
```

### 3.3 Bot tự gửi DM cho người mới (find-and-send)

```bash
TOKEN=<BROWSER_TOOLS_TOKEN>
curl -X POST http://localhost:18789/api/plugins/browser-tools/send-dm \
  -H "X-Plugin-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"externalId":"<gapo conversation id>","text":"nhắc deadline task X"}'
```

`externalId` = conversation id (numeric trong URL `/messenger/<id>`). Lần đầu chưa biết → dùng find:

```bash
curl -X POST http://localhost:18789/api/plugins/browser-tools/find-user \
  -H "X-Plugin-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"Tên người"}'
```

### 3.4 (Optional) Systemd cho bb-pm API

Thay vì `pnpm dev`, tạo unit để auto-start:

```bash
cat > ~/.config/systemd/user/bb-pm-api.service <<'EOF'
[Unit]
Description=bb-pm API (Fastify + Prisma)
After=docker.service
[Service]
Type=simple
WorkingDirectory=/home/bbsw/pm/bb-pm
ExecStart=/home/bbsw/.nvm/versions/node/v24.14.0/bin/pnpm --filter @bb-pm/api dev
Environment="NODE_ENV=production"
Restart=always
RestartSec=10
[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now bb-pm-api
```

---

## 4. CLI cheat sheet (`bot-cli.sh`)

```bash
cd /home/bbsw/pm

./bot-cli.sh health       # tổng quan tất cả service
./bot-cli.sh status       # trạng thái watcher
./bot-cli.sh logs 30      # 30 dòng log gần nhất
./bot-cli.sh tail         # follow log realtime (Ctrl-C để thoát)
./bot-cli.sh kick         # ép re-scan, navigate page về root
./bot-cli.sh reset        # clear cooldown 30s + dedup state
./bot-cli.sh restart      # restart watcher (giữ Chromium alive)
./bot-cli.sh stop         # dừng watcher
./bot-cli.sh start        # start watcher
./bot-cli.sh send <conversationId> <text>  # gửi DM trực tiếp
```

---

## 5. Update code → deploy

Khi sửa code 1 trong 3 plugin:

```bash
# Sửa code...

# Build plugin tương ứng
cd /home/bbsw/pm/<plugin>
node node_modules/typescript/bin/tsc

# Restart gateway để load lại
openclaw gateway restart
sleep 8

# Verify watcher tự khởi động (auto-start)
./bot-cli.sh status   # state phải là "running" sau ~10-15s
```

> ⚠️ **Mỗi lần restart gateway → page Chromium bị close** → tin gửi cho bot trong window này có thể mất. Tránh restart khi đang có user chat active.

---

## 6. Troubleshooting

### "Bot không reply"

```bash
./bot-cli.sh status
```

Check theo thứ tự:

| Triệu chứng | Nguyên nhân | Fix |
|---|---|---|
| `state: stopped` | Watcher chết | `./bot-cli.sh start` |
| `state: running, errors > 0, lastError: "selector miss"` | Cookies expire | Re-run `pnpm auth` |
| `state: running, errors > 0, lastError: "Target page closed"` | Chromium crash → đang restart | Đợi 10-30s, check lại |
| `state: running, hitsSeen > 0, replied = 0` | Stuck queue hoặc LLM treo | `./bot-cli.sh tail` xem log |
| `skippedCooldown` tăng | Tin gửi trong 30s sau reply trước | `./bot-cli.sh reset` |
| `skippedGroupNoMention` tăng | Tin từ group, không @mention | Đúng behavior, không phải bug |
| `hitsSeen = 0` dù bạn gửi DM | Page Chromium đang ở conversation đó → Gapo auto-mark read | `./bot-cli.sh kick` |

### "noVNC không connect được"

```bash
systemctl --user status xvfb x11vnc novnc | grep Active
# Cả 3 phải active

# Nếu fail:
systemctl --user restart xvfb x11vnc novnc
sleep 3

# Verify port:
ss -ltn | grep -E "5900|6080"

# Verify SSH tunnel local của bạn còn alive
```

### "Gateway crash hoặc plugin error"

```bash
journalctl --user -u openclaw-gateway -n 100 --no-pager | tail -50
# Tìm dòng [error] hoặc Stack trace

# Restart sạch
openclaw gateway restart
sleep 10
./bot-cli.sh health
```

### "LLM Qwen down"

```bash
curl -m 5 http://100.108.110.17:8000/v1/models
# Phải trả 200

# Nếu fail, liên hệ team quản lý LLM server
```

### "bb-pm API không chạy được"

```bash
# Check Postgres trước
docker ps | grep bb_pm_db
# Phải Up

# Apply lại migration nếu schema lệch
cd /home/bbsw/pm/bb-pm
pnpm --filter @bb-pm/api prisma migrate deploy

# Start API
pnpm --filter @bb-pm/api dev
```

---

## 7. Cookies expire — re-authentication

Gapo cookies thường expire sau 1-4 tuần. Triệu chứng:

- `lastError` chứa "navigation timeout" hoặc "selector miss"
- Bot không bao giờ reply

Re-auth:

```bash
# Setup SSH tunnel (như bước 2.9)
# Trên server:
cd /home/bbsw/pm/browser-tools

# Optional: backup state cũ
mv ~/.openclaw/plugins/browser-tools/storage-state.json{,.bak}

DISPLAY=:99 pnpm auth
# Login lại trong noVNC, ENTER ở terminal

# Restart watcher để load state mới
./bot-cli.sh restart
```

---

## 8. Files quan trọng — biết để debug

| Path | Vai trò |
|---|---|
| `/home/bbsw/pm/CLAUDE.md` | Project overview |
| `/home/bbsw/pm/PROCESS.md` | Sprint log, decisions |
| `/home/bbsw/pm/RUNBOOK.md` | File này — vận hành |
| `/home/bbsw/pm/bot-cli.sh` | CLI helper |
| `/home/bbsw/pm/browser-tools/src/watcher.ts` | Logic watch + reply |
| `/home/bbsw/pm/browser-tools/src/gapo-actions.ts` | UI selector + actions |
| `~/.openclaw/plugins/<plugin>/.env` | Runtime config + secrets |
| `~/.openclaw/plugins/browser-tools/storage-state.json` | Gapo session cookies |
| `~/.config/systemd/user/*.service` | Auto-start units |
| `journalctl --user -u openclaw-gateway` | Gateway + plugin logs |
| `/tmp/openclaw/openclaw-<date>.log` | File log structured JSON |

---

## 9. Các giới hạn hiện tại + roadmap

### Hiện đã chạy

- ✅ Bot user-impersonation reply DM/group mention via Playwright
- ✅ Auto-restart full stack khi reboot
- ✅ Self-heal page crash
- ✅ CLI control + monitoring
- ✅ 17 LLM tools (digest, hygiene, blockers, follow-up, weekly report...)

### Chưa làm (xem [PROCESS.md §8](./PROCESS.md))

- ⏳ pgvector cho semantic memory recall
- ⏳ Gmail delivery cho weekly report
- ⏳ Whisper audio transcription
- ⏳ Multi-channel (Slack/Zalo/Telegram)
- ⏳ Streaming LLM responses (giảm perceived latency)
- ⏳ Health-check cron alert
- ⏳ Cookies-expire auto-detect + alert

---

## 10. Lookup nhanh

### Endpoint quan trọng (cần `X-Plugin-Token` header)

| Path | Method | Mô tả |
|---|---|---|
| `/api/plugins/browser-tools/health` | GET | Liveness + auth state |
| `/api/plugins/browser-tools/watcher/start` | POST | Boot watcher |
| `/api/plugins/browser-tools/watcher/stop` | POST | Dừng watcher |
| `/api/plugins/browser-tools/watcher/status` | GET | Stats + state |
| `/api/plugins/browser-tools/watcher/reset` | POST | Clear cooldown + dedup |
| `/api/plugins/browser-tools/watcher/kick` | POST | Force re-scan |
| `/api/plugins/browser-tools/find-user` | POST | Search Gapo org (tên match) |
| `/api/plugins/browser-tools/find-and-open-dm` | POST | Search + click DM icon → trả conversationId |
| `/api/plugins/browser-tools/send-dm` | POST | Gửi DM qua browser |
| `/api/plugins/bb-pm/agent/run` | POST | Gọi LLM (no auth) |

### Ports

| Port | Service | Bind |
|---|---|---|
| 4000 | bb-pm API | 0.0.0.0 |
| 5433 | Postgres | localhost (Docker) |
| 5900 | x11vnc | 127.0.0.1 |
| 6080 | noVNC | 127.0.0.1 |
| 18789 | OpenClaw gateway | 0.0.0.0 |
