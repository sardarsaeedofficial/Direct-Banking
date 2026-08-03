import { env } from "../env.js";
import { logger } from "../logger.js";
import { processDueReminders, markOverduePayments } from "../services/reminder-scheduler.service.js";

let timer: NodeJS.Timeout | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) return; // avoid overlapping runs
  running = true;
  try {
    await markOverduePayments();
    await processDueReminders();
  } catch (err) {
    logger.error("Scheduler tick failed", { message: (err as Error).message });
  } finally {
    running = false;
  }
}

/** Start the DB-driven reminder checker. Survives restarts (state is in the DB). */
export function startScheduler(): void {
  const intervalMs = env.SCHEDULER_INTERVAL_SECONDS * 1000;
  logger.info("Reminder scheduler started", { intervalSeconds: env.SCHEDULER_INTERVAL_SECONDS });
  void tick(); // run once at boot to catch anything missed while down
  timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
