import type { PrismaClient, Prisma } from "@prisma/client";

type Tx = PrismaClient | Prisma.TransactionClient;

type NotifyInput = {
  userId: number;
  type: string;
  title: string;
  message?: string;
  link?: string;
};

export async function notify(tx: Tx, input: NotifyInput) {
  return tx.notification.create({ data: input });
}

export async function notifyMany(tx: Tx, inputs: NotifyInput[]) {
  if (inputs.length === 0) return;
  await tx.notification.createMany({ data: inputs });
}

export async function findCompanyAdmins(tx: Tx, companyId: number) {
  return tx.user.findMany({
    where: { companyId, role: "ADMIN", active: true },
    select: { id: true },
  });
}
