import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";

export default function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: { code: "VALIDATION_ERROR", message: "Invalid input", details: err.flatten() },
      });
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      const e: any = err;
      if (e.code === "P2002") {
        return reply.code(409).send({
          error: { code: "CONFLICT", message: "Unique constraint violated", details: err.meta },
        });
      }
      if (err.code === "P2025") {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Resource not found" } });
      }
    }
    req.log.error(err);
    const e: any = err;
    const status = e.statusCode ?? 500;
    reply.code(status).send({
      error: { code: e.code ?? "INTERNAL_ERROR", message: e.message ?? "Internal server error" },
    });
  });
}
