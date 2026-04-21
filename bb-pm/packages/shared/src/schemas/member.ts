import { z } from "zod";

export const memberCreateSchema = z.object({
  userId: z.number().int().positive(),
  role: z.string().max(40).optional(),
});
export type MemberCreateInput = z.infer<typeof memberCreateSchema>;

export const memberUpdateSchema = z.object({
  role: z.string().max(40).nullable().optional(),
});

export const memberRateCreateSchema = z.object({
  effectiveFrom: z.string().date(),
  effectiveTo: z.string().date().nullable().optional(),
  costPerHour: z.coerce.number().nonnegative(),
  currencyId: z.number().int().positive().optional(),
});
export type MemberRateCreateInput = z.infer<typeof memberRateCreateSchema>;
