import { IncomingMessage, ServerResponse } from "http";
import { loadEnv } from "./env";

// Load env FIRST so process.env is populated before any other module reads
// it. config.ts and the AGENT_RUN_URL constant below both touch process.env
// at module load.
loadEnv();

import { assertConfig, config } from "./config";
import {
  gapoFindUser,
  gapoFindAndOpenDm,
  gapoSendDm,
  gapoReadThread,
  gapoGetUserStatus,
} from "./gapo-actions";
import { hasStoredAuth } from "./browser";
import { checkDmThrottle, recordDmSent } from "./throttle";
import { getWatcher } from "./watcher";

const AGENT_RUN_URL =
  process.env.AGENT_RUN_URL ?? "http://localhost:18789/api/plugins/bb-pm/agent/run";

interface OpenClawApi {
  registerHttpRoute: (opts: {
    path: string;
    auth: "plugin";
    match: "exact";
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  }) => void;
}

function methodNotAllowed(res: ServerResponse): boolean {
  res.writeHead(405, { "Content-Type": "text/plain" });
  res.end("Method Not Allowed");
  return true;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      raw += c;
      if (raw.length > 1_048_576) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error("bad json")); }
    });
    req.on("error", reject);
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function checkPluginToken(req: IncomingMessage): boolean {
  const t = req.headers["x-plugin-token"];
  return typeof t === "string" && t === config.auth.pluginToken;
}

async function withTokenAuth(
  req: IncomingMessage,
  res: ServerResponse,
  fn: () => Promise<unknown>,
): Promise<boolean> {
  if (!checkPluginToken(req)) {
    writeJson(res, 401, { error: "invalid plugin token" });
    return true;
  }
  try {
    const result = await fn();
    writeJson(res, 200, result);
  } catch (err: any) {
    console.error("[browser-tools]", err?.message || err);
    writeJson(res, 500, { error: err?.message || "internal" });
  }
  return true;
}

export default function register(api: OpenClawApi): void {
  const missing = assertConfig();
  if (missing.length > 0) {
    console.warn(`[browser-tools] missing env: ${missing.join(", ")} — plugin will reject requests`);
  }

  api.registerHttpRoute({
    path: "/api/plugins/browser-tools/health",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      if (req.method !== "GET") return methodNotAllowed(res);
      writeJson(res, 200, {
        ok: true,
        authStored: hasStoredAuth(),
        baseUrl: config.gapo.baseUrl,
      });
      return true;
    },
  });

  // POST /find-user { query }
  api.registerHttpRoute({
    path: "/api/plugins/browser-tools/find-user",
    auth: "plugin",
    match: "exact",
    handler: (req, res) => {
      if (req.method !== "POST") return Promise.resolve(methodNotAllowed(res));
      return withTokenAuth(req, res, async () => {
        const body = (await readBody(req)) as { query?: string };
        if (!body.query) throw new Error("query required");
        const users = await gapoFindUser(body.query);
        return { users };
      });
    },
  });

  // POST /find-and-open-dm { query } — search org + click DM icon to get
  // the conversationId. Returns { conversationId, name } or null.
  api.registerHttpRoute({
    path: "/api/plugins/browser-tools/find-and-open-dm",
    auth: "plugin",
    match: "exact",
    handler: (req, res) => {
      if (req.method !== "POST") return Promise.resolve(methodNotAllowed(res));
      return withTokenAuth(req, res, async () => {
        const body = (await readBody(req)) as { query?: string };
        if (!body.query) throw new Error("query required");
        const result = await gapoFindAndOpenDm(body.query);
        return result ?? { found: false };
      });
    },
  });

  // POST /send-dm { externalId, text }
  api.registerHttpRoute({
    path: "/api/plugins/browser-tools/send-dm",
    auth: "plugin",
    match: "exact",
    handler: (req, res) => {
      if (req.method !== "POST") return Promise.resolve(methodNotAllowed(res));
      return withTokenAuth(req, res, async () => {
        const body = (await readBody(req)) as { externalId?: string; text?: string };
        if (!body.externalId) throw new Error("externalId required");
        if (!body.text) throw new Error("text required");
        const throttle = checkDmThrottle();
        if (!throttle.ok) {
          return { sent: false, reason: "throttled", retryAfterSec: throttle.retryAfterSec };
        }
        const result = await gapoSendDm(body.externalId, body.text);
        recordDmSent();
        return { sent: true, ...result };
      });
    },
  });

  // POST /read-thread { externalId, sinceMessageId? }
  api.registerHttpRoute({
    path: "/api/plugins/browser-tools/read-thread",
    auth: "plugin",
    match: "exact",
    handler: (req, res) => {
      if (req.method !== "POST") return Promise.resolve(methodNotAllowed(res));
      return withTokenAuth(req, res, async () => {
        const body = (await readBody(req)) as { externalId?: string; sinceMessageId?: string };
        if (!body.externalId) throw new Error("externalId required");
        const messages = await gapoReadThread(body.externalId, body.sinceMessageId);
        return { messages };
      });
    },
  });

  // POST /user-status { externalId }
  api.registerHttpRoute({
    path: "/api/plugins/browser-tools/user-status",
    auth: "plugin",
    match: "exact",
    handler: (req, res) => {
      if (req.method !== "POST") return Promise.resolve(methodNotAllowed(res));
      return withTokenAuth(req, res, async () => {
        const body = (await readBody(req)) as { externalId?: string };
        if (!body.externalId) throw new Error("externalId required");
        return await gapoGetUserStatus(body.externalId);
      });
    },
  });

  // ── Watcher endpoints ─────────────────────────────────────────────
  // POST /watcher/start — boot up the message watcher (idempotent if already running)
  api.registerHttpRoute({
    path: "/api/plugins/browser-tools/watcher/start",
    auth: "plugin",
    match: "exact",
    handler: (req, res) => {
      if (req.method !== "POST") return Promise.resolve(methodNotAllowed(res));
      return withTokenAuth(req, res, async () => {
        const w = getWatcher({ agentRunUrl: AGENT_RUN_URL });
        const status = w.status();
        if (status.state !== "stopped") {
          return { ok: true, alreadyRunning: true, status };
        }
        await w.start();
        return { ok: true, status: w.status() };
      });
    },
  });

  // POST /watcher/stop — shut down the watcher
  api.registerHttpRoute({
    path: "/api/plugins/browser-tools/watcher/stop",
    auth: "plugin",
    match: "exact",
    handler: (req, res) => {
      if (req.method !== "POST") return Promise.resolve(methodNotAllowed(res));
      return withTokenAuth(req, res, async () => {
        const w = getWatcher({ agentRunUrl: AGENT_RUN_URL });
        await w.stop();
        return { ok: true, status: w.status() };
      });
    },
  });

  // GET /watcher/status — observability endpoint
  api.registerHttpRoute({
    path: "/api/plugins/browser-tools/watcher/status",
    auth: "plugin",
    match: "exact",
    handler: (req, res) => {
      if (req.method !== "GET") return Promise.resolve(methodNotAllowed(res));
      return withTokenAuth(req, res, async () => {
        const w = getWatcher({ agentRunUrl: AGENT_RUN_URL });
        return w.status();
      });
    },
  });

  // POST /watcher/reset — clear cooldowns + dedup memory (debug helper)
  api.registerHttpRoute({
    path: "/api/plugins/browser-tools/watcher/reset",
    auth: "plugin",
    match: "exact",
    handler: (req, res) => {
      if (req.method !== "POST") return Promise.resolve(methodNotAllowed(res));
      return withTokenAuth(req, res, async () => {
        const w = getWatcher({ agentRunUrl: AGENT_RUN_URL });
        return w.reset();
      });
    },
  });

  // POST /watcher/kick — force a re-scan now (skip the 10s wait), navigates
  // back to messenger root so badges that got hidden behind an open chat
  // become visible again.
  api.registerHttpRoute({
    path: "/api/plugins/browser-tools/watcher/kick",
    auth: "plugin",
    match: "exact",
    handler: (req, res) => {
      if (req.method !== "POST") return Promise.resolve(methodNotAllowed(res));
      return withTokenAuth(req, res, async () => {
        const w = getWatcher({ agentRunUrl: AGENT_RUN_URL });
        return await w.kick();
      });
    },
  });

  console.log("[browser-tools] registered 10 routes (health + 4 actions + watcher start/stop/status/reset/kick)");

  // Optional auto-start: when BROWSER_TOOLS_AUTO_START_WATCHER=1, boot the
  // watcher a few seconds after registration. Delay lets the gateway finish
  // wiring all plugins (so `/agent/run` is reachable) before the watcher
  // starts processing inbound DMs.
  const autoStart = (process.env.BROWSER_TOOLS_AUTO_START_WATCHER ?? "0") === "1";
  if (autoStart && hasStoredAuth()) {
    setTimeout(() => {
      void (async () => {
        try {
          const w = getWatcher({ agentRunUrl: AGENT_RUN_URL });
          if (w.status().state === "stopped") {
            console.log("[browser-tools] auto-starting watcher (BROWSER_TOOLS_AUTO_START_WATCHER=1)");
            await w.start();
          }
        } catch (err: any) {
          console.error("[browser-tools] auto-start failed:", err?.message ?? err);
        }
      })();
    }, 8000);
  }
}
