import "dotenv/config";
import path from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import jwtPlugin from "@fastify/jwt";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import prismaPlugin from "./plugins/prisma.js";
import authPlugin from "./plugins/auth.js";
import errorHandler from "./plugins/errorHandler.js";
import authRoutes from "./modules/auth/routes.js";
import usersRoutes from "./modules/users/routes.js";
import projectsRoutes from "./modules/projects/routes.js";
import tasksRoutes from "./modules/tasks/routes.js";
import milestonesRoutes from "./modules/milestones/routes.js";
import backlogsRoutes from "./modules/backlogs/routes.js";
import membersRoutes from "./modules/members/routes.js";
import ratesRoutes from "./modules/rates/routes.js";
import tagsRoutes from "./modules/tags/routes.js";
import customersRoutes from "./modules/customers/routes.js";
import scopesRoutes from "./modules/scopes/routes.js";
import dashboardRoutes from "./modules/dashboard/routes.js";
import uploadsRoutes from "./modules/uploads/routes.js";
import adminUsersRoutes from "./modules/admin/users/routes.js";
import companyAdminRoutes from "./modules/admin/company/routes.js";
import currenciesRoutes from "./modules/admin/currencies/routes.js";
import notificationsRoutes from "./modules/notifications/routes.js";

async function bootstrap() {
  const app = Fastify({
    logger: {
      transport: process.env.NODE_ENV === "production" ? undefined : { target: "pino-pretty" },
    },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: (process.env.CORS_ORIGIN ?? "http://localhost:5173").split(","),
    credentials: true,
  });
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
  await app.register(jwtPlugin, {
    secret: process.env.JWT_SECRET ?? "dev-secret-change-me",
  });
  await app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024 } });

  const uploadDir = path.resolve(process.env.UPLOAD_DIR ?? "./uploads");
  await app.register(fastifyStatic, {
    root: uploadDir,
    prefix: "/uploads/",
    decorateReply: false,
  });

  await app.register(prismaPlugin);
  await app.register(authPlugin);
  errorHandler(app);

  app.get("/api/v1/health", async () => {
    const dbOk = await app.prisma.$queryRawUnsafe("SELECT 1").then(() => true).catch(() => false);
    return { status: "ok", db: dbOk ? "ok" : "down", uptime: process.uptime() };
  });

  await app.register(authRoutes, { prefix: "/api/v1/auth" });
  await app.register(usersRoutes, { prefix: "/api/v1" });
  await app.register(projectsRoutes, { prefix: "/api/v1/projects" });
  await app.register(tasksRoutes, { prefix: "/api/v1/tasks" });
  await app.register(milestonesRoutes, { prefix: "/api/v1/milestones" });
  await app.register(backlogsRoutes, { prefix: "/api/v1/backlogs" });
  await app.register(membersRoutes, { prefix: "/api/v1/members" });
  await app.register(ratesRoutes, { prefix: "/api/v1/rates" });
  await app.register(tagsRoutes, { prefix: "/api/v1/tags" });
  await app.register(customersRoutes, { prefix: "/api/v1/customers" });
  await app.register(scopesRoutes, { prefix: "/api/v1/scopes" });
  await app.register(dashboardRoutes, { prefix: "/api/v1/dashboard" });
  await app.register(uploadsRoutes, { prefix: "/api/v1/uploads" });
  await app.register(adminUsersRoutes, { prefix: "/api/v1/admin/users" });
  await app.register(companyAdminRoutes, { prefix: "/api/v1/admin/company" });
  await app.register(currenciesRoutes, { prefix: "/api/v1/admin/currencies" });
  await app.register(notificationsRoutes, { prefix: "/api/v1/notifications" });

  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info(`bb-pm API listening on :${port}`);
}

bootstrap().catch((e) => {
  console.error(e);
  process.exit(1);
});
