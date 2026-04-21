import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import type { Role } from "@prisma/client";

export type AuthUser = {
  id: number;
  email: string;
  role: Role;
  companyId: number;
  isSuperAdmin: boolean;
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

const authPlugin: FastifyPluginAsync = async (app) => {
  app.decorate("authenticate", async (req: FastifyRequest, reply: FastifyReply) => {
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
