import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const idParam = z.object({ id: z.coerce.number().int().positive() });
const listQuery = z.object({
  projectId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(50).optional().default(20),
});

const prioritySchema = z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]);

const actionItemInput = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(4000).optional(),
  ownerName: z.string().max(200).optional(),
  dueDate: z.string().datetime({ offset: true }).or(z.string().date()).optional(),
  priority: prioritySchema.optional().default("MEDIUM"),
});

const createMeetingBody = z.object({
  title: z.string().max(500).optional(),
  heldAt: z.string().datetime({ offset: true }).optional(),
  transcript: z.string().min(1).max(200_000),
  summary: z.string().max(4000).optional(),
  decisions: z.array(z.string().max(1000)).optional().default([]),
  participants: z.array(z.string().max(200)).optional().default([]),
  projectId: z.number().int().positive().optional(),
  items: z.array(actionItemInput).optional().default([]),
});

const approveBody = z.object({
  itemIds: z.array(z.number().int().positive()).min(1),
  // Optional: per-item project override if the meeting had no projectId
  // and the items should land in different projects.
  defaultProjectId: z.number().int().positive().optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveOwnerUserId(
  app: any,
  companyId: number,
  ownerName: string | null | undefined,
): Promise<number | null> {
  if (!ownerName) return null;
  const needle = ownerName.trim().toLowerCase();
  if (!needle) return null;
  // Case-insensitive match on fullName OR email local-part.
  const user = await app.prisma.user.findFirst({
    where: {
      companyId,
      active: true,
      OR: [
        { fullName: { contains: needle, mode: "insensitive" } },
        { email: { contains: needle, mode: "insensitive" } },
      ],
    },
    select: { id: true },
  });
  return user?.id ?? null;
}

const meetingsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  // ── CREATE ────────────────────────────────────────
  // Accepts a transcript plus extracted items (owner names may still be
  // strings; resolution to userId happens best-effort here, leaving
  // ownerUserId null if nothing matches — approval step can re-resolve).
  app.post("/", { schema: { body: createMeetingBody } }, async (req, reply) => {
    const b = req.body as z.infer<typeof createMeetingBody>;

    if (b.projectId) {
      const p = await app.prisma.project.findFirst({
        where: req.user.isSuperAdmin
          ? { id: b.projectId }
          : { id: b.projectId, companyId: req.user.companyId },
        select: { id: true },
      });
      if (!p) return reply.code(404).send({ error: { code: "PROJECT_NOT_FOUND" } });
    }

    const itemsWithOwners = await Promise.all(
      b.items.map(async (it) => ({
        ...it,
        ownerUserId: await resolveOwnerUserId(app, req.user.companyId, it.ownerName),
        dueDate: it.dueDate ? new Date(it.dueDate) : null,
      })),
    );

    const created = await app.prisma.meeting.create({
      data: {
        companyId: req.user.companyId,
        projectId: b.projectId ?? null,
        title: b.title ?? null,
        heldAt: b.heldAt ? new Date(b.heldAt) : new Date(),
        transcript: b.transcript,
        summary: b.summary ?? null,
        decisions: b.decisions,
        participants: b.participants,
        createdById: req.user.id,
        items: {
          create: itemsWithOwners.map((it) => ({
            title: it.title,
            description: it.description ?? null,
            ownerName: it.ownerName ?? null,
            ownerUserId: it.ownerUserId,
            dueDate: it.dueDate,
            priority: it.priority,
          })),
        },
      },
      include: { items: true },
    });
    return reply.code(201).send({ data: created });
  });

  // ── LIST ──────────────────────────────────────────
  app.get("/", { schema: { querystring: listQuery } }, async (req) => {
    const q = req.query as z.infer<typeof listQuery>;
    const where: any = req.user.isSuperAdmin ? {} : { companyId: req.user.companyId };
    if (q.projectId) where.projectId = q.projectId;

    const rows = await app.prisma.meeting.findMany({
      where,
      take: q.limit,
      orderBy: { createdAt: "desc" },
      include: {
        project: { select: { id: true, name: true, code: true } },
        _count: { select: { items: true } },
      },
    });
    return { data: rows, meta: { total: rows.length } };
  });

  // ── DETAIL ────────────────────────────────────────
  app.get("/:id", { schema: { params: idParam } }, async (req, reply) => {
    const { id } = req.params as any;
    const m = await app.prisma.meeting.findFirst({
      where: req.user.isSuperAdmin ? { id } : { id, companyId: req.user.companyId },
      include: {
        project: { select: { id: true, name: true, code: true } },
        items: { orderBy: { id: "asc" } },
      },
    });
    if (!m) return reply.code(404).send({ error: { code: "MEETING_NOT_FOUND" } });
    return { data: m };
  });

  // ── APPROVE items → create tasks ──────────────────
  // For each approved item: create a Task in the meeting's project (or the
  // defaultProjectId override), link back via createdTaskId, mark APPROVED.
  // Items without a resolvable project are reported in `skipped`.
  app.post("/:id/approve", {
    schema: { params: idParam, body: approveBody },
  }, async (req, reply) => {
    const { id } = req.params as any;
    const { itemIds, defaultProjectId } = req.body as z.infer<typeof approveBody>;

    const meeting = await app.prisma.meeting.findFirst({
      where: req.user.isSuperAdmin ? { id } : { id, companyId: req.user.companyId },
      include: { items: true },
    });
    if (!meeting) return reply.code(404).send({ error: { code: "MEETING_NOT_FOUND" } });

    const targetProjectId = meeting.projectId ?? defaultProjectId ?? null;
    if (!targetProjectId) {
      return reply.code(400).send({
        error: {
          code: "NO_PROJECT",
          message: "Meeting has no projectId; pass defaultProjectId in body.",
        },
      });
    }

    const project = await app.prisma.project.findFirst({
      where: req.user.isSuperAdmin
        ? { id: targetProjectId }
        : { id: targetProjectId, companyId: req.user.companyId },
      select: { id: true, companyId: true, currencyId: true },
    });
    if (!project) return reply.code(404).send({ error: { code: "PROJECT_NOT_FOUND" } });

    const pickable = meeting.items.filter(
      (it) => itemIds.includes(it.id) && it.status === "DRAFT",
    );

    const created: Array<{ itemId: number; taskId: number }> = [];
    const skipped: Array<{ itemId: number; reason: string }> = [];

    for (const it of pickable) {
      try {
        const task = await app.prisma.task.create({
          data: {
            projectId: project.id,
            companyId: project.companyId,
            currencyId: project.currencyId ?? undefined,
            name: it.title,
            description: it.description ?? undefined,
            priority: it.priority,
            assigneeId: it.ownerUserId ?? undefined,
            deadline: it.dueDate ?? undefined,
          },
        });
        await app.prisma.meetingActionItem.update({
          where: { id: it.id },
          data: { status: "APPROVED", createdTaskId: task.id },
        });
        created.push({ itemId: it.id, taskId: task.id });
      } catch (err: any) {
        skipped.push({ itemId: it.id, reason: err?.message || "create failed" });
      }
    }

    return {
      data: {
        meetingId: meeting.id,
        projectId: project.id,
        created,
        skipped,
      },
    };
  });

  // ── REJECT items ──────────────────────────────────
  app.post("/:id/reject", {
    schema: {
      params: idParam,
      body: z.object({ itemIds: z.array(z.number().int().positive()).min(1) }),
    },
  }, async (req, reply) => {
    const { id } = req.params as any;
    const { itemIds } = req.body as any;
    const meeting = await app.prisma.meeting.findFirst({
      where: req.user.isSuperAdmin ? { id } : { id, companyId: req.user.companyId },
      select: { id: true },
    });
    if (!meeting) return reply.code(404).send({ error: { code: "MEETING_NOT_FOUND" } });
    const result = await app.prisma.meetingActionItem.updateMany({
      where: { meetingId: meeting.id, id: { in: itemIds }, status: "DRAFT" },
      data: { status: "REJECTED" },
    });
    return { data: { rejected: result.count } };
  });
};

export default meetingsRoutes;
