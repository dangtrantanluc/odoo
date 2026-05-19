import fs from "fs";
import os from "os";
import path from "path";

loadPluginEnv();

export const config = {
  paths: {
    webhook: process.env.GAPO_AGENT_WEBHOOK_PATH || "/api/plugins/gapo-agent/webhook",
    send: process.env.GAPO_AGENT_SEND_PATH || "/api/plugins/gapo-agent/send",
    health: process.env.GAPO_AGENT_HEALTH_PATH || "/api/plugins/gapo-agent/health",
  },
  auth: {
    pluginToken: process.env.GAPO_SEND_TOKEN || process.env.GAPO_AGENT_SEND_TOKEN || "",
  },
  agent: {
    webhookUrl:
      process.env.AGENT_WEBHOOK_URL ||
      "http://localhost:18789/api/plugins/bb-pm/agent/run",
    timeoutMs: Number(process.env.AGENT_WEBHOOK_TIMEOUT_MS || 30000),
  },
  gapo: {
    apiUrl:
      process.env.GAPO_API_URL ||
      "https://api.gapowork.vn/3rd-bot/v1.0/3rd/messages",
    botToken: process.env.GAPO_BOT_TOKEN || process.env.BOT_TOKEN || "",
    botId: process.env.GAPO_BOT_ID || "",
    authHeader: process.env.GAPO_AUTH_HEADER || "x-gapo-api-key",
    authPrefix: process.env.GAPO_AUTH_PREFIX || "",
    dryRun: (process.env.GAPO_DRY_RUN || "false").toLowerCase() === "true",
  },
  log: {
    io: (process.env.GAPO_AGENT_IO_LOG || "true").toLowerCase() !== "false",
    maxChars: Number(process.env.GAPO_AGENT_IO_LOG_MAX_CHARS || 2000),
  },
} as const;

export function assertConfig(): string[] {
  const missing: string[] = [];
  if (!config.gapo.apiUrl) missing.push("GAPO_API_URL");
  if (!config.gapo.botToken && !config.gapo.dryRun) missing.push("GAPO_BOT_TOKEN");
  if (!config.auth.pluginToken) missing.push("GAPO_SEND_TOKEN");
  if (!config.agent.webhookUrl) missing.push("AGENT_WEBHOOK_URL");
  return missing;
}

function loadPluginEnv(): void {
  const envFile =
    process.env.GAPO_AGENT_ENV_FILE ||
    path.join(os.homedir(), ".openclaw", "plugins", "gapo-agent", ".env");
  if (!fs.existsSync(envFile)) return;

  const text = fs.readFileSync(envFile, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}
