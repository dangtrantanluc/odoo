export type AgentContext = {
  source?: "chat" | "cron" | "cli" | "other";
  /** Per-turn identifier — unique per agent run. */
  correlationId?: string;
  /** Stable per-conversation identifier (e.g. Gapo thread id) for memory grouping. */
  conversationId?: string;
};
