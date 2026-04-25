import Fastify, { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";

import prismaPlugin from "../../src/plugins/prisma.js";
import authPlugin from "../../src/plugins/auth.js";
import errorHandler from "../../src/plugins/errorHandler.js";
import jwtPlugin from "@fastify/jwt";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import agentRoutes from "../../src/modules/agent/routes.js";
import tasksRoutes from "../../src/modules/tasks/routes.js";
import projectsRoutes from "../../src/modules/projects/routes.js";
import meetingsRoutes from "../../src/modules/meetings/routes.js";

let app: FastifyInstance | null = null;
let prisma: PrismaClient | null = null;

/**
 * Build a minimal Fastify instance for tests. Skips CORS / static / multipart /
 * helmet because they're irrelevant to integration tests of the agent surface.
 * Returns a singleton — call `closeApp()` from a test-suite afterAll.
 */
export async function buildApp(): Promise<FastifyInstance> {
  if (app) return app;
  const a = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  a.setValidatorCompiler(validatorCompiler);
  a.setSerializerCompiler(serializerCompiler);

  await a.register(jwtPlugin, { secret: process.env.JWT_SECRET ?? "test-secret" });
  await a.register(prismaPlugin);
  await a.register(authPlugin);
  errorHandler(a);

  await a.register(agentRoutes, { prefix: "/api/v1/agent" });
  await a.register(tasksRoutes, { prefix: "/api/v1/tasks" });
  await a.register(projectsRoutes, { prefix: "/api/v1/projects" });
  await a.register(meetingsRoutes, { prefix: "/api/v1/meetings" });

  await a.ready();
  app = a;
  return a;
}

export function getPrisma(): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL } },
    });
  }
  return prisma;
}

export async function closeApp() {
  if (app) await app.close();
  if (prisma) await prisma.$disconnect();
  app = null;
  prisma = null;
}

export const agentHeaders = () => ({
  "X-Agent-Token": process.env.AGENT_API_TOKEN as string,
  "Content-Type": "application/json",
});
