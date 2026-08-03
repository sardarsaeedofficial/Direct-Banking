import type { Frequency, RecurringPayment } from "@prisma/client";
import { prisma } from "../db.js";
import { addDays } from "@direct-banking/shared";

const MONTHS_FOR: Partial<Record<Frequency, number>> = {
  MONTHLY: 1,
  QUARTERLY: 3,
  BIANNUAL: 6,
  ANNUAL: 12,
};

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** The occurrence strictly after `from`, following the recurrence rule. */
export function nextOccurrence(
  from: Date,
  r: Pick<RecurringPayment, "frequency" | "dayOfMonth" | "intervalDays">,
): Date {
  const months = MONTHS_FOR[r.frequency];
  if (months) {
    const y = from.getUTCFullYear();
    const m = from.getUTCMonth() + months;
    const targetYear = y + Math.floor(m / 12);
    const targetMonth = ((m % 12) + 12) % 12;
    const day = Math.min(r.dayOfMonth ?? from.getUTCDate(), daysInMonth(targetYear, targetMonth));
    return new Date(Date.UTC(targetYear, targetMonth, day, 9, 0, 0));
  }
  const stepDays =
    r.frequency === "WEEKLY"
      ? 7
      : r.frequency === "FORTNIGHTLY"
        ? 14
        : r.frequency === "FOUR_WEEKLY"
          ? 28
          : r.frequency === "CUSTOM"
            ? (r.intervalDays ?? 30)
            : 30;
  return addDays(from, stepDays);
}

/**
 * Generate future ExpectedPayment rows for one recurring payment up to a
 * horizon. Idempotent: relies on the unique (recurringId, dueDate) constraint,
 * so re-running never overwrites history or duplicates rows. Also (re)schedules
 * the in-app reminder for each future due date.
 */
export async function generateExpectedFor(
  recurring: RecurringPayment,
  horizonDays = 120,
  now = new Date(),
): Promise<number> {
  if (recurring.status !== "ACTIVE") return 0;
  const horizonEnd = addDays(now, horizonDays);
  let created = 0;

  // Start from the first occurrence that is not before the recurrence start.
  let cursor = recurring.nextDueDate < recurring.startDate ? recurring.startDate : recurring.nextDueDate;

  // Guard against pathological loops.
  for (let i = 0; i < 500 && cursor <= horizonEnd; i++) {
    if (recurring.endDate && cursor > recurring.endDate) break;

    const expected = await prisma.expectedPayment.upsert({
      where: { recurringId_dueDate: { recurringId: recurring.id, dueDate: cursor } },
      create: {
        userId: recurring.userId,
        recurringId: recurring.id,
        accountId: recurring.accountId,
        dueDate: cursor,
        expectedAmountMinor: recurring.expectedAmountMinor,
        status: cursor < now ? "OVERDUE" : "PROJECTED",
      },
      update: {}, // never overwrite an existing expected payment
    });
    if (expected.createdAt.getTime() >= now.getTime() - 5_000) created++;

    // Schedule the in-app reminder (one per due payment).
    const fireAt = addDays(cursor, -recurring.reminderDays);
    await prisma.reminder.upsert({
      where: { expectedPaymentId_channel: { expectedPaymentId: expected.id, channel: "IN_APP" } },
      create: {
        userId: recurring.userId,
        recurringId: recurring.id,
        expectedPaymentId: expected.id,
        channel: "IN_APP",
        fireAt,
        message: `${recurring.merchantName} — ${recurring.reminderDays === 0 ? "due today" : `due in ${recurring.reminderDays} day(s)`}`,
      },
      update: {},
    });

    cursor = nextOccurrence(cursor, recurring);
  }

  // Roll the recurring's nextDueDate forward to the next non-past occurrence
  // without touching already-generated history.
  let next = recurring.nextDueDate;
  while (next < now && (!recurring.endDate || next <= recurring.endDate)) {
    next = nextOccurrence(next, recurring);
  }
  if (next.getTime() !== recurring.nextDueDate.getTime()) {
    await prisma.recurringPayment.update({ where: { id: recurring.id }, data: { nextDueDate: next } });
  }

  return created;
}

/** Generate for every active recurring payment belonging to a user. */
export async function generateAllForUser(userId: string, horizonDays = 120): Promise<number> {
  const recurrings = await prisma.recurringPayment.findMany({ where: { userId, status: "ACTIVE" } });
  let total = 0;
  for (const r of recurrings) total += await generateExpectedFor(r, horizonDays);
  return total;
}
