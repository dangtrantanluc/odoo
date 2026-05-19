export type AgentToolTrace = {
  name: string;
  args: any;
  durationMs?: number;
  error?: string;
};

export type AgentLlmTrace = {
  label: string;
  latencyMs: number;
  provider?: string;
  model?: string;
  finishReason?: string;
};

export type AgentTimingTrace = {
  queueWaitMs?: number;
  callerResolveMs?: number;
  memoryRecallMs?: number;
  schemaDocMs?: number;
  runAgentMs?: number;
  formatterMs?: number;
  fastPathMs?: number;
  llmCalls: AgentLlmTrace[];
};

export type AgentContext = {
  source?: "chat" | "cron" | "cli" | "other" | "eval";
  /** Per-turn identifier — unique per agent run. */
  correlationId?: string;
  /** Stable per-conversation identifier (e.g. Gapo thread id) for memory grouping. */
  conversationId?: string;
  /** Stable channel user id, separate from conversation/thread id. */
  externalId?: string;
  eventType?: string;
  metadata?: Record<string, unknown>;
  /**
   * Channel adapter already handles visible "working on it" acknowledgements.
   * Avoid sending a second ack path that can be scraped back as user input.
   */
  skipChannelAck?: boolean;
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
  /**
   * Per-request timing trace. Populated by webhook/orchestrator for ops
   * visibility so we can see where latency is spent without turning on a
   * profiler in production.
   */
  timings?: AgentTimingTrace;
};

export type ChannelReplyBody =
  | { type: "text"; text: string; is_markdown_text?: boolean }
  | {
      type: "quick_replies";
      text: string;
      metadata: { options: Array<{ title: string; payload: string }> };
    };
