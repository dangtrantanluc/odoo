import { z } from "zod";

export const customerCreateSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().optional().or(z.literal("")).transform(v => v || undefined),
  phone: z.string().max(40).optional(),
  address: z.string().max(400).optional(),
  taxCode: z.string().max(40).optional(),
  notes: z.string().optional(),
});
export type CustomerCreateInput = z.infer<typeof customerCreateSchema>;

export const customerUpdateSchema = customerCreateSchema.partial();
