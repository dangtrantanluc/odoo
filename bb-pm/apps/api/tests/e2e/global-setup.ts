import { execSync } from "node:child_process";
import path from "node:path";
import bcrypt from "bcrypt";
import { PrismaClient } from "@prisma/client";

/**
 * Vitest globalSetup — runs ONCE before the whole suite.
 *
 *  1. Bring up the test DB + Redis containers (compose project bb-pm-test)
 *  2. Wait for Postgres to be ready
 *  3. `prisma migrate deploy` against the test DB
 *  4. Seed a tiny fixture: 1 company, 1 currency, 1 admin, 1 agent service
 *     user, 1 dev user, 1 project, 2 tasks (one overdue)
 *
 *  Returns a teardown fn that stops the containers.
 *
 *  Env contract: the test process needs DATABASE_URL +
 *  AGENT_API_TOKEN + AGENT_USER_EMAIL exported BEFORE any module that
 *  pulls Prisma is imported. We set them here, and individual tests
 *  rely on test-setup.ts to inherit them.
 */

const TEST_DB_URL = "postgres://bbpm_test:bbpm_test_pwd@localhost:5434/bb_pm_test";
const TEST_REDIS_URL = "redis://localhost:6380";
const AGENT_TOKEN = "test-agent-token-deadbeefdeadbeefdeadbeefdeadbeef";
const AGENT_EMAIL = "pm-agent-test@bluebolt.local";

const composeFile = path.resolve(__dirname, "../../../../docker-compose.test.yaml");
const apiDir = path.resolve(__dirname, "../..");

function sh(cmd: string, opts: { quiet?: boolean } = {}) {
  return execSync(cmd, {
    stdio: opts.quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    env: process.env,
  });
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export default async function setup() {
  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.REDIS_URL = TEST_REDIS_URL;
  process.env.AGENT_API_TOKEN = AGENT_TOKEN;
  process.env.AGENT_USER_EMAIL = AGENT_EMAIL;
  process.env.JWT_SECRET = "test-jwt-secret-stable-for-fixtures";
  process.env.NODE_ENV = "test";

  console.log("[e2e] starting test containers…");
  sh(`docker compose -f ${composeFile} up -d`, { quiet: true });

  await waitFor(() => {
    try {
      sh(`docker exec bb_pm_test_db pg_isready -U bbpm_test -d bb_pm_test`, { quiet: true });
      return true;
    } catch {
      return false;
    }
  }, "test postgres");

  console.log("[e2e] applying migrations…");
  sh(`pnpm prisma migrate deploy`, { quiet: false });

  console.log("[e2e] seeding fixtures…");
  const prisma = new PrismaClient({ datasources: { db: { url: TEST_DB_URL } } });
  await seed(prisma);
  await prisma.$disconnect();

  console.log("[e2e] setup ready");

  return async () => {
    if (process.env.E2E_KEEP_CONTAINERS === "1") {
      console.log("[e2e] keeping containers (E2E_KEEP_CONTAINERS=1)");
      return;
    }
    console.log("[e2e] tearing down…");
    sh(`docker compose -f ${composeFile} down -v`, { quiet: true });
  };
}

async function seed(prisma: PrismaClient) {
  // Currency
  const vnd = await prisma.currency.upsert({
    where: { code: "VND" },
    create: { code: "VND", symbol: "₫", rate: 1 },
    update: {},
  });

  // Company
  const company = await prisma.company.upsert({
    where: { code: "TEST" },
    create: { name: "Test Co", code: "TEST", currencyId: vnd.id },
    update: {},
  });

  const passwordHash = await bcrypt.hash("test-password-not-used", 10);

  // Admin
  const admin = await prisma.user.upsert({
    where: { email: "admin@test.local" },
    create: {
      email: "admin@test.local",
      passwordHash,
      fullName: "Test Admin",
      role: "ADMIN",
      companyId: company.id,
    },
    update: {},
  });

  // Agent service user — bb-pm authenticate plugin matches AGENT_USER_EMAIL
  await prisma.user.upsert({
    where: { email: AGENT_EMAIL },
    create: {
      email: AGENT_EMAIL,
      passwordHash,
      fullName: "PM Agent (test)",
      role: "MANAGER",
      companyId: company.id,
    },
    update: {},
  });

  // Dev user (for tasks)
  const dev = await prisma.user.upsert({
    where: { email: "dev@test.local" },
    create: {
      email: "dev@test.local",
      passwordHash,
      fullName: "Test Dev",
      role: "MEMBER",
      companyId: company.id,
    },
    update: {},
  });

  // Project
  const project = await prisma.project.upsert({
    where: { code: "TEST-PRJ" },
    create: {
      name: "Test Project",
      code: "TEST-PRJ",
      status: "IN_PROGRESS",
      ownerId: admin.id,
      companyId: company.id,
      currencyId: vnd.id,
    },
    update: {},
  });

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 5);
  const future = new Date();
  future.setDate(future.getDate() + 7);

  await prisma.task.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      name: "Overdue task",
      projectId: project.id,
      companyId: company.id,
      assigneeId: dev.id,
      currencyId: vnd.id,
      deadline: yesterday,
      status: "IN_PROGRESS",
      priority: "HIGH",
    },
    update: { deadline: yesterday, status: "IN_PROGRESS" },
  });

  await prisma.task.upsert({
    where: { id: 2 },
    create: {
      id: 2,
      name: "Future task",
      projectId: project.id,
      companyId: company.id,
      assigneeId: dev.id,
      currencyId: vnd.id,
      deadline: future,
      status: "TODO",
      priority: "MEDIUM",
    },
    update: { deadline: future, status: "TODO" },
  });
}
