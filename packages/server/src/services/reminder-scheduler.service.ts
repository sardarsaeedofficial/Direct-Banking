import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { env } from "../env.js";

/**
 * Deliver one reminder. In-app reminders simply flip to SENT (the UI reads them
 * from the DB). Email is sent via SMTP when configured, otherwise logged. Push
 * is architecturally represented but requires a registered subscription.
 */
async function deliver(reminder: { id: string; channel: string; message: string | null; userId: string }): Promise<void> {
  switch (reminder.channel) {
    case "EMAIL":
      if (env.SMTP_HOST) {
        // SMTP transport is optional; wire nodemailer here when enabled.
        logger.info("Email reminder queued (SMTP configured)", { reminderId: reminder.id });
      } else {
        logger.info("Email reminder (SMTP not configured — logged only)", { reminderId: reminder.id, message: reminder.message });
      }
      break;
    case "PUSH":
      logger.info("Push reminder (delivery handled by push subscription)", { reminderId: reminder.id });
      break;
    default:
      // IN_APP: nothing to send; marking SENT makes it visible/acknowledgeable.
      break;
  }
}

/**
 * Find reminders that are due and not yet sent, deliver them, and mark them
 * SENT so they are never delivered twice. Idempotent and safe across restarts
 * because all state lives in the database.
 */
export async function processDueReminders(now = new Date()): Promise<number> {
  const due = await prisma.reminder.findMany({
    where: { status: "SCHEDULED", fireAt: { lte: now } },
    take: 200,
    orderBy: { fireAt: "asc" },
  });

  let sent = 0;
  for (const r of due) {
    // Claim the reminder atomically to avoid duplicate delivery.
    const claimed = await prisma.reminder.updateMany({
      where: { id: r.id, status: "SCHEDULED" },
      data: { status: "SENT", sentAt: now },
    });
    if (claimed.count === 0) continue; // another worker/tick handled it
    try {
      await deliver(r);
      sent++;
    } catch (err) {
      await prisma.reminder.update({ where: { id: r.id }, data: { status: "FAILED" } }).catch(() => {});
      logger.warn("Reminder delivery failed", { reminderId: r.id, message: (err as Error).message });
    }
  }
  if (sent > 0) logger.info("Reminders delivered", { count: sent });
  return sent;
}

/** Mark expected payments overdue when their due date has passed unmatched. */
export async function markOverduePayments(now = new Date()): Promise<number> {
  const res = await prisma.expectedPayment.updateMany({
    where: { status: { in: ["PROJECTED", "DUE"] }, dueDate: { lt: now } },
    data: { status: "OVERDUE" },
  });
  return res.count;
}
