import { Page } from "playwright";
import { newLongLivedPage } from "./browser";

/**
 * Message watcher — monitors the bot's Gapo Work account via a long-lived
 * Chromium page, detects unread DMs / @mentions, and replies through the
 * bb-pm-tools agent endpoint.
 *
 * Hybrid detection:
 *   - MutationObserver injected into the page surfaces unread badges in
 *     real time (~1-2s after Gapo's WS pushes the message).
 *   - 10s polling sweep catches anything the observer misses (Gapo SPA
 *     re-renders can fire mutations that our heuristics don't recognize).
 *
 * Concurrency: a single FIFO queue + worker. Replies are serialized so the
 * Draft.js editor never gets two messages typed into it at once.
 */

// Use a non-existent conversation id as the "neutral" root so the page
// doesn't sit on any real DM (which would cause Gapo to auto-mark inbound
// messages as read for that conversation, hiding the unread badge from
// our observer). `/messenger/0` keeps the sidebar visible without
// selecting any real chat. The previously-used cid 1777432856955 turned
// out to be Võ Trọng Nhơn's DM — sitting there silently dropped every
// message Nhơn sent.
const MESSENGER_ROOT = "https://www.gapowork.vn/messenger/0";
const POLL_INTERVAL_MS = 10_000;
const COOLDOWN_MS = 30_000;

type WatcherState = "stopped" | "starting" | "running" | "stopping";

type ConversationKind = "dm" | "collab";

function parseConversationHref(href: string): { kind: ConversationKind; conversationId: string } | null {
  const dm = href.match(/^\/messenger\/(\d+)/);
  if (dm) return { kind: "dm", conversationId: dm[1] };
  const collab = href.match(/^\/collab\/(\d+)\/chat/);
  if (collab) return { kind: "collab", conversationId: collab[1] };
  return null;
}

interface IncomingHit {
  // Full URL path of the sidebar link, used both as dedup key and for
  // navigation. Examples:
  //   "/messenger/1777433976678"        — DM 1-1
  //   "/collab/7008534052395853824/chat" — group chat
  href: string;
  kind: ConversationKind;
  // Numeric id (extracted from href). Used for cooldown bucket — same
  // person/group should share one cooldown regardless of href shape.
  conversationId: string;
  unreadCountText: string;
  detectedAt: number;
  source: "observer" | "poll";
}

interface WatcherStats {
  state: WatcherState;
  startedAt: number | null;
  botName: string;
  hitsSeen: number;
  replied: number;
  skippedCooldown: number;
  skippedGroupNoMention: number;
  skippedSelf: number;
  errors: number;
  lastReplyAt: number | null;
  lastError: string | null;
  queueDepth: number;
  cooldownEntries: number;
}

export interface WatcherConfig {
  agentRunUrl: string;          // e.g. http://localhost:18789/api/plugins/bb-pm/agent/run
  pollIntervalMs?: number;
  cooldownMs?: number;
  catchUpOnStart?: boolean;     // process all currently-unread on startup
}

class MessageWatcher {
  private cfg: Required<WatcherConfig>;
  private page: Page | null = null;
  private state: WatcherState = "stopped";
  private botName = "";
  private startedAt: number | null = null;
  private cooldowns = new Map<string, number>();
  private queue: IncomingHit[] = [];
  private inFlight = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastSeenBadgeKey = new Map<string, string>();
  // v5 (2026-05-07): track recent bot-sent texts per cid (last 5).
  // Used to filter ra bot's own replies when lastMsg picking + POST-REPLY rescan.
  // BOT_ACK_RE catch typing indicator nhưng KHÔNG catch reply ngắn ("OK bạn 👍",
  // "Chào bạn!"). Track exact texts → reliable exclusion.
  private recentBotTexts = new Map<string, string[]>();
  private stats = {
    hitsSeen: 0,
    replied: 0,
    skippedCooldown: 0,
    skippedGroupNoMention: 0,
    skippedSelf: 0,
    errors: 0,
    lastReplyAt: null as number | null,
    lastError: null as string | null,
  };

  constructor(cfg: WatcherConfig) {
    this.cfg = {
      agentRunUrl: cfg.agentRunUrl,
      pollIntervalMs: cfg.pollIntervalMs ?? POLL_INTERVAL_MS,
      cooldownMs: cfg.cooldownMs ?? COOLDOWN_MS,
      catchUpOnStart: cfg.catchUpOnStart ?? true,
    };
  }

  async start(): Promise<void> {
    if (this.state !== "stopped") {
      throw new Error(`watcher already in state: ${this.state}`);
    }
    this.state = "starting";
    try {
      this.page = await newLongLivedPage();
      await this.page.goto(MESSENGER_ROOT, { waitUntil: "domcontentloaded" });
      // Wait for the sidebar to render (any messenger link). `/messenger/0`
      // has no chat input because no conversation is selected — only the
      // sidebar matters for badge detection.
      await this.page.waitForSelector('a[href*="/messenger/"]', { timeout: 30000 });

      this.botName = await this.detectBotName();
      console.log(`[watcher] bot identity: ${this.botName || "(unknown)"}`);

      await this.installObserver();
      this.pollTimer = setInterval(() => void this.pollOnce(), this.cfg.pollIntervalMs);

      this.state = "running";
      this.startedAt = Date.now();
      console.log(`[watcher] started — poll=${this.cfg.pollIntervalMs}ms cooldown=${this.cfg.cooldownMs}ms`);

      // Self-healing: if Chromium dies (Xvfb gone, OOM, etc.) the page
      // emits 'crash' or 'close'. Restart the watcher after a small delay
      // so we don't tightloop if the underlying issue persists.
      this.page.on("crash", () => this.handlePageGone("crash"));
      this.page.on("close", () => this.handlePageGone("close"));

      // Observer + initial scan can fire enqueue() while state was still
      // "starting"; drainQueue() exits early in that window. Now that state
      // is running, kick the drain explicitly so no hits are stranded.
      if (this.cfg.catchUpOnStart) {
        await this.pollOnce();
      }
      void this.drainQueue();
    } catch (err) {
      this.state = "stopped";
      this.page?.close().catch(() => {});
      this.page = null;
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.state === "stopped") return;
    this.state = "stopping";
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    await this.page?.close().catch(() => {});
    this.page = null;
    this.queue = [];
    this.state = "stopped";
    this.startedAt = null;
    console.log("[watcher] stopped");
  }

  private handlePageGone(reason: "crash" | "close"): void {
    if (this.state !== "running") return;
    console.warn(`[watcher] page ${reason} — scheduling restart in 5s`);
    this.state = "stopping";
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.page = null;
    setTimeout(() => {
      this.state = "stopped";
      this.start().catch(err => {
        console.error("[watcher] auto-restart failed:", err?.message ?? err);
        this.stats.errors++;
        this.stats.lastError = `auto-restart: ${err?.message ?? err}`;
      });
    }, 5000);
  }

  status(): WatcherStats {
    return {
      state: this.state,
      startedAt: this.startedAt,
      botName: this.botName,
      ...this.stats,
      queueDepth: this.queue.length,
      cooldownEntries: this.cooldowns.size,
    };
  }

  /**
   * Force-clear cooldowns + dedup keys so the next inbound message triggers
   * a reply even if it arrives quickly. Useful when debugging or when an
   * earlier reply got lost and the user re-sends.
   */
  reset(): { clearedCooldowns: number; clearedDedup: number } {
    const c = this.cooldowns.size;
    const d = this.lastSeenBadgeKey.size;
    this.cooldowns.clear();
    this.lastSeenBadgeKey.clear();
    return { clearedCooldowns: c, clearedDedup: d };
  }

  /**
   * Force the watcher's page to re-scan badges right now. Bypasses the 10s
   * polling interval. Returns the snapshot the page sees.
   */
  async kick(): Promise<{ ok: boolean; pageUrl: string | null }> {
    if (!this.page || this.state !== "running") {
      return { ok: false, pageUrl: null };
    }
    // Navigate back to root so any conversation badges become visible.
    try {
      await this.page.goto(MESSENGER_ROOT, { waitUntil: "domcontentloaded" });
      await this.page.waitForSelector('a[href*="/messenger/"]', { timeout: 15000 });
      await this.pollOnce();
      return { ok: true, pageUrl: this.page.url() };
    } catch (err: any) {
      this.stats.errors++;
      this.stats.lastError = `kick: ${err?.message ?? err}`;
      return { ok: false, pageUrl: this.page?.url() ?? null };
    }
  }

  // ── Detection ──────────────────────────────────────────────────────

  private async detectBotName(): Promise<string> {
    if (!this.page) return "";
    // Top-right avatar usually has the user's name as title or aria-label.
    // Fallback: read from any element exposing displayName.
    return await this.page.evaluate(`
      (function() {
        const avatar = document.querySelector('header img[alt], [class*="header"] img[alt]');
        if (avatar) return avatar.getAttribute('alt') || '';
        const userBtn = document.querySelector('[class*="UserMenu"], [class*="user-menu"]');
        if (userBtn) return (userBtn.textContent || '').trim().slice(0, 40);
        return '';
      })()
    `) as string;
  }

  private async installObserver(): Promise<void> {
    if (!this.page) return;

    await this.page.exposeFunction("__watcherOnHit", async (raw: unknown) => {
      const data = raw as { href?: string; unreadText?: string };
      if (!data?.href || !data?.unreadText) return;
      const parsed = parseConversationHref(data.href);
      if (!parsed) return;
      this.enqueue({
        href: data.href,
        kind: parsed.kind,
        conversationId: parsed.conversationId,
        unreadCountText: data.unreadText,
        detectedAt: Date.now(),
        source: "observer",
      });
    });

    await this.page.evaluate(`
      (function() {
        if (window.__watcherInstalled) return;
        window.__watcherInstalled = true;

        function scan() {
          // Both DM ("/messenger/<id>") and group ("/collab/<id>/chat") links
          // live in the sidebar. Scan both shapes.
          const links = document.querySelectorAll(
            'a[href*="/messenger/"], a[href*="/collab/"][href*="/chat"]'
          );
          for (const link of links) {
            const badge = link.querySelector('[class*="unread"], [class*="Badge"], [class*="badge"]');
            const txt = badge && badge.textContent ? badge.textContent.trim() : '';
            if (!badge || !txt || !/^[0-9]+\\+?$/.test(txt)) continue;
            const href = link.getAttribute('href') || '';
            if (!href) continue;
            // @ts-expect-error
            window.__watcherOnHit({ href: href, unreadText: txt });
          }
        }

        // initial sweep + observe DOM changes
        scan();
        new MutationObserver(function() { scan(); }).observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      })();
    `);
  }

  private async pollOnce(): Promise<void> {
    if (!this.page || this.state !== "running") return;
    try {
      const hits = await this.page.evaluate(`
        (function() {
          const out = [];
          const links = document.querySelectorAll(
            'a[href*="/messenger/"], a[href*="/collab/"][href*="/chat"]'
          );
          for (const link of links) {
            const badge = link.querySelector('[class*="unread"], [class*="Badge"], [class*="badge"]');
            const txt = badge && badge.textContent ? badge.textContent.trim() : '';
            if (!badge || !txt || !/^[0-9]+\\+?$/.test(txt)) continue;
            const href = link.getAttribute('href') || '';
            if (href) out.push({ href: href, unreadText: txt });
          }
          return out;
        })()
      `) as Array<{ href: string; unreadText: string }>;

      for (const h of hits) {
        const parsed = parseConversationHref(h.href);
        if (!parsed) continue;
        this.enqueue({
          href: h.href,
          kind: parsed.kind,
          conversationId: parsed.conversationId,
          unreadCountText: h.unreadText,
          detectedAt: Date.now(),
          source: "poll",
        });
      }
    } catch (err: any) {
      this.stats.errors++;
      this.stats.lastError = `poll: ${err?.message ?? err}`;
      console.error("[watcher] poll error:", err?.message ?? err);
    }
  }

  // v5 helper — track recent bot-sent texts per cid (last 5 entries).
  // Push texts mỗi khi bot type message (pre-ack, reply). Used khi pick
  // lastMsg + POST-REPLY rescan để exclude bot's own messages khỏi
  // user-msg detection.
  private recordBotText(cid: string, text: string): void {
    const arr = this.recentBotTexts.get(cid) ?? [];
    arr.push(text);
    if (arr.length > 5) arr.shift();
    this.recentBotTexts.set(cid, arr);
  }

  // ── Queue + worker ─────────────────────────────────────────────────

  private enqueue(hit: IncomingHit): void {
    this.stats.hitsSeen++;
    // Dedup by (conversationId, unreadCountText) — observer may fire repeatedly
    // for the same badge re-render.
    if (this.lastSeenBadgeKey.get(hit.conversationId) === hit.unreadCountText) return;
    this.lastSeenBadgeKey.set(hit.conversationId, hit.unreadCountText);

    // Cooldown filter
    const next = this.cooldowns.get(hit.conversationId) ?? 0;
    if (Date.now() < next) {
      this.stats.skippedCooldown++;
      return;
    }

    // Skip if already in queue
    if (this.queue.some(q => q.conversationId === hit.conversationId)) return;

    this.queue.push(hit);
    void this.drainQueue();
  }

  private async drainQueue(): Promise<void> {
    console.log(`[watcher] drain called inFlight=${this.inFlight} queue=${this.queue.length} state=${this.state}`);
    if (this.inFlight) return;
    while (this.queue.length > 0 && this.state === "running") {
      const hit = this.queue.shift()!;
      this.inFlight = true;
      console.log(`[watcher] drain → processHit cid=${hit.conversationId}`);
      try {
        await this.processHit(hit);
        console.log(`[watcher] drain ← processHit done cid=${hit.conversationId}`);
      } catch (err: any) {
        this.stats.errors++;
        this.stats.lastError = `process ${hit.conversationId}: ${err?.message ?? err}`;
        console.error(`[watcher] process error cid=${hit.conversationId}:`, err?.message ?? err, err?.stack);
      } finally {
        this.inFlight = false;
      }
    }
    console.log(`[watcher] drain exit queue=${this.queue.length} state=${this.state}`);
  }

  private async processHit(hit: IncomingHit): Promise<void> {
    if (!this.page) return;
    console.log(`[watcher] process kind=${hit.kind} cid=${hit.conversationId} via ${hit.source}`);

    // Navigate using the original href (preserves /messenger vs /collab/.../chat).
    await this.page.goto(`https://www.gapowork.vn${hit.href}`, {
      waitUntil: "domcontentloaded",
    });
    await this.page.waitForSelector('[role=textbox][contenteditable=true]', { timeout: 15000 });
    await this.page.waitForTimeout(800);

    // Read recent context. URL kind is the most reliable group indicator —
    // /collab/.../chat is always a group; /messenger/<id> is always a DM.
    const ctx = await this.page.evaluate(`
      (function() {
        const headerName = (document.querySelector('header [class*="name"], [class*="ConversationHeader"] [class*="name"]') || {}).textContent || '';

        // Last 5 message bubbles (best-effort, Gapo class names not stable)
        const items = Array.from(document.querySelectorAll('[class*="MessageItem"], [class*="message-item"], [class*="MessageRow"]'));
        const recent = items.slice(-5).map(function(el) {
          const author = (el.querySelector('[class*="author"], [class*="Author"]') || {}).textContent || '';
          const body = (el.querySelector('[class*="body"], [class*="Body"], [class*="content"]') || el).textContent || '';
          const isOwn = !!el.querySelector('[class*="own"], [class*="self"], [class*="Mine"]');
          return { author: (author || '').trim().slice(0, 50), body: (body || '').trim().slice(0, 500), isOwn: isOwn };
        });

        return { headerName: (headerName || '').trim().slice(0, 80), recent: recent };
      })()
    `) as { headerName: string; recent: Array<{ author: string; body: string; isOwn: boolean }> };

    const isGroup = hit.kind === "collab";

    if (!ctx.recent.length) {
      console.log(`[watcher] cid=${hit.conversationId} no messages scraped, skip`);
      this.cooldowns.set(hit.conversationId, Date.now() + this.cfg.cooldownMs);
      return;
    }

    // v4 fix (2026-05-07): Pick last NON-BOT message thay vì last raw item.
    // v5 (2026-05-07): Plus exclude texts matching recentBotTexts (last 5
    // bot replies on this cid). BOT_ACK_RE catch typing indicator nhưng
    // KHÔNG catch reply ngắn ("OK bạn 👍", "Chào bạn!", "Đã ghi nhận"...) —
    // dẫn tới bot reply to self loop. Track exact texts là reliable.
    const BOT_ACK_RE_LASTMSG = /^[\s\u{1F44D}\u{1F44C}\u{1F914}🕐]*(Đang\s+xử\s+lý|Vẫn\s+đang\s+chạy|Mình\s+đang\s+xử\s+lý)/iu;
    const knownBotTexts = this.recentBotTexts.get(hit.conversationId) ?? [];
    const isBotEcho = (body: string): boolean => {
      const trimmed = body.trim();
      if (!trimmed) return false;
      for (const sent of knownBotTexts) {
        const sentTrim = sent.trim();
        if (!sentTrim) continue;
        // Exact match — bot reply identical
        if (trimmed === sentTrim) return true;
        // Substring — DOM may split bot reply into multiple bubbles.
        // Check both directions với threshold 30 chars để tránh false positive.
        if (trimmed.length >= 10 && sentTrim.includes(trimmed)) return true;
        if (sentTrim.length >= 10 && trimmed.includes(sentTrim.slice(0, Math.min(80, sentTrim.length)))) return true;
      }
      return false;
    };
    const lastUserCandidate = ctx.recent
      .filter((m) => {
        if (m.isOwn) return false;
        if (this.botName && m.author.includes(this.botName)) return false;
        if (BOT_ACK_RE_LASTMSG.test(m.body)) return false;
        if (isBotEcho(m.body)) return false;
        return true;
      })
      .pop();
    const lastMsg = lastUserCandidate ?? ctx.recent[ctx.recent.length - 1];
    if (!lastUserCandidate) {
      console.log(
        `[watcher] cid=${hit.conversationId} no user msg in last 5 — fallback raw (last="${lastMsg.body.slice(0, 40)}")`,
      );
    }

    // Skip self — primary check via lastMsg.isOwn or botName author. Secondary:
    // nếu filter trên trả về null AND raw lastMsg là bot → skip.
    if (lastMsg.isOwn || (this.botName && lastMsg.author.includes(this.botName))) {
      this.stats.skippedSelf++;
      console.log(`[watcher] cid=${hit.conversationId} last msg is self, skip`);
      return;
    }

    // Group + no mention → skip
    if (isGroup) {
      const mentionPattern = this.botName
        ? new RegExp(`@${this.botName.split(/\s+/).join("\\s*")}`, "i")
        : /@pm.?bot|@bot|@bot project manager/i;
      if (!mentionPattern.test(lastMsg.body)) {
        this.stats.skippedGroupNoMention++;
        console.log(`[watcher] cid=${hit.conversationId} group, no mention, skip`);
        this.cooldowns.set(hit.conversationId, Date.now() + this.cfg.cooldownMs);
        return;
      }
    }

    // Cheap pre-LLM short-circuit: if the message is a pure "thanks/bye"
    // ack, skip calling the LLM entirely. Saves ~30-90s of Qwen latency
    // per closed conversation.
    //
    // BUG FIX (2026-05-07): "chào" và "được" alone bị remove khỏi ACK_RE.
    //   - "chào" alone là greeting mở phiên ("chào bạn") → cần reply, KHÔNG ack-skip.
    //   - "được" alone có thể là 1 phần câu ("được, làm cho tôi") → ambiguous.
    //   - Giữ "chào nhé" (lời tạm biệt rõ ràng).
    //   - Pattern đồng bộ với pre-classifier.ts:end_session + formatter.ts:USER_IS_ACK_RE.
    const ACK_RE = /^\s*(ok+|oki+|okay|kay|được rồi|rồi|rõ|hiểu rồi|hiểu|c[aáàảãạ]m ơn( nha| nhé)?|cám ơn|cam on|tks|thanks|thank you|thx|tạm biệt|chào nhé|bye|goodbye|vậy thôi|thôi nhé)\s*[!.?]*\s*[\u{1F44D}\u{1F44C}\u{2764}\u{1F642}]*\s*$/iu;
    const trimmedBody = lastMsg.body.trim();
    if (trimmedBody.length > 0 && trimmedBody.length < 50 && ACK_RE.test(trimmedBody)) {
      console.log(`[watcher] cid=${hit.conversationId} pre-LLM ACK detected ("${trimmedBody}"), skip + extend cooldown 5min`);
      this.stats.replied++;
      this.stats.lastReplyAt = Date.now();
      this.cooldowns.set(hit.conversationId, Date.now() + 5 * 60 * 1000);
      this.lastSeenBadgeKey.delete(hit.conversationId);
      const cidAck = hit.conversationId;
      setTimeout(() => {
        this.cooldowns.delete(cidAck);
        this.lastSeenBadgeKey.delete(cidAck);
        if (this.state === "running") void this.pollOnce();
      }, 5 * 60 * 1000 + 1000);
      return;
    }

    // ── Pre-LLM responsiveness: typing indicator + delayed ACK ───────
    // Trigger Gapo's "Bot Project Manager đang nhập..." indicator NOW so
    // the user sees activity within ~1s instead of staring at silence
    // for 60-90s while Qwen thinks.
    const composer = this.page.locator('[role=textbox][contenteditable=true].public-DraftEditor-content').last();
    let composerOk = false;
    try {
      await composer.click({ timeout: 3000 });
      await composer.type(".", { delay: 50 });   // 1 char → triggers Gapo typing indicator
      composerOk = true;
    } catch (err: any) {
      console.warn(`[watcher] cid=${hit.conversationId} typing-indicator failed: ${err?.message ?? err}`);
    }

    // Optional delayed-ACK: if LLM takes > 8s, send a short visible
    // message so user knows we're still alive (not just typing dot).
    // Disabled by setting BOT_PRE_ACK_DELAY_MS=-1.
    const ackDelayMs = Number(process.env.BOT_PRE_ACK_DELAY_MS ?? 8000);
    let ackSent = false;
    let ackTimer: ReturnType<typeof setTimeout> | null = null;
    // 2026-05-07 — Random ack pool to avoid robotic repetition.
    // Mirror bb-pm-tools/src/orchestrator.ts ACK_FIRST_POOL.
    const ACK_POOL = [
      "Đang xử lý câu hỏi của bạn...",
      "Mình đang nghĩ đây, chờ chút nhé...",
      "Đang tìm thông tin, chờ mình một xíu...",
      "Mình đang check dữ liệu...",
      "Đang xử lý, lát có ngay...",

      // Natural / friendly
      "Để mình xem nhé...",
      "Mình đang kiểm tra thông tin...",
      "Đợi mình chút nha...",
      "Cho mình vài giây nhé...",
      "Mình đang tổng hợp câu trả lời...",
      "Đang phân tích yêu cầu...",
      "Mình đang xử lý thông tin...",
      "Đợi xíu, mình đang check...",
      "Đang lấy dữ liệu mới nhất...",
      "Để mình xử lý thử...",
      "Mình đang xem lại dữ liệu...",
      "Đang chuẩn bị câu trả lời...",
      "Mình đang tìm hướng xử lý phù hợp...",
      "Đang load dữ liệu...",
      "Đợi mình một chút nhé...",

      // PM / work assistant style
      "Mình đang kiểm tra task liên quan...",
      "Đang tra cứu tiến độ công việc...",
      "Mình đang xem thông tin dự án...",
      "Đang tổng hợp trạng thái hiện tại...",
      "Đang lấy dữ liệu từ hệ thống...",
      "Mình đang check deadline và task...",
      "Đang đồng bộ dữ liệu...",
      "Đang tìm thông tin phù hợp...",
      "Đang phân tích yêu cầu công việc...",
      "Mình đang kiểm tra cập nhật mới nhất...",

      // Faster / realtime feel
      "Processing...",
      "Thinking...",
      "Checking...",
      "Loading...",
      "Analyzing request...",
      "Fetching data...",
      "Working on it...",
      "One moment...",
      "Just a sec...",
      "Almost there...",

      // More human-like
      "Hmm, để mình xem...",
      "Câu này mình cần kiểm tra chút...",
      "Đợi mình tra lại nhé...",
      "Mình đang suy nghĩ cách trả lời tốt nhất...",
      "Để mình confirm thông tin...",
      "Mình đang đối chiếu dữ liệu...",
      "Cho mình kiểm tra lại một chút...",
      "Mình đang tìm câu trả lời chính xác nhất...",
    ];
    const ackText = ACK_POOL[Math.floor(Math.random() * ACK_POOL.length)];

    if (ackDelayMs >= 0) {
      ackTimer = setTimeout(async () => {
        try {
          // Clear our placeholder dot, type the ACK, send.
          await composer.click({ timeout: 3000 });
          await this.page!.keyboard.press("Control+A");
          await this.page!.keyboard.press("Backspace");
          await composer.type(ackText, { delay: 15 });
          await composer.press("Enter");
          ackSent = true;
          // v5: track ack text để exclude khỏi user-msg detection sau này
          this.recordBotText(hit.conversationId, ackText);
          console.log(`[watcher] cid=${hit.conversationId} sent pre-ACK "${ackText}" after ${ackDelayMs}ms`);
        } catch (err: any) {
          console.warn(`[watcher] cid=${hit.conversationId} pre-ACK failed: ${err?.message ?? err}`);
        }
      }, ackDelayMs);
    }

    // Build LLM payload
    const transcript = ctx.recent
      .map(m => `${m.isOwn ? "Bot" : m.author || "User"}: ${m.body}`)
      .join("\n");
    const payload = {
      text: `[GAPO_USER: ${lastMsg.author || "Unknown"}] ${lastMsg.body}\n\n--- Context ---\n${transcript}`,
      conversationId: `gapo:${hit.conversationId}`,
      correlationId: `watcher-${hit.conversationId}-${Date.now()}`,
      source: "chat",
    };

    // Call agent — F4 (2026-05-07): explicit timeout 320s align với
    // bb-pm-tools AGENT_HARD_TIMEOUT_MS=300s + 20s margin (network/serialize).
    // Trước đây Node fetch không default timeout → watcher có thể treo
    // indefinitely nếu Qwen hang.
    const AGENT_FETCH_TIMEOUT_MS = Number(process.env.WATCHER_AGENT_TIMEOUT_MS ?? 320_000);
    const agentRes = await fetch(this.cfg.agentRunUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(AGENT_FETCH_TIMEOUT_MS),
    });
    if (ackTimer) clearTimeout(ackTimer);
    // Suppress unused warning when ACK was actually sent (used for log).
    void ackSent; void composerOk;
    if (!agentRes.ok) {
      const errBody = await agentRes.text().catch(() => "");
      throw new Error(`agent/run ${agentRes.status}: ${errBody.slice(0, 200)}`);
    }
    const reply = (await agentRes.json()) as { reply?: string };
    if (!reply.reply || !reply.reply.trim()) {
      // Detect dedup case (webhook returned empty + dedup flag) — apply longer
      // cooldown để tránh re-poll ngay lập tức trong khi câu trước còn xử lý.
      const isDedup = (reply as any).dedup === true || (reply as any).silent === true;
      const cdMs = isDedup ? 60_000 : this.cfg.cooldownMs;
      console.log(
        `[watcher] cid=${hit.conversationId} empty reply (dedup=${isDedup}), skip send + cooldown ${cdMs}ms`,
      );
      this.cooldowns.set(hit.conversationId, Date.now() + cdMs);
      return;
    }

    // End-of-session marker: LLM appends `[END_SESSION]` when user said
    // "ok thanks/bye" and no follow-up needed. Skip sending entirely AND
    // apply an extended 5-minute cooldown so we don't reply to incidental
    // chatter ("👍" emoji, etc.) in the same closing burst.
    const END_MARKER = "[END_SESSION]";
    if (reply.reply.includes(END_MARKER)) {
      console.log(`[watcher] cid=${hit.conversationId} END_SESSION marker — skip send, extend cooldown 5min`);
      this.stats.replied++;  // count as handled (vs error)
      this.stats.lastReplyAt = Date.now();
      this.cooldowns.set(hit.conversationId, Date.now() + 5 * 60 * 1000);
      this.lastSeenBadgeKey.delete(hit.conversationId);
      // Re-poll after the long cooldown so we don't miss new conversations.
      const cidEnd = hit.conversationId;
      setTimeout(() => {
        this.cooldowns.delete(cidEnd);
        this.lastSeenBadgeKey.delete(cidEnd);
        if (this.state === "running") void this.pollOnce();
      }, 5 * 60 * 1000 + 1000);
      return;    const ACK_POOL = [
      "Đang xử lý câu hỏi của bạn...",
      "Mình đang nghĩ đây, chờ chút nhé...",
      "Đang tìm thông tin, chờ mình một xíu...",
      "Mình đang check dữ liệu...",
      "Đang xử lý, lát có ngay...",

      // Natural / friendly
      "Để mình xem nhé...",
      "Mình đang kiểm tra thông tin...",
      "Đợi mình chút nha...",
      "Cho mình vài giây nhé...",
      "Mình đang tổng hợp câu trả lời...",
      "Đang phân tích yêu cầu...",
      "Mình đang xử lý thông tin...",
      "Đợi xíu, mình đang check...",
      "Đang lấy dữ liệu mới nhất...",
      "Để mình xử lý thử...",
      "Mình đang xem lại dữ liệu...",
      "Đang chuẩn bị câu trả lời...",
      "Mình đang tìm hướng xử lý phù hợp...",
      "Đang load dữ liệu...",
      "Đợi mình một chút nhé...",

      // PM / work assistant style
      "Mình đang kiểm tra task liên quan...",
      "Đang tra cứu tiến độ công việc...",
      "Mình đang xem thông tin dự án...",
      "Đang tổng hợp trạng thái hiện tại...",
      "Đang lấy dữ liệu từ hệ thống...",
      "Mình đang check deadline và task...",
      "Đang đồng bộ dữ liệu...",
      "Đang tìm thông tin phù hợp...",
      "Đang phân tích yêu cầu công việc...",
      "Mình đang kiểm tra cập nhật mới nhất...",

      // Faster / realtime feel
      "Processing...",
      "Thinking...",
      "Checking...",
      "Loading...",
      "Analyzing request...",
      "Fetching data...",
      "Working on it...",
      "One moment...",
      "Just a sec...",
      "Almost there...",

      // More human-like
      "Hmm, để mình xem...",
      "Câu này mình cần kiểm tra chút...",
      "Đợi mình tra lại nhé...",
      "Mình đang suy nghĩ cách trả lời tốt nhất...",
      "Để mình confirm thông tin...",
      "Mình đang đối chiếu dữ liệu...",
      "Cho mình kiểm tra lại một chút...",
      "Mình đang tìm câu trả lời chính xác nhất...",
    ];
    }

    // Strip marker if it leaked into a non-end reply (defensive).
    const cleanedReply = reply.reply.replace(END_MARKER, "").trim();

    // Close any open thread/reply side panel first — when Gapo opens a
    // thread (clicked on an old message), there are TWO Draft.js editors
    // visible (main + thread panel) and `.first()` may pick the wrong one,
    // sending the reply into a thread instead of the main chat.
    await this.page.keyboard.press("Escape").catch(() => null);
    await this.page.waitForTimeout(300);

    // Type + send via Draft.js editor. The composer may already contain
    // our typing-indicator placeholder ("." or partial ACK fallback if
    // typing failed). Clear with Ctrl+A + Backspace before typing reply.
    // - delay 10ms/char: Gapo accepts; total ~10s for 1000-char reply.
    // - timeout 120s: long replies (1500+ chars) need more than 30s default.
    // - hard cap reply at 2000 chars to keep typing predictable.
    // - `.last()` because the main composer is typically the LAST
    //   Draft.js editor in DOM order (any thread/reply panel renders before).
    const input = this.page.locator('[role=textbox][contenteditable=true].public-DraftEditor-content').last();
    await input.click();
    // Clear any leftover placeholder from typing-indicator step.
    await this.page.keyboard.press("Control+A").catch(() => null);
    await this.page.keyboard.press("Backspace").catch(() => null);
    const textToSend = cleanedReply.slice(0, 2000);
    await input.type(textToSend, { delay: 10, timeout: 120_000 });
    await input.press("Enter");
    await this.page.waitForTimeout(1500);

    // v5: track exact reply text để filter khỏi user-msg detection ở
    // iteration tiếp theo (chống bot reply to self loop).
    this.recordBotText(hit.conversationId, textToSend);

    this.stats.replied++;
    this.stats.lastReplyAt = Date.now();
    this.cooldowns.set(hit.conversationId, Date.now() + this.cfg.cooldownMs);
    console.log(`[watcher] cid=${hit.conversationId} replied (${reply.reply.length} chars)`);

    // ──────────────────────────────────────────────────────────────
    // BUG FIX (2026-05-07 v2): Catch missed messages while bot was busy.
    // While bot was processing + typing reply, user có thể đã gửi
    // tin nhắn thứ 2. Gapo tự mark READ vì watcher đang ở conversation
    // page → không có unread badge → poll sau bị mất tin.
    //
    // Fix: scrape lần nữa NGAY trước khi rời page, so sánh với
    // lastMsg đã reply. Nếu có message mới THỰC SỰ TỪ USER (không phải
    // bot's own reply, không phải ack), re-enqueue.
    //
    // CRITICAL FIX (2026-05-07 v3): v2 detected bot's own reply as
    // follow-up → infinite loop spam. Fix: exclude texts matching
    // (a) reply we just sent (b) ack patterns (c) lastMsg replied to.
    // Cũng add disable flag BOT_POST_REPLY_RESCAN=0 để rollback nhanh
    // nếu vẫn lỗi.
    // ──────────────────────────────────────────────────────────────
    if (process.env.BOT_POST_REPLY_RESCAN !== "0") {
      try {
        const ctxAfter = await this.page.evaluate(`
          (function() {
            const items = Array.from(document.querySelectorAll('[class*="MessageItem"], [class*="message-item"], [class*="MessageRow"]'));
            const recent = items.slice(-5).map(function(el) {
              const author = (el.querySelector('[class*="author"], [class*="Author"]') || {}).textContent || '';
              const body = (el.querySelector('[class*="body"], [class*="Body"], [class*="content"]') || el).textContent || '';
              const isOwn = !!el.querySelector('[class*="own"], [class*="self"], [class*="Mine"]');
              return { author: (author || '').trim().slice(0, 50), body: (body || '').trim().slice(0, 500), isOwn: isOwn };
            });
            return { recent: recent };
          })()
        `) as { recent: Array<{ author: string; body: string; isOwn: boolean }> };

        // Exclusions để không nhầm bot's own message:
        const ourReplyText = textToSend.trim();
        const ourReplyHead = ourReplyText.slice(0, 50);
        // Ack patterns mình type — phải khớp với watcher.ts:488 và
        // bb-pm-tools/src/orchestrator.ts:scheduleAck text.
        const BOT_ACK_RE = /^[\s\u{1F44D}\u{1F44C}\u{1F914}🕐]*(Đang\s+xử\s+lý|Vẫn\s+đang\s+chạy|Mình\s+đang\s+xử\s+lý)/iu;
        // v5: also exclude bằng recentBotTexts (catch reply ngắn không match
        // ourReplyHead startsWith vì DOM split bubble).
        const knownBotTextsRescan = this.recentBotTexts.get(hit.conversationId) ?? [];
        const isBotEchoRescan = (body: string): boolean => {
          const trimmed = body.trim();
          if (!trimmed) return false;
          for (const sent of knownBotTextsRescan) {
            const sentTrim = sent.trim();
            if (!sentTrim) continue;
            if (trimmed === sentTrim) return true;
            if (trimmed.length >= 10 && sentTrim.includes(trimmed)) return true;
            if (sentTrim.length >= 10 && trimmed.includes(sentTrim.slice(0, Math.min(80, sentTrim.length)))) return true;
          }
          return false;
        };
        const lastUserMsg = ctxAfter.recent
          .filter((m) => {
            if (m.isOwn) return false;
            if (this.botName && m.author.includes(this.botName)) return false;
            if (ourReplyHead && m.body.startsWith(ourReplyHead)) return false;
            if (BOT_ACK_RE.test(m.body)) return false;
            if (isBotEchoRescan(m.body)) return false; // v5
            return true;
          })
          .pop();

        // Phải khác lastMsg (cái mình vừa reply) VÀ khác reply text mình vừa type
        const isFollowUp =
          lastUserMsg &&
          lastUserMsg.body &&
          lastUserMsg.body !== lastMsg.body &&
          lastUserMsg.body !== ourReplyText &&
          !ourReplyText.includes(lastUserMsg.body) &&
          !lastUserMsg.body.includes(ourReplyHead);

        if (isFollowUp) {
          console.log(
            `[watcher] cid=${hit.conversationId} POST-REPLY follow-up detected: ` +
              `replied to="${lastMsg.body.slice(0, 40)}", new="${lastUserMsg!.body.slice(0, 40)}"`,
          );
          this.cooldowns.delete(hit.conversationId);
          this.lastSeenBadgeKey.delete(hit.conversationId);
          const followUpHit: IncomingHit = {
            ...hit,
            unreadCountText: `followup-${Date.now()}`,
          };
          setTimeout(() => {
            if (this.state === "running") this.enqueue(followUpHit);
          }, 100);
        } else {
          console.log(
            `[watcher] cid=${hit.conversationId} no follow-up detected (last user msg="${lastUserMsg?.body?.slice(0, 40) ?? "<none>"}", replied="${lastMsg.body.slice(0, 40)}", own="${ourReplyHead}")`,
          );
        }
      } catch (err: any) {
        console.warn(
          `[watcher] cid=${hit.conversationId} post-reply rescan failed: ${err?.message ?? err}`,
        );
      }
    }

    // Navigate back to root. While the page sits on a conversation, Gapo
    // auto-marks subsequent inbound messages from that user as read so no
    // unread badge ever appears in the sidebar — and our observer relies
    // on badges. Bouncing back to the root keeps detection alive.
    await this.page.goto(MESSENGER_ROOT, { waitUntil: "domcontentloaded" }).catch(() => null);
    await this.page.waitForSelector('a[href*="/messenger/"]', { timeout: 15000 }).catch(() => null);
    // Clear lastSeenBadgeKey for this conversation so the next badge with
    // a fresh count is treated as a brand-new hit, not a dedup.
    this.lastSeenBadgeKey.delete(hit.conversationId);

    // Schedule a "cooldown expiry" cleanup: after the cooldown window ends,
    // wipe the dedup key for this cid and force a fresh scan. Without this,
    // messages that arrived DURING cooldown (badge text saved into dedup
    // but skipped) would never be re-noticed because the badge text doesn't
    // change between observer ticks. The poll re-runs detection so the
    // queued unread message gets re-enqueued and processed.
    const cid = hit.conversationId;
    setTimeout(() => {
      this.cooldowns.delete(cid);
      this.lastSeenBadgeKey.delete(cid);
      if (this.state === "running") {
        console.log(`[watcher] cooldown expired cid=${cid} — rescanning`);
        void this.pollOnce();
      }
    }, this.cfg.cooldownMs + 1000);
  }
}

let singleton: MessageWatcher | null = null;

export function getWatcher(cfg: WatcherConfig): MessageWatcher {
  if (!singleton) {
    singleton = new MessageWatcher(cfg);
  }
  return singleton;
}

export function resetWatcherForTests(): void {
  singleton = null;
}
