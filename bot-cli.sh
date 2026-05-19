#!/bin/bash
# Quick CLI for the PM bot watcher. Usage:
#   ./bot-cli.sh status
#   ./bot-cli.sh logs [N]   # last N lines (default 20)
#   ./bot-cli.sh tail       # follow logs live
#   ./bot-cli.sh reset      # clear cooldowns + dedup state
#   ./bot-cli.sh kick       # force re-scan now
#   ./bot-cli.sh restart    # stop + start watcher
#   ./bot-cli.sh stop
#   ./bot-cli.sh start
#   ./bot-cli.sh health     # all systemd services + watcher
#   ./bot-cli.sh send <conversationId> <text>   # send DM directly

set -e
# Load local secrets when running from the repo root.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

TOKEN="${BROWSER_TOOLS_TOKEN:-${GAPO_SEND_TOKEN:-}}"
if [ -z "$TOKEN" ]; then
  echo "Missing BROWSER_TOOLS_TOKEN or GAPO_SEND_TOKEN"
  exit 1
fi
HOST="${HOST:-http://localhost:18789}"
HDR=(-H "X-Plugin-Token: $TOKEN" -H "Content-Type: application/json")

call() { curl -sS "${HDR[@]}" "$@"; echo; }
post() { call -X POST "$HOST/api/plugins/browser-tools/$1"; }
get()  { call "$HOST/api/plugins/browser-tools/$1"; }

case "${1:-status}" in
  status)
    get watcher/status | python3 -m json.tool
    ;;
  logs)
    N="${2:-20}"
    journalctl --user -u openclaw-gateway --no-pager 2>/dev/null \
      | grep -E "\[watcher\]|\[bb-pm-tools\] agent/run|cid=|tookMs" \
      | tail -"$N"
    ;;
  tail)
    journalctl --user -u openclaw-gateway -f 2>/dev/null \
      | grep --line-buffered -E "\[watcher\]|cid=|tookMs|sendReply"
    ;;
  reset)
    post watcher/reset | python3 -m json.tool
    ;;
  kick)
    post watcher/kick | python3 -m json.tool
    ;;
  start)
    post watcher/start | python3 -m json.tool
    ;;
  stop)
    post watcher/stop | python3 -m json.tool
    ;;
  restart)
    post watcher/stop > /dev/null
    sleep 2
    post watcher/start | python3 -m json.tool
    ;;
  health)
    echo "── Systemd services ──"
    for s in xvfb x11vnc novnc openclaw-gateway; do
      printf "%-20s %s\n" "$s" "$(systemctl --user is-active "$s.service" 2>/dev/null)"
    done
    echo
    echo "── bb-pm API ──"
    curl -s -m 3 http://localhost:4000/api/v1/health 2>/dev/null | python3 -m json.tool || echo "DOWN"
    echo
    echo "── Watcher ──"
    get watcher/status | python3 -m json.tool
    ;;
  send)
    if [ -z "$2" ] || [ -z "$3" ]; then
      echo "usage: $0 send <conversationId> <text>"
      exit 1
    fi
    curl -sS "${HDR[@]}" -X POST "$HOST/api/plugins/browser-tools/send-dm" \
      -d "$(python3 -c "import json,sys; print(json.dumps({'externalId':'$2','text':'$3'}))")"
    echo
    ;;
  *)
    echo "Unknown command: $1"
    echo "Try: status | logs [N] | tail | reset | kick | start | stop | restart | health | send"
    exit 1
    ;;
esac
