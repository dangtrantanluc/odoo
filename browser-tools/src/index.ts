import { IncomingMessage, ServerResponse } from "http";
import { loadEnv } from "./env";
import { assertConfig, config } from "./config";
import {
  gapoFindUser,
  gapoSendDm,
  gapoReadThread,
  gapoGetUserStatus,
} from "./gapo-actions";
import { hasStoredAuth } from "./browser";
import { checkDmThrottle, recordDmSent } from "./throttle";

loadEnv();

interface OpenClawApi {
  registerHttpRoute: (opts: {
    path: string;
    auth?: "plugin-token" | "none";
    match?: { method?: string };
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  }) => void;
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
    match: { method: "GET" },
    handler: async (_req, res) => {
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
    match: { method: "POST" },
    handler: (req, res) =>
      withTokenAuth(req, res, async () => {
        const body = (await readBody(req)) as { query?: string };
        if (!body.query) throw new Error("query required");
        const users = await gapoFindUser(body.query);
        return { users };
      }),
  });

  // POST /send-dm { externalId, text }
  api.registerHttpRoute({
    path: "/api/plugins/browser-tools/send-dm",
    match: { method: "POST" },
    handler: (req, res) =>
      withTokenAuth(req, res, async () => {
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
      }),
  });

  // POST /read-thread { externalId, sinceMessageId? }
  api.registerHttpRoute({
    path: "/api/plugins/browser-tools/read-thread",
    match: { method: "POST" },
    handler: (req, res) =>
      withTokenAuth(req, res, async () => {
        const body = (await readBody(req)) as { externalId?: string; sinceMessageId?: string };
        if (!body.externalId) throw new Error("externalId required");
        const messages = await gapoReadThread(body.externalId, body.sinceMessageId);
        return { messages };
      }),
  });

  // POST /user-status { externalId }
  api.registerHttpRoute({
    path: "/api/plugins/browser-tools/user-status",
    match: { method: "POST" },
    handler: (req, res) =>
      withTokenAuth(req, res, async () => {
        const body = (await readBody(req)) as { externalId?: string };
        if (!body.externalId) throw new Error("externalId required");
        return await gapoGetUserStatus(body.externalId);
      }),
  });

  console.log("[browser-tools] registered 5 routes (health + 4 actions)");
}
