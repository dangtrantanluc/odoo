#!/usr/bin/env bash
set -euo pipefail

HOST="${HOST:-http://localhost:18789}"
API_HOST="${API_HOST:-http://localhost:4000}"
SMOKE_GAPO_USER_ID="${SMOKE_GAPO_USER_ID:-}"
SMOKE_THREAD_ID="${SMOKE_THREAD_ID:-}"

tmpdir="$(mktemp -d /tmp/gapo-smoke-XXXX)"
trap 'rm -rf "$tmpdir"' EXIT

json_get() {
  python3 - "$1" "$2" <<'PY'
import json, sys
path, expr = sys.argv[1], sys.argv[2]
data = json.load(open(path))
cur = data
for part in expr.split("."):
    if not part:
        continue
    if part.isdigit():
        cur = cur[int(part)]
    else:
        cur = cur[part]
print(cur if not isinstance(cur, (dict, list)) else json.dumps(cur, ensure_ascii=False))
PY
}

post_json() {
  local url="$1"
  local body="$2"
  local out="$3"
  curl -fsS -X POST "$url" -H "Content-Type: application/json" -d "$body" >"$out"
}

wait_for_url() {
  local url="$1"
  local attempts="${2:-30}"
  for _ in $(seq 1 "$attempts"); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for $url" >&2
  return 1
}

echo "== Health =="
wait_for_url "$API_HOST/api/v1/health"
wait_for_url "$HOST/api/plugins/gapo-agent/health"
wait_for_url "$HOST/api/plugins/bb-pm/health"
curl -fsS "$API_HOST/api/v1/health" >"$tmpdir/api-health.json"
curl -fsS "$HOST/api/plugins/gapo-agent/health" >"$tmpdir/gapo-health.json"
curl -fsS "$HOST/api/plugins/bb-pm/health" >"$tmpdir/bbpm-health.json"
echo "api=$(json_get "$tmpdir/api-health.json" "status") gapo=$(json_get "$tmpdir/gapo-health.json" "ok") bbpm=$(json_get "$tmpdir/bbpm-health.json" "status")"

echo
echo "== Webhook payload samples =="
post_json "$HOST/api/plugins/gapo-agent/webhook" \
  '{"event":"thread_created","thread_id":1664252906628,"from_user_id":1147591,"to_bot_id":5828463533626526000}' \
  "$tmpdir/thread-created.json"
post_json "$HOST/api/plugins/gapo-agent/webhook" \
  '{"id":"smoke-text-1","event":"message_created","thread_id":1664241127733,"from_user_id":1193582742,"message":{"id":"3","text":"/help","type":"text","payload":null}}' \
  "$tmpdir/message-text.json"
post_json "$HOST/api/plugins/gapo-agent/webhook" \
  '{"id":"smoke-quick-1","event":"message_created","thread_id":1663642842110,"from_user_id":1147591,"message":{"id":"100","text":"/help","type":"quick_reply","payload":"SMOKE:1"}}' \
  "$tmpdir/message-quick.json"
post_json "$HOST/api/plugins/gapo-agent/webhook" \
  '{"id":"smoke-group-ignore-1","event":"message_created","thread_id":7001,"to_bot_id":99,"message":{"id":"7","text":"moi nguoi update nhe","type":"text","thread":{"id":7001,"type":"group"},"metadata":{"mentions":[]}}}' \
  "$tmpdir/group-ignore.json"
post_json "$HOST/api/plugins/gapo-agent/webhook" \
  '{"id":"smoke-group-mention-1","event":"message_created","thread_id":7001,"to_bot_id":99,"message":{"id":"8","text":"/help","type":"text","thread":{"id":7001,"type":"group"},"metadata":{"mentions":[{"target":99,"length":0,"offset":0}]}}}' \
  "$tmpdir/group-mention.json"
post_json "$HOST/api/plugins/gapo-agent/webhook" \
  '{"id":"smoke-file-1","event":"message_created","thread_id":1664241127733,"from_user_id":1193582742,"message":{"id":"6","text":"caption","type":"file"}}' \
  "$tmpdir/message-file.json"
echo "thread_created processed=$(json_get "$tmpdir/thread-created.json" "processed")"
echo "group_without_mention processed=$(json_get "$tmpdir/group-ignore.json" "processed")"
echo "file processed=$(json_get "$tmpdir/message-file.json" "processed")"

if [[ -z "$SMOKE_GAPO_USER_ID" || -z "$SMOKE_THREAD_ID" ]]; then
  echo
  echo "== Check-in flow skipped =="
  echo "Set SMOKE_GAPO_USER_ID and SMOKE_THREAD_ID to exercise the mapped-user flow."
else
  echo
  echo "== Check-in flow =="
  post_json "$HOST/api/plugins/bb-pm/agent/run" \
    "{\"source\":\"chat\",\"conversationId\":\"gapo:${SMOKE_THREAD_ID}\",\"externalId\":\"${SMOKE_GAPO_USER_ID}\",\"correlationId\":\"smoke-checkin-start\",\"text\":\"/checkin\",\"metadata\":{\"threadId\":\"${SMOKE_THREAD_ID}\"}}" \
    "$tmpdir/checkin-start.json"
  project_payload="$(json_get "$tmpdir/checkin-start.json" "channelReply.metadata.options.0.payload")"
  project_title="$(json_get "$tmpdir/checkin-start.json" "channelReply.metadata.options.0.title")"
  post_json "$HOST/api/plugins/bb-pm/agent/run" \
    "{\"source\":\"chat\",\"conversationId\":\"gapo:${SMOKE_THREAD_ID}\",\"externalId\":\"${SMOKE_GAPO_USER_ID}\",\"correlationId\":\"smoke-checkin-project\",\"text\":\"${project_title}\",\"metadata\":{\"threadId\":\"${SMOKE_THREAD_ID}\",\"payload\":\"${project_payload}\"}}" \
    "$tmpdir/checkin-project.json"
  post_json "$HOST/api/plugins/bb-pm/agent/run" \
    "{\"source\":\"chat\",\"conversationId\":\"gapo:${SMOKE_THREAD_ID}\",\"externalId\":\"${SMOKE_GAPO_USER_ID}\",\"correlationId\":\"smoke-checkin-update\",\"text\":\"hom nay toi fix login 2h, da xong nhung ket API timeout\",\"metadata\":{\"threadId\":\"${SMOKE_THREAD_ID}\"}}" \
    "$tmpdir/checkin-update.json"
  fast_path="$(json_get "$tmpdir/checkin-update.json" "fastPath")"
  if [[ "$fast_path" == "checkin:choose_task" ]]; then
    task_payload="$(json_get "$tmpdir/checkin-update.json" "channelReply.metadata.options.0.payload")"
    task_title="$(json_get "$tmpdir/checkin-update.json" "channelReply.metadata.options.0.title")"
    post_json "$HOST/api/plugins/bb-pm/agent/run" \
      "{\"source\":\"chat\",\"conversationId\":\"gapo:${SMOKE_THREAD_ID}\",\"externalId\":\"${SMOKE_GAPO_USER_ID}\",\"correlationId\":\"smoke-checkin-task\",\"text\":\"${task_title}\",\"metadata\":{\"threadId\":\"${SMOKE_THREAD_ID}\",\"payload\":\"${task_payload}\"}}" \
      "$tmpdir/checkin-task.json"
    fast_path="$(json_get "$tmpdir/checkin-task.json" "fastPath")"
  fi
  echo "checkin_result=$fast_path"
fi

echo
echo "== Metrics =="
curl -fsS "$HOST/api/plugins/bb-pm/agent/metrics" >"$tmpdir/metrics.json"
python3 -m json.tool "$tmpdir/metrics.json"
