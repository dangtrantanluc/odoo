export type AgentToolTrace = {
  name: string;
  args: any;
  durationMs?: number;
  error?: string;
};

export type AgentContext = {
  source?: "chat" | "cron" | "cli" | "other" | "eval";
  /** Per-turn identifier — unique per agent run. */
  correlationId?: string;
  /** Stable per-conversation identifier (e.g. Gapo thread id) for memory grouping. */
  conversationId?: string;
  /**
   * Resolved caller's bb-pm userId (Sprint 8 Day 3). Populated từ
   * resolveCaller() before runAgentInternal — pre-classifier dùng để
   * scope "task của tôi". null nếu caller chưa map vào bb-pm DB.
   */
  callerUserId?: number;
  /**
   * If set, orchestrator pushes each tool call into trace.toolCalls.
   * Used by eval-runner to assert tool selection without coupling to audit.
   * Mutated in place — caller reads after runAgent returns.
   */
  trace?: { toolCalls: AgentToolTrace[] };
};
