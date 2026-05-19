const LLM_PROVIDER_NAMES = ["default", "gemini", "openrouter", "9router", ] as const;
export type LlmProviderName = (typeof LLM_PROVIDER_NAMES)[number];

const requestedLlmProvider = process.env.LLM_PROVIDER || "default";

export function isLlmProviderName(value: string): value is LlmProviderName {
  return (LLM_PROVIDER_NAMES as readonly string[]).includes(value);
}

const llmActiveProvider: LlmProviderName = isLlmProviderName(requestedLlmProvider)
  ? requestedLlmProvider
  : "default";

export const config = {
  bbPmApi: {
    baseUrl: process.env.BB_PM_API_URL || "http://localhost:4000/api/v1",
    agentToken: process.env.BB_PM_AGENT_TOKEN || "",
  },
  // Multi-provider LLM config (Sprint 6+).
  //   - "default":    Qwen / Gemma self-host hoặc bất kỳ OpenAI-compat endpoint nào (LLM_*).
  //   - "gemini":     Google Gemini qua OpenAI-compat endpoint (GEMINI_*).
  //   - "openrouter": OpenRouter aggregator — tất cả model OpenAI/Anthropic/Google
  //                   qua 1 endpoint OpenAI-compat (OPENROUTER_*).
  //   - "9router":    Local 9Router proxy / combo router (9ROUTER_*).
  // Dùng env LLM_PROVIDER để chọn global default. Per-call override qua
  // chat(messages, tools, { provider: "gemini" | "openrouter" | "9router" }).
  llm: {
    requestedProvider: requestedLlmProvider,
    activeProvider: llmActiveProvider,
    default: {
      baseUrl: process.env.LLM_BASE_URL || "http://localhost:8000/v1",
      apiKey:
        process.env.LLM_API_KEY ||
        process.env.NINE_ROUTER_API_KEY ||
        process.env["9ROUTER_API_KEY"] ||
        "not-needed",
      model: process.env.LLM_MODEL || "Qwen/Qwen3.6-27B-FP8",
      maxTokens: Number(process.env.LLM_MAX_TOKENS || 1024),
      temperature: Number(process.env.LLM_TEMPERATURE || 0.2),
    },
    gemini: {
      baseUrl:
        process.env.GEMINI_BASE_URL ||
        "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: process.env.GEMINI_API_KEY || "",
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
      maxTokens: Number(process.env.GEMINI_MAX_TOKENS || 2048),
      temperature: Number(process.env.GEMINI_TEMPERATURE || 0.2),
    },
    openrouter: {
      baseUrl: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY || "",
      model: process.env.OPENROUTER_MODEL || "openai/gpt-4o",
      maxTokens: Number(process.env.OPENROUTER_MAX_TOKENS || 2048),
      temperature: Number(process.env.OPENROUTER_TEMPERATURE || 0.2),
    },
    "9router": {
      baseUrl:
        process.env["9ROUTER_BASE_URL"] ||
        process.env.NINE_ROUTER_BASE_URL ||
        "http://localhost:20128/v1",
      apiKey:
        process.env["9ROUTER_API_KEY"] ||
        process.env.NINE_ROUTER_API_KEY ||
        "not-needed",
      model:
        process.env["9ROUTER_MODEL"] ||
        process.env.NINE_ROUTER_MODEL ||
        "gemini/gemini-3-flash-preview",
      maxTokens: Number(
        process.env["9ROUTER_MAX_TOKENS"] ||
          process.env.NINE_ROUTER_MAX_TOKENS ||
          2048,
      ),
      temperature: Number(
        process.env["9ROUTER_TEMPERATURE"] ||
          process.env.NINE_ROUTER_TEMPERATURE ||
          0.2,
      ),
    },

  },
  // Outbound channel — scheduler and follow-up tool post messages via the
  // gapo-agent plugin's /send endpoint instead of calling the Gapo API
  // directly. Centralises all Gapo credentials in gapo-agent.
  channelOut: {
    gapoSendUrl:
      process.env.GAPO_SEND_URL ||
      "http://localhost:18789/api/plugins/gapo-agent/send",
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
    noonCheckin: {
      schedule: process.env.CRON_NOON_CHECKIN || "50 11 * * 1-5",
    },
    eodCheckin: {
      schedule: process.env.CRON_EOD_CHECKIN || "50 17 * * 1-5",
    },
    missingCheckinFollowup: {
      schedule: process.env.CRON_MISSING_CHECKIN_FOLLOWUP || "0 18 * * 1-5",
    },
    checkinEnabled: (process.env.CRON_CHECKIN_ENABLED || "false").toLowerCase() === "true",
  },
  // Admin alerts — gửi tin Gapo cho channel này khi cron / scheduler / bot
  // critical errors. Để trống = silent (skip alert). Format target giống
  // CRON target: "collab:<id>" hoặc "dm:<id>" hoặc raw thread id.
  adminAlert: {
    target: process.env.ADMIN_ALERT_TARGET || "",
  },
} as const;

export function getActiveLlmConfig() {
  return config.llm[config.llm.activeProvider];
}

export function assertConfig(): string[] {
  const missing: string[] = [];
  if (!isLlmProviderName(config.llm.requestedProvider)) {
    missing.push(
      `LLM_PROVIDER(valid: ${LLM_PROVIDER_NAMES.join("|")}; got: ${config.llm.requestedProvider})`,
    );
  }
  if (!config.bbPmApi.agentToken) missing.push("BB_PM_AGENT_TOKEN");
  // GAPO_SEND_TOKEN is required only if cron targets are set. Keeps the
  // plugin boot clean in dev when cron is disabled.
  const cronOn =
    !!config.cron.dailyDigest.target ||
    !!config.cron.weeklyHygiene.target ||
    config.cron.checkinEnabled;
  if (cronOn && !config.channelOut.gapoSendToken) {
    missing.push("GAPO_SEND_TOKEN");
  }
  if (config.llm.activeProvider === "gemini" && !config.llm.gemini.apiKey) {
    missing.push("GEMINI_API_KEY");
  }
  if (config.llm.activeProvider === "openrouter" && !config.llm.openrouter.apiKey) {
    missing.push("OPENROUTER_API_KEY");
  }
  if (config.llm.activeProvider === "9router" && !config.llm["9router"].apiKey) {
    missing.push("9ROUTER_API_KEY");
  }
  return missing;
}
