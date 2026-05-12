import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import type { Role } from "@prisma/client";

export type AuthUser = {
  id: number;
  email: string;
  role: Role;
  companyId: number;
  isSuperAdmin: boolean;
  // true when request was authenticated via X-Agent-Token instead of JWT.
  isAgent?: boolean;
};

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (...roles: Role[]) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: number; email: string; role: Role; companyId: number; isSuperAdmin: boolean };
    user: AuthUser;
  }
}

// Cache the PM agent service user so /agent/* routes don't hit the DB on
// every request. Invalidated on process restart only — token rotation
// therefore requires a restart, which is fine.
let cachedAgentUser: AuthUser | null = null;

async function resolveAgentUser(app: any): Promise<AuthUser | null> {
  if (cachedAgentUser) return cachedAgentUser;
  const email = process.env.AGENT_USER_EMAIL ?? "pm-agent@bluebolt.local";
  const row = await app.prisma.user.findUnique({ where: { email } });
  if (!row) return null;
  cachedAgentUser = {
    id: row.id,
    email: row.email,
    role: row.role,
    companyId: row.companyId,
    isSuperAdmin: row.isSuperAdmin,
    isAgent: true,
  };
  return cachedAgentUser;
}

const authPlugin: FastifyPluginAsync = async (app) => {
  app.decorate("authenticate", async (req: FastifyRequest, reply: FastifyReply) => {
    // ── X-Agent-Token path ─────────────────────────────────────────────
    // Used by bb-pm-tools (OpenClaw plugin) to authenticate as the
    // pm-agent service user. Bypasses JWT entirely.
    const agentToken = req.headers["x-agent-token"];
    if (typeof agentToken === "string" && agentToken.length > 0) {
      const expected = process.env.AGENT_API_TOKEN ?? "";
      if (!expected) {
        return reply.code(503).send({
          error: { code: "AGENT_NOT_CONFIGURED", message: "AGENT_API_TOKEN not set on server" },
        });
      }
      if (agentToken !== expected) {
        return reply.code(401).send({
          error: { code: "UNAUTHORIZED", message: "Invalid agent token" },
        });
      }
      const user = await resolveAgentUser(app);
      if (!user) {
        return reply.code(503).send({
          error: { code: "AGENT_USER_MISSING", message: "pm-agent service user not seeded" },
        });
      }
      (req as any).user = user;
      return;
    }

    // ── JWT path (existing) ────────────────────────────────────────────
    try {
      const payload = await req.jwtVerify<{ sub: number; role: Role; companyId: number; isSuperAdmin: boolean; email: string }>();
      (req as any).user = {
        id: payload.sub,
        email: payload.email,
        role: payload.role,
        companyId: payload.companyId,
        isSuperAdmin: payload.isSuperAdmin,
      } satisfies AuthUser;
    } catch {
      reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Invalid or expired token" } });
    }
  });

  app.decorate("requireRole", (...roles: Role[]) => async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    if (req.user.isSuperAdmin) return;
    if (!roles.includes(req.user.role)) {
      reply.code(403).send({ error: { code: "FORBIDDEN", message: "Insufficient role" } });
    }
  });
};

export default fp(authPlugin, { name: "auth", dependencies: ["prisma"] });
