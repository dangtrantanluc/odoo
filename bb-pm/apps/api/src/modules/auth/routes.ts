import type { FastifyPluginAsync } from "fastify";
import bcrypt from "bcrypt";
import { loginSchema, registerSchema, refreshSchema } from "@bb-pm/shared";
import { signAccessToken, newRefreshTokenString, hashRefreshToken, refreshTtlMs } from "../../lib/tokens.js";

const authRoutes: FastifyPluginAsync = async (app) => {
  app.post("/register", { schema: { body: registerSchema } }, async (req, reply) => {
    const { email, password, fullName, companyId, companyName } = req.body as any;

    const existing = await app.prisma.user.findUnique({ where: { email } });
    if (existing) return reply.code(409).send({ error: { code: "EMAIL_TAKEN", message: "Email already registered" } });

    let company = null;
    if (companyId) {
      company = await app.prisma.company.findUnique({ where: { id: companyId } });
      if (!company) return reply.code(404).send({ error: { code: "COMPANY_NOT_FOUND" } });
    } else if (companyName) {
      const vnd = await app.prisma.currency.upsert({
        where: { code: "VND" },
        update: {},
        create: { code: "VND", symbol: "₫", rate: 1 },
      });
      company = await app.prisma.company.create({ data: { name: companyName, currencyId: vnd.id } });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await app.prisma.user.create({
      data: {
        email,
        passwordHash,
        fullName,
        role: "MEMBER",
        companyId: company!.id,
      },
    });

    const tokens = await issueTokens(app, user);
    return reply.code(201).send({ data: { user: toUserDTO(user), ...tokens } });
  });

  app.post("/login", { schema: { body: loginSchema } }, async (req, reply) => {
    const { email, password } = req.body as any;
    const user = await app.prisma.user.findUnique({ where: { email } });
    if (!user || !user.active) {
      return reply.code(401).send({ error: { code: "INVALID_CREDENTIALS" } });
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return reply.code(401).send({ error: { code: "INVALID_CREDENTIALS" } });

    await app.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    const tokens = await issueTokens(app, user);
    return { data: { user: toUserDTO(user), ...tokens } };
  });

  app.post("/refresh", { schema: { body: refreshSchema } }, async (req, reply) => {
    const { refreshToken } = req.body as any;
    const hash = hashRefreshToken(refreshToken);
    const record = await app.prisma.refreshToken.findUnique({
      where: { tokenHash: hash },
      include: { user: true },
    });
    if (!record || record.revokedAt || record.expiresAt < new Date()) {
      return reply.code(401).send({ error: { code: "INVALID_REFRESH" } });
    }
    await app.prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
    const tokens = await issueTokens(app, record.user);
    return { data: tokens };
  });

  app.post("/logout", { preHandler: [app.authenticate] }, async (req, reply) => {
    await app.prisma.refreshToken.updateMany({
      where: { userId: req.user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return reply.code(204).send();
  });
};

async function issueTokens(app: any, user: any) {
  const accessToken = signAccessToken(app, {
    sub: user.id,
    email: user.email,
    role: user.role,
    companyId: user.companyId,
    isSuperAdmin: user.isSuperAdmin,
  });
  const raw = newRefreshTokenString();
  const expiresAt = new Date(Date.now() + refreshTtlMs());
  await app.prisma.refreshToken.create({
    data: { userId: user.id, tokenHash: hashRefreshToken(raw), expiresAt },
  });
  return { accessToken, refreshToken: raw };
}

function toUserDTO(u: any) {
  return {
    id: u.id,
    email: u.email,
    fullName: u.fullName,
    role: u.role,
    companyId: u.companyId,
    isSuperAdmin: u.isSuperAdmin,
    avatarUrl: u.avatarUrl,
    lang: u.lang,
    timezone: u.timezone,
  };
}

export default authRoutes;
