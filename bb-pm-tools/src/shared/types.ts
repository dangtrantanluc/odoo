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
   * Resolved caller's bb-pm userId. Resolved khi xử lý turn — fast-path /
   * action-router dùng để scope "task của tôi". null nếu caller chưa map
   * vào bb-pm DB.
   */
  callerUserId?: number;
  /** Tool calls trong turn, push vào để telemetry/audit đọc lại. */
  trace?: { toolCalls: AgentToolTrace[] };
  /**
   * Per-request timing trace. Populated bởi webhook để quan sát latency
   * mà không cần bật profiler ở production.
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
