import { createApp } from "./app.js";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { prisma } from "./db.js";
import { startScheduler, stopScheduler } from "./scheduler/index.js";

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(`Direct Banking listening`, { port: env.PORT, env: env.NODE_ENV });
  startScheduler();
});

async function shutdown(signal: string) {
  logger.info("Shutting down", { signal });
  stopScheduler();
  server.close();
  await prisma.$disconnect().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
