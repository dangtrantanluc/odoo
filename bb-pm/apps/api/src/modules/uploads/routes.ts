import type { FastifyPluginAsync } from "fastify";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ALLOWED = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_BYTES = 2 * 1024 * 1024; // 2MB

const uploadsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.post("/avatar", async (req, reply) => {
    const file = await (req as any).file?.();
    if (!file) return reply.code(400).send({ error: { code: "NO_FILE" } });
    if (!ALLOWED.has(file.mimetype)) {
      return reply.code(400).send({ error: { code: "BAD_MIME", message: "Only PNG/JPEG/WEBP/GIF allowed" } });
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of file.file) {
      total += chunk.length;
      if (total > MAX_BYTES) {
        return reply.code(413).send({ error: { code: "FILE_TOO_LARGE", message: "Max 2MB" } });
      }
      chunks.push(chunk as Buffer);
    }
    const buffer = Buffer.concat(chunks);

    const ext = mimeToExt(file.mimetype);
    const fileName = `${randomUUID()}.${ext}`;
    const uploadDir = path.resolve(process.env.UPLOAD_DIR ?? "./uploads/avatars");
    await mkdir(uploadDir, { recursive: true });
    await writeFile(path.join(uploadDir, fileName), buffer);

    // Update current user avatarUrl
    const publicBase = process.env.UPLOADS_PUBLIC_BASE ?? `http://localhost:${process.env.API_PORT ?? 4000}/uploads/avatars`;
    const url = `${publicBase}/${fileName}`;
    await app.prisma.user.update({ where: { id: req.user.id }, data: { avatarUrl: url } });

    return { data: { avatarUrl: url } };
  });
};

function mimeToExt(mime: string) {
  return mime === "image/png" ? "png"
    : mime === "image/jpeg" ? "jpg"
    : mime === "image/webp" ? "webp"
    : "gif";
}

export default uploadsRoutes;
