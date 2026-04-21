import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Role } from "@prisma/client";

export type AccessTokenPayload = {
  sub: number;
  email: string;
  role: Role;
  companyId: number;
  isSuperAdmin: boolean;
};

export function signAccessToken(app: FastifyInstance, payload: AccessTokenPayload) {
  return app.jwt.sign(payload, { expiresIn: process.env.JWT_ACCESS_TTL ?? "15m" });
}

export function newRefreshTokenString() {
  return crypto.randomBytes(48).toString("hex");
}

export function hashRefreshToken(raw: string) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export function refreshTtlMs() {
  const ttl = process.env.JWT_REFRESH_TTL ?? "7d";
  const match = /^(\d+)([smhd])$/.exec(ttl);
  if (!match) return 7 * 24 * 3600 * 1000;
  const n = Number(match[1]);
  const unit = match[2];
  const mult = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return n * mult;
}
