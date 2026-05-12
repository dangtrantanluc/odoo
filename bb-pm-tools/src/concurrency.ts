// Sprint 8 Phase #4 — In-memory concurrency limiter cho /agent/run.
//
// Lý do: Node async + vLLM continuous batching đã handle concurrent fetch
// requests. Bottleneck thực = vLLM batch saturate → timeout cascade.
//
// Cap default 16 (2026-05-07): vLLM Qwen3.6-27B-FP8 host xác nhận
// max-num-seqs = 16 → batch parallel 16 sequences mượt. Trước đó cap 6
// quá conservative, gate fast-path không cần thiết. Đo lại nếu vLLM đổi.
//
// Khi over-cap:
//   - Default: queue waiter, await slot (FIFO).
//   - Hard limit hit (queue cũng full): reject 503 → caller retry.
//
// KHÔNG dùng BullMQ vì:
//   - Single bb-pm-tools process (không multi-instance)
//   - Persistence không cần (Gapo webhook retries từ source nếu fail)
//   - Redis cooldown đã có sẵn cho follow-up — thêm BullMQ overkill
//
// Multi-process upgrade path: swap impl với BullMQ dùng cùng acquire/release
// API contract.

const MAX_CONCURRENT = Number(process.env.AGENT_MAX_CONCURRENT ?? 16);
const MAX_QUEUE = Number(process.env.AGENT_MAX_QUEUE ?? 30);
const ACQUIRE_TIMEOUT_MS = Number(process.env.AGENT_ACQUIRE_TIMEOUT_MS ?? 60_000);

let inFlight = 0;
let totalProcessed = 0;
let totalRejected = 0;
let totalAcquired = 0;
let peakInFlight = 0;
let peakQueueDepth = 0;

type Waiter = {
  resolve: () => void;
  reject: (err: Error) => void;
  enqueuedAt: number;
  timeout: ReturnType<typeof setTimeout>;
};

const waitQueue: Waiter[] = [];

export type AcquireResult =
  | { ok: true; release: () => void }
  | { ok: false; reason: "queue_full" | "timeout"; retryAfterSec: number };

/**
 * Try acquire 1 in-flight slot. Returns { ok:true, release } khi có slot.
 * Nếu in-flight đã max, queue. Reject nếu queue cũng full.
 */
export function acquireSlot(): Promise<AcquireResult> {
  return new Promise((resolve) => {
    if (inFlight < MAX_CONCURRENT) {
      grantSlot(resolve);
      return;
    }
    if (waitQueue.length >= MAX_QUEUE) {
      totalRejected++;
      resolve({
        ok: false,
        reason: "queue_full",
        retryAfterSec: 30,
      });
      return;
    }

    // Enqueue with timeout
    const timeout = setTimeout(() => {
      const idx = waitQueue.findIndex((w) => w.resolve === waiterResolve);
      if (idx >= 0) waitQueue.splice(idx, 1);
      totalRejected++;
      resolve({
        ok: false,
        reason: "timeout",
        retryAfterSec: 60,
      });
    }, ACQUIRE_TIMEOUT_MS);

    const waiterResolve = () => {
      clearTimeout(timeout);
      grantSlot(resolve);
    };

    waitQueue.push({
      resolve: waiterResolve,
      reject: (err) => resolve({ ok: false, reason: "timeout", retryAfterSec: 60 }),
      enqueuedAt: Date.now(),
      timeout,
    });
    if (waitQueue.length > peakQueueDepth) peakQueueDepth = waitQueue.length;
  });
}

function grantSlot(resolve: (r: AcquireResult) => void) {
  inFlight++;
  totalAcquired++;
  if (inFlight > peakInFlight) peakInFlight = inFlight;
  let released = false;
  resolve({
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      inFlight--;
      totalProcessed++;
      // Wake next waiter
      const next = waitQueue.shift();
      if (next) next.resolve();
    },
  });
}

export function getMetrics() {
  return {
    inFlight,
    queueDepth: waitQueue.length,
    maxConcurrent: MAX_CONCURRENT,
    maxQueue: MAX_QUEUE,
    totalAcquired,
    totalProcessed,
    totalRejected,
    peakInFlight,
    peakQueueDepth,
    oldestWaiterAgeMs:
      waitQueue.length > 0 ? Date.now() - waitQueue[0].enqueuedAt : 0,
  };
}

/** Test-only: reset state. */
export function _resetConcurrency() {
  for (const w of waitQueue) clearTimeout(w.timeout);
  waitQueue.length = 0;
  inFlight = 0;
  totalProcessed = 0;
  totalRejected = 0;
  totalAcquired = 0;
  peakInFlight = 0;
  peakQueueDepth = 0;
}
