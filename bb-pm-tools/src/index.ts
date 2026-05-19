import "./env"; // must run before config import
import { config, assertConfig, getActiveLlmConfig } from "./config";
import { handleAgentRun, handleAgentMetrics, handleHealth } from "./webhook";
import { startScheduler } from "./scheduler";

const AGENT_RUN_PATH = "/api/plugins/bb-pm/agent/run";
const AGENT_METRICS_PATH = "/api/plugins/bb-pm/agent/metrics";
const HEALTH_PATH = "/api/plugins/bb-pm/health";

export function register(api: any) {
  const missing = assertConfig();
  if (missing.length) {
    console.warn(
      `[bb-pm-tools] Missing env: ${missing.join(", ")} — plugin will register but may fail at runtime`,
    );
  }

  if (!api || typeof api.registerHttpRoute !== "function") {
    console.error("[bb-pm-tools] api.registerHttpRoute unavailable — cannot register agent endpoint");
    return;
  }

  // Primary entry: channel-agnostic agent runner.
  // Channel plugins (gapo-agent, Slack, etc.) POST { text, correlationId?, source? } here.
  api.registerHttpRoute({
    path: AGENT_RUN_PATH,
    auth: "plugin",
    match: "exact",
    handler: handleAgentRun,
  });

  // Sprint 8 Phase #4 — observability endpoint cho concurrency + counter.
  api.registerHttpRoute({
    path: AGENT_METRICS_PATH,
    auth: "plugin",
    match: "exact",
    handler: handleAgentMetrics,
  });

  // Sprint 8 follow-up — liveness/readiness probe.
  // Public (no auth) — chỉ trả status component, không leak data nhạy cảm.
  // PM2/k8s/uptime monitor poll endpoint này.
  api.registerHttpRoute({
    path: HEALTH_PATH,
    auth: "plugin",
    match: "exact",
    handler: handleHealth,
  });

  // Fire-and-forget — don't block plugin registration on DB load.
  void startScheduler().catch((err: any) => {
    console.error("[bb-pm-tools] scheduler bootstrap failed:", err?.message ?? err);
  });

  const llmCfg = getActiveLlmConfig();
  console.log(
    `[bb-pm-tools] Registered — agent=${AGENT_RUN_PATH}, api=${config.bbPmApi.baseUrl}, llm=${config.llm.activeProvider}/${llmCfg.model}`,
  );
}

export default { register };

export { tools } from "./tools";
