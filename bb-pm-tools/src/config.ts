export const config = {
  bbPmApi: {
    baseUrl: process.env.BB_PM_API_URL || "http://localhost:4000/api/v1",
    agentToken: process.env.BB_PM_AGENT_TOKEN || "",
  },
  llm: {
    baseUrl: process.env.LLM_BASE_URL || "http://localhost:8000/v1",
    apiKey: process.env.LLM_API_KEY || "not-needed",
    model: process.env.LLM_MODEL || "gemma-4",
    maxTokens: Number(process.env.LLM_MAX_TOKENS || 1024),
    temperature: Number(process.env.LLM_TEMPERATURE || 0.2),
  },
  // Outbound channel — scheduler and follow-up tool post messages via the
  // gapo-work plugin's /send endpoint instead of calling the Gapo API
  // directly. Centralises all Gapo credentials in gapo-work.
  channelOut: {
    gapoSendUrl:
      process.env.GAPO_SEND_URL ||
      "http://localhost:18789/api/plugins/gapo-work/send",
    gapoSendToken: process.env.GAPO_SEND_TOKEN || "",
  },
  // Redis — used for follow-up cooldowns (Sprint 3) and rate limiting
  // (Sprint 6.2). Optional: if unset, cooldown + rate limit fall back to
  // in-process state (fine for single-instance dev; loses guarantees on
  // multi-process deploys).
  redis: {
    url: process.env.REDIS_URL || "",
    followUpCooldownSec: Number(process.env.FOLLOW_UP_COOLDOWN_SEC || 24 * 3600),
  },
  // Rate limit on /agent/run. Set AGENT_RUN_MAX_PER_WINDOW=0 to disable.
  rateLimit: {
    maxPerWindow: Number(process.env.AGENT_RUN_MAX_PER_WINDOW ?? 30),
    windowSec: Number(process.env.AGENT_RUN_WINDOW_SEC ?? 60),
  },
  orchestrator: {
    maxToolSteps: Number(process.env.AGENT_MAX_STEPS || 4),
  },
  cron: {
    timezone: process.env.CRON_TZ || "Asia/Ho_Chi_Minh",
    dailyDigest: {
      schedule: process.env.CRON_DAILY_DIGEST || "0 8 * * *",
      target: process.env.CRON_DAILY_DIGEST_TARGET || "",
    },
    weeklyHygiene: {
      schedule: process.env.CRON_WEEKLY_HYGIENE || "0 9 * * MON",
      target: process.env.CRON_WEEKLY_HYGIENE_TARGET || "",
    },
  },
} as const;

export function assertConfig(): string[] {
  const missing: string[] = [];
  if (!config.bbPmApi.agentToken) missing.push("BB_PM_AGENT_TOKEN");
  // GAPO_SEND_TOKEN is required only if cron targets are set. Keeps the
  // plugin boot clean in dev when cron is disabled.
  const cronOn =
    !!config.cron.dailyDigest.target || !!config.cron.weeklyHygiene.target;
  if (cronOn && !config.channelOut.gapoSendToken) {
    missing.push("GAPO_SEND_TOKEN");
  }
  return missing;
}
