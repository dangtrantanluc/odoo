import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

async function main() {
  // ── Currencies ──────────────────────────────────────
  const vnd = await prisma.currency.upsert({
    where: { code: "VND" },
    update: {},
    create: { code: "VND", symbol: "₫", rate: 1 },
  });
  const usd = await prisma.currency.upsert({
    where: { code: "USD" },
    update: {},
    create: { code: "USD", symbol: "$", rate: 24000 },
  });

  // ── Company ─────────────────────────────────────────
  const company = await prisma.company.upsert({
    where: { code: "BLUEBOLT" },
    update: {},
    create: { name: "BlueBolt", code: "BLUEBOLT", currencyId: vnd.id },
  });

  // ── Users ───────────────────────────────────────────
  const adminPwd = await bcrypt.hash("admin123", 10);
  const demoPwd = await bcrypt.hash("password123", 10);

  const admin = await prisma.user.upsert({
    where: { email: "admin@bluebolt.local" },
    update: {},
    create: {
      email: "admin@bluebolt.local",
      passwordHash: adminPwd,
      fullName: "BB Admin",
      role: "ADMIN",
      companyId: company.id,
      isSuperAdmin: true,
    },
  });
  const pm = await prisma.user.upsert({
    where: { email: "pm@bluebolt.local" },
    update: {},
    create: {
      email: "pm@bluebolt.local",
      passwordHash: demoPwd,
      fullName: "Project Manager",
      role: "MANAGER",
      companyId: company.id,
    },
  });
  const dev1 = await prisma.user.upsert({
    where: { email: "dev1@bluebolt.local" },
    update: {},
    create: {
      email: "dev1@bluebolt.local",
      passwordHash: demoPwd,
      fullName: "Nguyen Van A",
      role: "MEMBER",
      companyId: company.id,
    },
  });
  const dev2 = await prisma.user.upsert({
    where: { email: "dev2@bluebolt.local" },
    update: {},
    create: {
      email: "dev2@bluebolt.local",
      passwordHash: demoPwd,
      fullName: "Tran Thi B",
      role: "MEMBER",
      companyId: company.id,
    },
  });
  const viewer = await prisma.user.upsert({
    where: { email: "viewer@bluebolt.local" },
    update: {},
    create: {
      email: "viewer@bluebolt.local",
      passwordHash: demoPwd,
      fullName: "Observer",
      role: "VIEWER",
      companyId: company.id,
    },
  });

  // ── Customers ───────────────────────────────────────
  const acme = await upsertCustomer("ACME Corp", "contact@acme.test");
  const globex = await upsertCustomer("Globex Inc", "hello@globex.test");

  // ── Tags ────────────────────────────────────────────
  const tagNames = ["Bug", "Feature", "Urgent", "Refactor", "Research"];
  const tags: Record<string, number> = {};
  for (const name of tagNames) {
    const t = await prisma.tag.upsert({
      where: { name },
      update: {},
      create: { name, color: Math.floor(Math.random() * 11) },
    });
    tags[name] = t.id;
  }

  // ── Projects ────────────────────────────────────────
  if ((await prisma.project.count()) === 0) {
    const p1 = await prisma.project.create({
      data: {
        name: "Website Revamp",
        code: "WR-2026",
        status: "IN_PROGRESS",
        priority: "HIGH",
        startDate: new Date("2026-01-05"),
        endDate: new Date("2026-06-30"),
        description: "Xây lại landing + dashboard khách hàng",
        budget: 500_000_000,
        estimatedTotalCost: 420_000_000,
        estimatedTotalHours: 1200,
        ownerId: pm.id,
        companyId: company.id,
        customerId: acme.id,
        accountManagerId: admin.id,
        currencyId: vnd.id,
        tags: { create: [{ tagId: tags["Feature"] }, { tagId: tags["Urgent"] }] },
      },
    });
    const p2 = await prisma.project.create({
      data: {
        name: "Mobile App v2",
        code: "MA-V2",
        status: "PLANNED",
        priority: "MEDIUM",
        startDate: new Date("2026-05-01"),
        endDate: new Date("2026-10-31"),
        description: "Rewrite app React Native → Flutter",
        budget: 800_000_000,
        estimatedTotalCost: 650_000_000,
        estimatedTotalHours: 1800,
        ownerId: pm.id,
        companyId: company.id,
        customerId: globex.id,
        currencyId: vnd.id,
        tags: { create: [{ tagId: tags["Feature"] }, { tagId: tags["Research"] }] },
      },
    });
    const p3 = await prisma.project.create({
      data: {
        name: "Internal Tools",
        code: "INT-TOOLS",
        status: "ON_HOLD",
        priority: "LOW",
        description: "Nâng cấp công cụ nội bộ",
        budget: 120_000_000,
        estimatedTotalHours: 400,
        ownerId: admin.id,
        companyId: company.id,
        currencyId: vnd.id,
        tags: { create: [{ tagId: tags["Refactor"] }] },
      },
    });

    // ── Milestones ────────────────────────────────────
    const ms1 = await prisma.milestone.create({
      data: { projectId: p1.id, name: "Design phase", status: "done", dueDate: new Date("2026-02-15") },
    });
    const ms2 = await prisma.milestone.create({
      data: { projectId: p1.id, name: "MVP launch", status: "in_progress", dueDate: new Date("2026-04-30") },
    });

    // ── Members + Rates ───────────────────────────────
    const m1 = await prisma.member.create({ data: { projectId: p1.id, userId: pm.id, role: "PM" } });
    const m2 = await prisma.member.create({ data: { projectId: p1.id, userId: dev1.id, role: "Dev" } });
    const m3 = await prisma.member.create({ data: { projectId: p1.id, userId: dev2.id, role: "Dev" } });
    const m4 = await prisma.member.create({ data: { projectId: p2.id, userId: dev1.id, role: "Lead" } });

    await prisma.memberRate.createMany({
      data: [
        { memberId: m1.id, projectId: p1.id, userId: pm.id, currencyId: vnd.id, effectiveFrom: new Date("2026-01-01"), costPerHour: 500_000 },
        { memberId: m2.id, projectId: p1.id, userId: dev1.id, currencyId: vnd.id, effectiveFrom: new Date("2026-01-01"), costPerHour: 300_000 },
        { memberId: m3.id, projectId: p1.id, userId: dev2.id, currencyId: vnd.id, effectiveFrom: new Date("2026-01-01"), costPerHour: 280_000 },
        { memberId: m4.id, projectId: p2.id, userId: dev1.id, currencyId: vnd.id, effectiveFrom: new Date("2026-05-01"), costPerHour: 350_000 },
      ],
    });

    // ── Scopes ────────────────────────────────────────
    await prisma.scope.createMany({
      data: [
        { projectId: p1.id, sequence: 10, name: "Homepage redesign", estimatedHours: 80, estimatedRate: 300_000, estimatedCost: 24_000_000, currencyId: vnd.id },
        { projectId: p1.id, sequence: 20, name: "Customer dashboard", estimatedHours: 200, estimatedRate: 300_000, estimatedCost: 60_000_000, currencyId: vnd.id },
        { projectId: p1.id, sequence: 30, name: "SEO optimization", estimatedHours: 40, estimatedRate: 400_000, estimatedCost: 16_000_000, currencyId: vnd.id },
      ],
    });

    // ── Tasks ─────────────────────────────────────────
    const t1 = await prisma.task.create({
      data: {
        projectId: p1.id, companyId: company.id, milestoneId: ms1.id, currencyId: vnd.id,
        name: "Wireframe homepage", status: "DONE", priority: "HIGH",
        assigneeId: dev1.id, deadline: new Date("2026-02-10"),
        tags: { create: [{ tagId: tags["Feature"] }] },
      },
    });
    const t2 = await prisma.task.create({
      data: {
        projectId: p1.id, companyId: company.id, milestoneId: ms2.id, currencyId: vnd.id,
        name: "Build dashboard KPI cards", status: "IN_PROGRESS", priority: "MEDIUM",
        assigneeId: dev2.id, deadline: new Date("2026-04-15"),
        tags: { create: [{ tagId: tags["Feature"] }] },
      },
    });
    const t3 = await prisma.task.create({
      data: {
        projectId: p1.id, companyId: company.id, milestoneId: ms2.id, currencyId: vnd.id,
        name: "Fix login redirect bug", status: "REVIEW", priority: "URGENT",
        assigneeId: dev1.id,
        tags: { create: [{ tagId: tags["Bug"] }, { tagId: tags["Urgent"] }] },
      },
    });
    const t4 = await prisma.task.create({
      data: {
        projectId: p2.id, companyId: company.id, currencyId: vnd.id,
        name: "Research Flutter vs RN", status: "TODO", priority: "HIGH",
        assigneeId: dev1.id,
        tags: { create: [{ tagId: tags["Research"] }] },
      },
    });

    // ── Backlogs (some APPROVED so totals roll up) ────
    const today = new Date();
    const daysAgo = (n: number) => new Date(today.getTime() - n * 86400_000);
    await prisma.backlog.createMany({
      data: [
        { taskId: t1.id, projectId: p1.id, companyId: company.id, userId: dev1.id, currencyId: vnd.id,
          workDate: daysAgo(20), hours: 8, description: "Initial wireframes",
          status: "APPROVED", approverId: admin.id, approvedAt: daysAgo(19),
          costPerHourSnapshot: 300_000, totalCostSnapshot: 2_400_000 },
        { taskId: t1.id, projectId: p1.id, companyId: company.id, userId: dev1.id, currencyId: vnd.id,
          workDate: daysAgo(18), hours: 6, description: "Iterate on feedback",
          status: "APPROVED", approverId: admin.id, approvedAt: daysAgo(17),
          costPerHourSnapshot: 300_000, totalCostSnapshot: 1_800_000 },
        { taskId: t2.id, projectId: p1.id, companyId: company.id, userId: dev2.id, currencyId: vnd.id,
          workDate: daysAgo(5), hours: 7, description: "KPI card components",
          status: "APPROVED", approverId: admin.id, approvedAt: daysAgo(4),
          costPerHourSnapshot: 280_000, totalCostSnapshot: 1_960_000 },
        { taskId: t2.id, projectId: p1.id, companyId: company.id, userId: dev2.id, currencyId: vnd.id,
          workDate: daysAgo(2), hours: 5, description: "Wire up API",
          status: "PENDING",
          costPerHourSnapshot: 280_000, totalCostSnapshot: 1_400_000 },
        { taskId: t3.id, projectId: p1.id, companyId: company.id, userId: dev1.id, currencyId: vnd.id,
          workDate: daysAgo(1), hours: 3, description: "Debug auth flow",
          status: "PENDING",
          costPerHourSnapshot: 300_000, totalCostSnapshot: 900_000 },
      ],
    });

    // ── Recompute rollups once (for cache columns) ────
    await prisma.$executeRawUnsafe(`
      UPDATE tasks t SET
        total_cost = COALESCE((SELECT SUM(total_cost_snapshot) FROM backlogs WHERE task_id = t.id AND status = 'APPROVED'), 0),
        total_hours = COALESCE((SELECT SUM(hours) FROM backlogs WHERE task_id = t.id AND status = 'APPROVED'), 0)
    `);
    await prisma.$executeRawUnsafe(`
      UPDATE projects p SET
        total_cost       = COALESCE((SELECT SUM(t.total_cost) FROM tasks t WHERE t.project_id = p.id), 0),
        total_hours      = COALESCE((SELECT SUM(t.total_hours) FROM tasks t WHERE t.project_id = p.id), 0),
        task_count       = (SELECT COUNT(*) FROM tasks WHERE project_id = p.id),
        member_count     = (SELECT COUNT(*) FROM members WHERE project_id = p.id),
        backlog_count    = (SELECT COUNT(*) FROM backlogs WHERE project_id = p.id),
        scope_count      = (SELECT COUNT(*) FROM scopes WHERE project_id = p.id),
        milestone_count  = (SELECT COUNT(*) FROM milestones WHERE project_id = p.id),
        budget_remaining = COALESCE(budget, 0) - COALESCE((SELECT SUM(t.total_cost) FROM tasks t WHERE t.project_id = p.id), 0)
    `);
    await prisma.$executeRawUnsafe(`
      UPDATE milestones m SET
        task_count = (SELECT COUNT(*) FROM tasks WHERE milestone_id = m.id),
        done_count = (SELECT COUNT(*) FROM tasks WHERE milestone_id = m.id AND status = 'DONE'),
        completion_pct = CASE
          WHEN (SELECT COUNT(*) FROM tasks WHERE milestone_id = m.id) = 0 THEN 0
          ELSE (SELECT 100 * COUNT(*) FILTER (WHERE status='DONE') / NULLIF(COUNT(*),0) FROM tasks WHERE milestone_id = m.id)
        END
    `);
  }

  console.log("✓ Seed completed");
  console.log("  Login accounts (tất cả password: 'admin123' cho admin, 'password123' cho còn lại):");
  console.log("    admin@bluebolt.local   ADMIN");
  console.log("    pm@bluebolt.local      MANAGER");
  console.log("    dev1@bluebolt.local    MEMBER");
  console.log("    dev2@bluebolt.local    MEMBER");
  console.log("    viewer@bluebolt.local  VIEWER");
}

async function upsertCustomer(name: string, email: string) {
  const existing = await prisma.customer.findFirst({ where: { name } });
  if (existing) return existing;
  return prisma.customer.create({ data: { name, email } });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
