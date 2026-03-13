import { PrismaClient } from "@prisma/client";
import { env } from "./env";

// Singleton pattern: prevents multiple connections in dev hot-reload
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: env.isDev ? ["query", "error", "warn"] : ["error"],
  });

if (env.isDev) {
  globalForPrisma.prisma = prisma;
}

export async function connectDB(): Promise<void> {
  await prisma.$connect();
  console.log("✅ Connected to PostgreSQL");
}

export async function disconnectDB(): Promise<void> {
  await prisma.$disconnect();
  console.log("PostgreSQL disconnected");
}
