/**
 * Migrate data from Odoo DB (bb_project_management module) into bb_pm DB.
 *
 * Usage:
 *   pnpm --filter @bb-pm/api migrate:odoo              # incremental
 *   pnpm --filter @bb-pm/api migrate:odoo -- --reset   # truncate bb_pm tables first
 *
 * Reads from:  ODOO_DATABASE_URL   (default postgres://admin:admin123@localhost:5432/odoo)
 * Writes to:   DATABASE_URL        (bb_pm)
 */
import { PrismaClient } from "@prisma/client";
import { Client as PgClient } from "pg";
import bcrypt from "bcrypt";
import "dotenv/config";

const prisma = new PrismaClient();
const odoo = new PgClient({
  connectionString: process.env.ODOO_DATABASE_URL ?? "postgres://admin:admin123@localhost:5432/odoo",
});

const reset = process.argv.includes("--reset");

// A temporary password for every migrated user — they must use "Forgot password"
// since Odoo's passlib bcrypt is not 1:1 with node-bcrypt in all cases.
const TEMP_PASSWORD = "changeme123";

type IdMap = Map<number, number>;
const maps = {
  currency: new Map<number, number>(),
  company: new Map<number, number>(),
  user: new Map<number, number>(),
  customer: new Map<number, number>(),
  tag: new Map<number, number>(),
  project: new Map<number, number>(),
  milestone: new Map<number, number>(),
  scope: new Map<number, number>(),
  member: new Map<number, number>(),
  task: new Map<number, number>(),
} satisfies Record<string, IdMap>;

async function truncateAll() {
  console.log("⚠ Truncating bb_pm tables…");
  const tables = [
    "gapo_user_maps",
    "task_tags",
    "project_tags",
    "backlogs",
    "tasks",
    "scopes",
    "milestones",
    "member_rates",
    "members",
    "projects",
    "tags",
    "customers",
    "refresh_tokens",
    "users",
    "companies",
    "currencies",
  ];
  for (const t of tables) {
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${t} RESTART IDENTITY CASCADE`);
  }
}

async function migrateCurrencies() {
  const { rows } = await odoo.query(
    `SELECT id, name, symbol, rounding FROM res_currency WHERE active = true`,
  );
  for (const r of rows) {
    const cur = await prisma.currency.upsert({
      where: { code: r.name },
      update: { symbol: r.symbol ?? r.name },
      create: { code: r.name, symbol: r.symbol ?? r.name, rate: 1 },
    });
    maps.currency.set(r.id, cur.id);
  }
  console.log(`✓ currencies: ${rows.length}`);
}

async function migrateCompanies() {
  const { rows } = await odoo.query(`SELECT id, name, currency_id FROM res_company`);
  for (const r of rows) {
    const curId = maps.currency.get(r.currency_id) ?? (await ensureDefaultCurrency());
    const c = await prisma.company.create({
      data: { name: r.name, currencyId: curId },
    });
    maps.company.set(r.id, c.id);
  }
  console.log(`✓ companies: ${rows.length}`);
}

async function ensureDefaultCurrency(): Promise<number> {
  const c = await prisma.currency.upsert({
    where: { code: "VND" },
    update: {},
    create: { code: "VND", symbol: "₫", rate: 1 },
  });
  return c.id;
}

async function migrateUsers() {
  // Resolve bb_pm group roles
  const { rows: groupRows } = await odoo.query(
    `SELECT res_groups.id, ir_model_data.name FROM res_groups
     JOIN ir_model_data ON ir_model_data.res_id=res_groups.id AND ir_model_data.model='res.groups'
     WHERE ir_model_data.name LIKE 'group_bb_pm_%'`,
  );
  const roleByGroup = new Map<number, "ADMIN" | "MANAGER" | "MEMBER" | "VIEWER">();
  for (const g of groupRows) {
    if (g.name.endsWith("_admin")) roleByGroup.set(g.id, "ADMIN");
    else if (g.name.endsWith("_manager")) roleByGroup.set(g.id, "MANAGER");
    else if (g.name.endsWith("_member")) roleByGroup.set(g.id, "MEMBER");
    else roleByGroup.set(g.id, "VIEWER");
  }

  const { rows } = await odoo.query(`
    SELECT u.id, u.login, u.company_id, u.active, rp.name, rp.email, rp.image_1920, rp.lang, rp.tz
    FROM res_users u
    JOIN res_partner rp ON rp.id = u.partner_id
    WHERE u.login NOT IN ('__system__')
  `);
  const tempHash = await bcrypt.hash(TEMP_PASSWORD, 10);

  for (const r of rows) {
    const { rows: grpRows } = await odoo.query(
      `SELECT gid FROM res_groups_users_rel WHERE uid=$1`,
      [r.id],
    );
    const roles = grpRows.map((g: any) => roleByGroup.get(g.gid)).filter(Boolean) as string[];
    const role = (roles.includes("ADMIN") ? "ADMIN"
      : roles.includes("MANAGER") ? "MANAGER"
      : roles.includes("MEMBER") ? "MEMBER"
      : "VIEWER") as "ADMIN" | "MANAGER" | "MEMBER" | "VIEWER";

    const companyId = maps.company.get(r.company_id)!;
    const email: string = r.email || r.login || `user${r.id}@migrated.local`;
    try {
      const u = await prisma.user.create({
        data: {
          email,
          passwordHash: tempHash,
          fullName: r.name ?? email,
          role,
          companyId,
          lang: (r.lang || "vi_VN").includes("vi") ? "vi_VN" : "en_US",
          timezone: r.tz || "Asia/Ho_Chi_Minh",
          active: r.active,
        },
      });
      maps.user.set(r.id, u.id);
    } catch (e: any) {
      if (e.code === "P2002") {
        // email đã tồn tại (conflict seed admin)
        const existing = await prisma.user.findUnique({ where: { email } });
        if (existing) maps.user.set(r.id, existing.id);
      } else throw e;
    }
  }
  console.log(`✓ users: ${rows.length} (temp password: ${TEMP_PASSWORD})`);
}

async function migrateCustomers() {
  // Only partners referenced as customer_id on any bb_project
  const { rows } = await odoo.query(`
    SELECT DISTINCT rp.id, rp.name, rp.email, rp.phone, rp.street, rp.vat
    FROM res_partner rp
    WHERE rp.id IN (SELECT customer_id FROM bb_project WHERE customer_id IS NOT NULL)
  `);
  for (const r of rows) {
    const c = await prisma.customer.create({
      data: {
        name: r.name ?? `Partner ${r.id}`,
        email: r.email,
        phone: r.phone,
        address: r.street,
        taxCode: r.vat,
      },
    });
    maps.customer.set(r.id, c.id);
  }
  console.log(`✓ customers: ${rows.length}`);
}

async function migrateTags() {
  const { rows } = await odoo.query(`SELECT id, name, color FROM bb_project_tag`);
  for (const r of rows) {
    const t = await prisma.tag.upsert({
      where: { name: r.name },
      update: { color: r.color },
      create: { name: r.name, color: r.color },
    });
    maps.tag.set(r.id, t.id);
  }
  console.log(`✓ tags: ${rows.length}`);
}

async function migrateProjects() {
  const { rows } = await odoo.query(`SELECT * FROM bb_project`);
  for (const r of rows) {
    const p = await prisma.project.create({
      data: {
        name: r.name,
        code: r.code || null,
        status: mapProjectStatus(r.status),
        priority: mapPriority(r.priority),
        startDate: r.start_date,
        endDate: r.end_date,
        description: r.description,
        budget: r.budget,
        estimatedTotalCost: r.estimated_total_cost,
        estimatedTotalHours: r.estimated_total_hours,
        ownerId: maps.user.get(r.owner_id)!,
        companyId: maps.company.get(r.company_id)!,
        customerId: r.customer_id ? maps.customer.get(r.customer_id) : null,
        accountManagerId: r.account_manager_id ? maps.user.get(r.account_manager_id) : null,
        currencyId: r.currency_id ? maps.currency.get(r.currency_id) : null,
      },
    });
    maps.project.set(r.id, p.id);
  }
  console.log(`✓ projects: ${rows.length}`);
}

async function migrateMilestones() {
  const { rows } = await odoo.query(`SELECT * FROM bb_project_milestone`);
  for (const r of rows) {
    const m = await prisma.milestone.create({
      data: {
        name: r.name,
        status: r.status,
        dueDate: r.due_date,
        description: r.description,
        projectId: maps.project.get(r.project_id)!,
      },
    });
    maps.milestone.set(r.id, m.id);
  }
  console.log(`✓ milestones: ${rows.length}`);
}

async function migrateScopes() {
  const { rows } = await odoo.query(`SELECT * FROM bb_project_scope`);
  for (const r of rows) {
    const s = await prisma.scope.create({
      data: {
        sequence: r.sequence ?? 10,
        name: r.name,
        notes: r.notes,
        estimatedHours: r.estimated_hours,
        estimatedRate: r.estimated_rate,
        estimatedCost: r.estimated_cost,
        projectId: maps.project.get(r.project_id)!,
        taskId: r.task_id ? maps.task.get(r.task_id) ?? null : null,
        assigneeId: r.assignee_id ? maps.user.get(r.assignee_id) : null,
        currencyId: r.currency_id ? maps.currency.get(r.currency_id) : null,
      },
    });
    maps.scope.set(r.id, s.id);
  }
  console.log(`✓ scopes: ${rows.length}`);
}

async function migrateMembers() {
  const { rows } = await odoo.query(`SELECT * FROM bb_project_member`);
  for (const r of rows) {
    const pid = maps.project.get(r.project_id);
    const uid = maps.user.get(r.user_id);
    if (!pid || !uid) continue;
    const m = await prisma.member.create({
      data: { projectId: pid, userId: uid, role: r.role, joinedAt: r.joined_at ?? new Date() },
    });
    maps.member.set(r.id, m.id);
  }
  console.log(`✓ members: ${rows.length}`);
}

async function migrateMemberRates() {
  const { rows } = await odoo.query(`SELECT * FROM bb_project_member_rate`);
  for (const r of rows) {
    const mid = maps.member.get(r.member_id);
    if (!mid) continue;
    await prisma.memberRate.create({
      data: {
        memberId: mid,
        projectId: r.project_id ? maps.project.get(r.project_id) : null,
        userId: r.user_id ? maps.user.get(r.user_id) : null,
        currencyId: r.currency_id ? maps.currency.get(r.currency_id) : null,
        effectiveFrom: r.effective_from,
        effectiveTo: r.effective_to,
        costPerHour: r.cost_per_hour,
      },
    });
  }
  console.log(`✓ member_rates: ${rows.length}`);
}

async function migrateTasks() {
  const { rows } = await odoo.query(`SELECT * FROM bb_project_task`);
  for (const r of rows) {
    const pid = maps.project.get(r.project_id);
    if (!pid) continue;
    const t = await prisma.task.create({
      data: {
        name: r.name,
        status: mapTaskStatus(r.status),
        priority: mapPriority(r.priority),
        deadline: r.deadline,
        endAt: r.end_at,
        description: r.description,
        result: r.result,
        issues: r.issues,
        projectId: pid,
        companyId: r.company_id ? maps.company.get(r.company_id) : null,
        assigneeId: r.assignee_id ? maps.user.get(r.assignee_id) : null,
        milestoneId: r.milestone_id ? maps.milestone.get(r.milestone_id) : null,
        currencyId: r.currency_id ? maps.currency.get(r.currency_id) : null,
      },
    });
    maps.task.set(r.id, t.id);
  }
  console.log(`✓ tasks: ${rows.length}`);
}

async function migrateBacklogs() {
  const { rows } = await odoo.query(`SELECT * FROM bb_project_backlog`);
  let ok = 0;
  for (const r of rows) {
    const tid = maps.task.get(r.task_id);
    const uid = maps.user.get(r.user_id);
    if (!tid || !uid) continue;
    await prisma.backlog.create({
      data: {
        status: mapBacklogStatus(r.status),
        workDate: r.work_date,
        description: r.description,
        hours: r.hours,
        costPerHourSnapshot: r.cost_per_hour_snapshot,
        totalCostSnapshot: r.total_cost_snapshot,
        taskId: tid,
        projectId: r.project_id ? maps.project.get(r.project_id) : null,
        companyId: r.company_id ? maps.company.get(r.company_id) : null,
        userId: uid,
        currencyId: r.currency_id ? maps.currency.get(r.currency_id) : null,
        approverId: r.approver_id ? maps.user.get(r.approver_id) : null,
      },
    });
    ok++;
  }
  console.log(`✓ backlogs: ${ok}/${rows.length}`);
}

async function migrateTagRels() {
  const ptRows = (await odoo.query(`SELECT * FROM bb_project_tag_rel`)).rows;
  for (const r of ptRows) {
    const pid = maps.project.get(r.project_id);
    const tid = maps.tag.get(r.tag_id);
    if (!pid || !tid) continue;
    await prisma.projectTag
      .create({ data: { projectId: pid, tagId: tid } })
      .catch(() => undefined);
  }
  const ttRows = (await odoo.query(`SELECT * FROM bb_project_task_tag_rel`)).rows;
  for (const r of ttRows) {
    const tid = maps.task.get(r.task_id);
    const tagId = maps.tag.get(r.tag_id);
    if (!tid || !tagId) continue;
    await prisma.taskTag.create({ data: { taskId: tid, tagId } }).catch(() => undefined);
  }
  console.log(`✓ tag rels: project=${ptRows.length}, task=${ttRows.length}`);
}

async function migrateGapoMap() {
  try {
    const { rows } = await odoo.query(`SELECT * FROM bb_gapo_user_map`);
    for (const r of rows) {
      const uid = maps.user.get(r.odoo_user_id);
      if (!uid) continue;
      await prisma.gapoUserMap.create({
        data: {
          userId: uid,
          gapoUserId: BigInt(r.gapo_user_id),
          gapoThreadId: BigInt(r.gapo_thread_id),
          gapoFullName: r.gapo_full_name,
          lastSeenAt: r.last_seen_at ?? new Date(),
        },
      });
    }
    console.log(`✓ gapo_user_maps: ${rows.length}`);
  } catch (e) {
    console.log("· skipped gapo_user_maps:", (e as Error).message);
  }
}

async function recomputeAll() {
  console.log("↻ Recomputing rollups…");
  // Simple raw SQL rollup (no service import to keep script self-contained)
  await prisma.$executeRawUnsafe(`
    UPDATE tasks t SET
      total_cost = COALESCE((SELECT SUM(total_cost_snapshot) FROM backlogs WHERE task_id = t.id AND status = 'APPROVED'), 0),
      total_hours = COALESCE((SELECT SUM(hours) FROM backlogs WHERE task_id = t.id AND status = 'APPROVED'), 0)
  `);
  await prisma.$executeRawUnsafe(`
    UPDATE projects p SET
      total_cost  = COALESCE((SELECT SUM(t.total_cost) FROM tasks t WHERE t.project_id = p.id), 0),
      total_hours = COALESCE((SELECT SUM(t.total_hours) FROM tasks t WHERE t.project_id = p.id), 0),
      task_count  = (SELECT COUNT(*) FROM tasks WHERE project_id = p.id),
      member_count = (SELECT COUNT(*) FROM members WHERE project_id = p.id),
      backlog_count = (SELECT COUNT(*) FROM backlogs WHERE project_id = p.id),
      scope_count = (SELECT COUNT(*) FROM scopes WHERE project_id = p.id),
      milestone_count = (SELECT COUNT(*) FROM milestones WHERE project_id = p.id),
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
  console.log("✓ rollups done");
}

function mapProjectStatus(s?: string | null) {
  switch ((s || "").toLowerCase()) {
    case "planned": return "PLANNED";
    case "in_progress": return "IN_PROGRESS";
    case "on_hold": return "ON_HOLD";
    case "completed": return "COMPLETED";
    case "cancelled": return "CANCELLED";
    default: return "PLANNED";
  }
}
function mapTaskStatus(s?: string | null) {
  switch ((s || "").toLowerCase()) {
    case "todo": return "TODO";
    case "in_progress": return "IN_PROGRESS";
    case "review": return "REVIEW";
    case "done": return "DONE";
    default: return "TODO";
  }
}
function mapBacklogStatus(s?: string | null) {
  switch ((s || "").toLowerCase()) {
    case "pending": return "PENDING";
    case "approved": return "APPROVED";
    case "rejected": return "REJECTED";
    default: return "PENDING";
  }
}
function mapPriority(p?: string | null) {
  switch ((p || "").toLowerCase()) {
    case "low": return "LOW";
    case "high": return "HIGH";
    case "urgent": return "URGENT";
    default: return "MEDIUM";
  }
}

async function main() {
  await odoo.connect();
  if (reset) await truncateAll();

  await migrateCurrencies();
  await migrateCompanies();
  await migrateUsers();
  await migrateCustomers();
  await migrateTags();
  await migrateProjects();
  await migrateMilestones();
  await migrateMembers();
  await migrateMemberRates();
  await migrateTasks();
  await migrateScopes();   // scope can link to task → after tasks
  await migrateBacklogs();
  await migrateTagRels();
  await migrateGapoMap();
  await recomputeAll();

  console.log("\n🎉 Migration completed.");
  console.log(`   All users share temp password: "${TEMP_PASSWORD}". Ask them to reset.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await odoo.end();
    await prisma.$disconnect();
  });
