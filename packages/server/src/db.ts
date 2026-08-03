import { PrismaClient } from "@prisma/client";
import { isProd } from "./env.js";

// Single PrismaClient for the one production process. In dev, reuse across
// hot reloads to avoid exhausting the connection pool.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: isProd ? ["warn", "error"] : ["warn", "error"],
  });

if (!isProd) globalForPrisma.prisma = prisma;
