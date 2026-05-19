
import "./env";
import { chat, ChatMessage, LlmProviderName } from "./llm";
import { config } from "./config";
import { toolCatalog } from "./tools";

type Scenario = {
  name: string;
  description: string;
  messages: ChatMessage[];
  tools?: ReturnType<typeof toolCatalog>;
  options?: { max_tokens?: number; temperature?: number; response_format?: { type: "json_object" | "text" } };
};

const SAMPLE_TRANSCRIPT = `
[10:00] PM Bình: Mở meeting standup. Hôm nay ai có vấn đề gì?
[10:01] Dev An: Em xong feature login, đang chờ review từ anh Hùng.
[10:02] Dev Linh: Em phát hiện API customer bị bug N+1, mất 1 ngày fix.
[10:03] PM Bình: OK Linh fix bug deadline thứ 6. An làm tiếp module billing.
[10:04] PM Bình: Quyết định: dời release từ 12/5 sang 15/5 vì chờ Linh.
[10:05] Dev An: Em cần thêm 1 màn hình settings cho billing, ai design giúp?
[10:06] PM Bình: Designer Mai làm, deliver design cho An trước 10/5.
`.trim();

const SCENARIOS: Scenario[] = [
  {
    name: "1-greeting",
    description: "Câu chào ngắn, không tool, ~50 tokens output",
    messages: [
      { role: "system", content: "Bạn là PM Agent của BlueBolt. Trả lời tiếng Việt ngắn gọn." },
      { role: "user", content: "Chào bạn, hôm nay làm việc thế nào?" },
    ],
    options: { max_tokens: 200 },
  },
  {
    name: "2-knowledge-no-tool",
    description: "Câu hỏi suy luận, không tool",
    messages: [
      { role: "system", content: "Bạn là PM Agent. Trả lời tiếng Việt, ≤ 3 câu." },
      { role: "user", content: "Sự khác nhau giữa Sprint Goal và Sprint Backlog là gì?" },
    ],
    options: { max_tokens: 300 },
  },
  {
    name: "3-tool-decision",
    description: "Có 15 tool catalog, bắt buộc decide tool — đo overhead schema lớn",
    messages: [
      { role: "system", content: "Bạn là PM Agent với 15 tool. Quyết định gọi tool phù hợp." },
      { role: "user", content: "Liệt kê task quá hạn trong dự án id=1" },
    ],
    tools: toolCatalog(),
    options: { max_tokens: 200 },
  },
  {
    name: "4-meeting-json",
    description: "Trích JSON từ transcript ~100 token input, response_format json_object",
    messages: [
      {
        role: "system",
        content:
          "Trích JSON đúng schema {summary, decisions[], actionItems[{title, ownerName}]} từ transcript họp. Chỉ JSON, không markdown.",
      },
      { role: "user", content: `TRANSCRIPT:\n${SAMPLE_TRANSCRIPT}` },
    ],
    options: { response_format: { type: "json_object" }, max_tokens: 1024, temperature: 0.1 },
  },
];

const RUNS = Number(process.env.BENCH_RUNS || 3);
const WARMUP = Number(process.env.BENCH_WARMUP || 1);
if (process.env.BENCH_9ROUTER_MODEL) {
  (config.llm["9router"] as { model: string }).model = process.env.BENCH_9ROUTER_MODEL;
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

function avg(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN;
}

type ScenarioResult = {
  latencies: number[];
  completionTokens: number[];
  promptTokens: number[];
  errors: string[];
};

async function benchProvider(provider: LlmProviderName, scenarios: Scenario[]): Promise<Record<string, ScenarioResult>> {
  const results: Record<string, ScenarioResult> = {};

  for (const s of scenarios) {
    const r: ScenarioResult = { latencies: [], completionTokens: [], promptTokens: [], errors: [] };

    process.stdout.write(`  [${provider}] ${s.name} `);

    // Warmup — tránh cold-start ảnh hưởng số liệu (model load, JIT, connection pool)
    for (let i = 0; i < WARMUP; i++) {
      try {
        await chat(s.messages, s.tools, { ...s.options, provider });
        process.stdout.write("·");
      } catch (e: any) {
        process.stdout.write("x");
        // 1 lỗi warmup không fatal — vẫn chạy measure
      }
    }

    for (let i = 0; i < RUNS; i++) {
      try {
        const resp = await chat(s.messages, s.tools, { ...s.options, provider });
        r.latencies.push(resp.latencyMs ?? 0);
        r.completionTokens.push(resp.usage?.completion_tokens ?? 0);
        r.promptTokens.push(resp.usage?.prompt_tokens ?? 0);
        process.stdout.write("✓");
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        r.errors.push(msg);
        process.stdout.write("✗");
      }
    }
    process.stdout.write("\n");
    results[s.name] = r;
  }

  return results;
}

function fmtMs(n: number): string {
  if (isNaN(n)) return "-";
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(2)}s`;
}

function fmtRow(r: ScenarioResult | undefined): string {
  if (!r) return "(skipped)";
  if (r.latencies.length === 0) return `(all ${r.errors.length} errors: ${r.errors[0]?.slice(0, 80) ?? ""})`;
  const avgL = avg(r.latencies);
  const p50L = pct(r.latencies, 50);
  const p95L = pct(r.latencies, 95);
  const avgIn = avg(r.promptTokens);
  const avgOut = avg(r.completionTokens);
  const tps = avgOut && avgL ? ((avgOut * 1000) / avgL).toFixed(1) : "-";
  const errStr = r.errors.length ? ` errors=${r.errors.length}` : "";
  return `avg=${fmtMs(avgL)} p50=${fmtMs(p50L)} p95=${fmtMs(p95L)} | in=${Math.round(avgIn)}tok out=${Math.round(avgOut)}tok | ${tps} tok/s${errStr}`;
}

(async () => {
  const skipQwen = !!process.env.SKIP_QWEN;
  const skipGemini = !config.llm.gemini.apiKey || !!process.env.SKIP_GEMINI;
  const skip9Router = !config.llm["9router"].apiKey || !!process.env.SKIP_9ROUTER;

  console.log("\n=== LLM Benchmark ===");
  console.log(`Runs:    ${RUNS} per scenario (warmup: ${WARMUP})`);
  console.log(`default: ${config.llm.default.baseUrl} / ${config.llm.default.model}`);
  console.log(`gemini:  ${config.llm.gemini.baseUrl} / ${config.llm.gemini.model}`);
  console.log(`9router: ${config.llm["9router"].baseUrl} / ${config.llm["9router"].model}`);
  console.log();

  if (skipQwen) console.log("⚠️  default skipped (SKIP_QWEN=1)");
  if (skipGemini && !process.env.SKIP_GEMINI) {
    console.log("⚠️  gemini skipped (GEMINI_API_KEY rỗng)");
  } else if (skipGemini) {
    console.log("⚠️  gemini skipped (SKIP_GEMINI=1)");
  }
  if (skip9Router && !process.env.SKIP_9ROUTER) {
    console.log("⚠️  9router skipped (9ROUTER_API_KEY rỗng)");
  } else if (skip9Router) {
    console.log("⚠️  9router skipped (SKIP_9ROUTER=1)");
  }
  console.log();

  console.log("Scenarios:");
  for (const s of SCENARIOS) console.log(`  - ${s.name}: ${s.description}`);
  console.log();

  console.log("Running…");
  const qwen = skipQwen ? {} : await benchProvider("default", SCENARIOS);
  const gemini = skipGemini ? {} : await benchProvider("gemini", SCENARIOS);
  const nineRouter = skip9Router ? {} : await benchProvider("9router", SCENARIOS);

  console.log("\n=== Results ===\n");
  for (const s of SCENARIOS) {
    console.log(s.name);
    if (!skipQwen) console.log(`  default: ${fmtRow(qwen[s.name])}`);
    if (!skipGemini) console.log(`  gemini:  ${fmtRow(gemini[s.name])}`);
    if (!skip9Router) console.log(`  9router: ${fmtRow(nineRouter[s.name])}`);
    if (!skipQwen && !skipGemini) {
      const dq = qwen[s.name];
      const dg = gemini[s.name];
      if (dq?.latencies.length && dg?.latencies.length) {
        const ratio = avg(dg.latencies) / avg(dq.latencies);
        const winner = ratio < 1 ? "gemini" : "default";
        const factor = ratio < 1 ? (1 / ratio).toFixed(2) : ratio.toFixed(2);
        console.log(`  → ${winner} nhanh hơn ${factor}x`);
      }
    }
    console.log();
  }

  console.log("=== Summary ===");
  if (!skipQwen && !skipGemini) {
    const allQ = SCENARIOS.flatMap((s) => qwen[s.name]?.latencies ?? []);
    const allG = SCENARIOS.flatMap((s) => gemini[s.name]?.latencies ?? []);
    if (allQ.length && allG.length) {
      console.log(`default avg ${fmtMs(avg(allQ))}, gemini avg ${fmtMs(avg(allG))} across all scenarios`);
    }
  }
})().catch((e) => {
  console.error("Bench failed:", e);
  process.exit(1);
});
