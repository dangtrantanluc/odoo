import { z } from "zod";

export const tagCreateSchema = z.object({
  name: z.string().min(1).max(60),
  color: z.number().int().min(0).max(11).optional(),
});
export type TagCreateInput = z.infer<typeof tagCreateSchema>;

export const tagUpdateSchema = tagCreateSchema.partial();
