import "./env"; // must run before config import
import { config, assertConfig } from "./config";
import { handleAgentRun } from "./webhook";
import { startScheduler } from "./scheduler";

const AGENT_RUN_PATH = "/api/plugins/bb-pm/agent/run";

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
  // Channel plugins (gapo-work, etc.) POST { text, correlationId?, source? } here.
  api.registerHttpRoute({
    path: AGENT_RUN_PATH,
    auth: "plugin",
    match: "exact",
    handler: handleAgentRun,
  });

  startScheduler();

  console.log(
    `[bb-pm-tools] Registered — agent=${AGENT_RUN_PATH}, api=${config.bbPmApi.baseUrl}, llm=${config.llm.model}`,
  );
}

export default { register };

export { runAgent } from "./orchestrator";
export { tools } from "./tools";
