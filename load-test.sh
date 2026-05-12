#!/bin/bash
# Load test: simulate N concurrent users hitting /agent/run.
# Measures per-request latency + aggregate stats.
#
# This does NOT send any message to Gapo — only stresses the LLM +
# tool-call pipeline at bb-pm-tools layer.

set -u
N="${1:-10}"           # concurrency
ENDPOINT="${ENDPOINT:-http://localhost:18789/api/plugins/bb-pm/agent/run}"
OUTDIR="$(mktemp -d /tmp/loadtest-XXXX)"

echo "▶ Load test: N=$N concurrent /agent/run requests"
echo "  Output dir: $OUTDIR"
echo

# 10 real conversation ids from imported users (each = different caller)
CIDS=(
  "1777433976678"   # Đặng Trần Tấn Lực (MEMBER)
  "1777432856955"   # Võ Trọng Nhơn (MEMBER)
  "1777879269251"   # Nguyễn Đình Thanh (MANAGER, AI lead)
  "1777879324532"   # Lê Hoàng Đạt (CEO/ADMIN)
  "1777879283395"   # Huỳnh Thị Quốc Trinh (ADMIN)
  "1777879278415"   # Kỳ Trần (MEMBER, AI Researcher)
  "1777879259842"   # Dani Nguyễn (MEMBER, BA)
  "1777879246434"   # Nguyễn Phương Bình (MANAGER, UI/UX)
  "1777879250537"   # Châu Nga (MANAGER, Partnership)
  "1777879462895"   # Huỳnh Thị Yến Sương (MANAGER, Media)
)

# Varied prompts so memory recall doesn't conflate
PROMPTS=(
  "tôi có task nào không"
  "task nào quá hạn"
  "báo cáo tuần này"
  "ai đang bị block không"
  "tìm project có chữ AI"
  "data hygiene check"
  "tôi là ai trong hệ thống"
  "list các task đã done tuần qua"
  "có cuộc họp nào sắp tới"
  "snapshot dự án Website Revamp"
)

START_NS=$(date +%s%N)

# Fire N requests in parallel
for i in $(seq 0 $((N - 1))); do
  CID="${CIDS[$i]}"
  PROMPT="${PROMPTS[$i]}"
  OUT="$OUTDIR/req-$i.txt"
  (
    T0=$(date +%s%N)
    HTTP=$(curl -s -o "$OUT.body" -w "%{http_code}" -m 180 \
      -X POST "$ENDPOINT" \
      -H "Content-Type: application/json" \
      -d "{\"text\":\"$PROMPT\",\"conversationId\":\"gapo:$CID\",\"correlationId\":\"loadtest-$i\",\"source\":\"chat\"}")
    T1=$(date +%s%N)
    MS=$(( (T1 - T0) / 1000000 ))
    BYTES=$(wc -c < "$OUT.body" 2>/dev/null || echo 0)
    echo "$i,$HTTP,$MS,$BYTES,$CID,$PROMPT" > "$OUT"
  ) &
done

wait

END_NS=$(date +%s%N)
WALL_MS=$(( (END_NS - START_NS) / 1000000 ))

echo "▶ All $N requests completed. Wall-clock: ${WALL_MS}ms"
echo

# Aggregate
python3 <<PYEOF
import os, glob
results = []
for f in sorted(glob.glob('$OUTDIR/req-*.txt')):
    with open(f) as fh:
        line = fh.read().strip()
    if not line: continue
    parts = line.split(',', 5)
    if len(parts) < 4: continue
    idx, http, ms, bytes_n = parts[0], parts[1], int(parts[2]), int(parts[3])
    cid = parts[4] if len(parts) > 4 else ''
    prompt = parts[5] if len(parts) > 5 else ''
    results.append((idx, http, ms, bytes_n, cid, prompt))

print('=== Per-request results ===')
print(f"{'idx':<4} {'http':<5} {'time':>8} {'bytes':>6}  prompt")
for idx, http, ms, bytes_n, cid, prompt in sorted(results, key=lambda x: int(x[0])):
    status = '✓' if http == '200' and bytes_n > 50 else '✗'
    print(f"{idx:<4} {http:<5} {ms:>6}ms {bytes_n:>6}  {status} {prompt[:50]}")

times = [r[2] for r in results if r[1] == '200' and r[3] > 50]
times_all = [r[2] for r in results]
print()
print('=== Aggregate (success only) ===')
print(f'  N successful:  {len(times)} / {len(results)}')
if times:
    times.sort()
    n = len(times)
    print(f'  Min:           {times[0]} ms')
    print(f'  Mean:          {sum(times)//n} ms')
    print(f'  P50 (median):  {times[n//2]} ms')
    print(f'  P95:           {times[min(n-1, int(n * 0.95))]} ms')
    print(f'  P99:           {times[min(n-1, int(n * 0.99))]} ms')
    print(f'  Max:           {times[-1]} ms')
print()
print(f'=== Throughput ===')
print(f'  Wall-clock:    $WALL_MS ms')
if times_all:
    print(f'  RPS:           {len(times_all) * 1000 / $WALL_MS:.2f} req/s')
    print(f'  Per-req avg:   {sum(times_all)//len(times_all)} ms')
print()
print(f'=== Failures ===')
failures = [(idx, http, ms, bytes_n) for idx, http, ms, bytes_n, _, _ in results if http != '200' or bytes_n <= 50]
if failures:
    for idx, http, ms, bytes_n in failures:
        print(f'  [{idx}] http={http} time={ms}ms bytes={bytes_n}')
else:
    print('  None')
PYEOF
