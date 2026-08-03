/**
 * DEVELOPMENT seed — run explicitly with `pnpm db:seed`. Never invoked by the
 * production start path. Creates a demo user with realistic sample data,
 * including the Helifica direct-debit example from the specification.
 */
import { PrismaClient } from "@prisma/client";
import { randomBytes, scrypt as scryptCb } from "node:crypto";
import { promisify } from "node:util";

const prisma = new PrismaClient();
const scrypt = promisify(scryptCb);

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, 64, { N: 16_384 })) as Buffer;
  return `scrypt$16384$${salt.toString("hex")}$${derived.toString("hex")}`;
}

const DEMO_EMAIL = "demo@direct-banking.local";
const DEMO_PASSWORD = "demopassword1";

function monthsAgo(n: number, day: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, day, 9, 0, 0));
}

async function main() {
  // Clean slate for the demo user only.
  const existing = await prisma.user.findUnique({ where: { email: DEMO_EMAIL } });
  if (existing) await prisma.user.delete({ where: { id: existing.id } });

  const user = await prisma.user.create({
    data: {
      email: DEMO_EMAIL,
      passwordHash: await hashPassword(DEMO_PASSWORD),
      displayName: "Demo User",
      categories: {
        create: [
          { name: "Housing", colour: "#6366f1" },
          { name: "Utilities", colour: "#0ea5e9" },
          { name: "Groceries", colour: "#22c55e" },
          { name: "Transport", colour: "#f59e0b" },
          { name: "Subscriptions", colour: "#a855f7" },
          { name: "Insurance", colour: "#14b8a6" },
          { name: "Eating out", colour: "#ef4444" },
          { name: "Income", colour: "#10b981" },
        ],
      },
    },
    include: { categories: true },
  });
  const cat = (name: string) => user.categories.find((c) => c.name === name)?.id;

  const monzo = await prisma.bankAccount.create({
    data: { userId: user.id, bankName: "Monzo", nickname: "Monzo Current", accountType: "CURRENT", lastFour: "4021", balanceMinor: 152_340n, colour: "#ff3464" },
  });
  const barclays = await prisma.bankAccount.create({
    data: { userId: user.id, bankName: "Barclays", nickname: "Barclays Savings", accountType: "SAVINGS", lastFour: "8890", balanceMinor: 640_000n, colour: "#00aeef" },
  });

  // A merchant for Helifica.
  const helifica = await prisma.merchant.create({
    data: { userId: user.id, displayName: "Helifica", normalisedKey: "helifica", defaultCategoryId: cat("Subscriptions") },
  });

  // The Helifica direct debit: £85, Monzo, monthly, day 20, remind 5 days before.
  const recurring = await prisma.recurringPayment.create({
    data: {
      userId: user.id,
      type: "DIRECT_DEBIT",
      merchantId: helifica.id,
      merchantName: "Helifica",
      accountId: monzo.id,
      expectedAmountMinor: 8_500n,
      frequency: "MONTHLY",
      dayOfMonth: 20,
      nextDueDate: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 20, 9, 0, 0)),
      startDate: monthsAgo(4, 20),
      categoryId: cat("Subscriptions"),
      reminderDays: 5,
      status: "ACTIVE",
      notes: "Seed example from specification",
    },
  });

  // Historical paid Helifica payments (past 3 months) + matching transactions.
  for (let m = 3; m >= 1; m--) {
    const due = monthsAgo(m, 20);
    const expected = await prisma.expectedPayment.create({
      data: { userId: user.id, recurringId: recurring.id, accountId: monzo.id, dueDate: due, expectedAmountMinor: 8_500n, status: "PAID" },
    });
    await prisma.transaction.create({
      data: {
        userId: user.id,
        accountId: monzo.id,
        direction: "EXPENSE",
        amountMinor: 8_500n,
        bookedAt: due,
        description: "HELIFICA SUBSCRIPTION",
        merchantId: helifica.id,
        categoryId: cat("Subscriptions"),
        expectedPaymentId: expected.id,
        dedupeHash: `seed-helifica-${m}`,
      },
    });
  }
  // Upcoming projected payment for this month + its reminder.
  const upcomingDue = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 20, 9, 0, 0));
  const upcoming = await prisma.expectedPayment.create({
    data: { userId: user.id, recurringId: recurring.id, accountId: monzo.id, dueDate: upcomingDue, expectedAmountMinor: 8_500n, status: "PROJECTED" },
  });
  await prisma.reminder.create({
    data: { userId: user.id, recurringId: recurring.id, expectedPaymentId: upcoming.id, channel: "IN_APP", fireAt: new Date(upcomingDue.getTime() - 5 * 86_400_000), message: "Helifica — due in 5 day(s)" },
  });

  // A spread of everyday transactions across the last two months.
  const samples: Array<[number, number, number, string, string, "INCOME" | "EXPENSE"]> = [
    [0, 2, 245_000, "ACME PAYROLL", "Income", "INCOME"],
    [1, 2, 245_000, "ACME PAYROLL", "Income", "INCOME"],
    [0, 5, 4_299, "TESCO STORES 2984", "Groceries", "EXPENSE"],
    [0, 8, 1_199, "SPOTIFY", "Subscriptions", "EXPENSE"],
    [0, 11, 3_540, "TFL TRAVEL CHARGE", "Transport", "EXPENSE"],
    [0, 14, 6_780, "SAINSBURYS", "Groceries", "EXPENSE"],
    [1, 6, 1_199, "SPOTIFY", "Subscriptions", "EXPENSE"],
    [1, 9, 2_250, "PRET A MANGER", "Eating out", "EXPENSE"],
    [1, 15, 9_800, "BRITISH GAS", "Utilities", "EXPENSE"],
  ];
  for (const [m, day, amt, desc, category, direction] of samples) {
    await prisma.transaction.create({
      data: {
        userId: user.id,
        accountId: monzo.id,
        direction,
        amountMinor: BigInt(amt),
        bookedAt: monthsAgo(m, day),
        description: desc,
        categoryId: cat(category),
        dedupeHash: `seed-${desc}-${m}-${day}`,
      },
    });
  }

  // A monthly savings standing order to Barclays.
  await prisma.recurringPayment.create({
    data: {
      userId: user.id,
      type: "STANDING_ORDER",
      merchantName: "Monthly savings",
      accountId: monzo.id,
      expectedAmountMinor: 20_000n,
      frequency: "MONTHLY",
      dayOfMonth: 1,
      nextDueDate: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1, 9, 0, 0)),
      startDate: monthsAgo(4, 1),
      categoryId: cat("Income"),
      reminderDays: 1,
    },
  });

  console.log(`Seeded demo data.`);
  console.log(`  Login: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  console.log(`  Accounts: ${monzo.nickname}, ${barclays.nickname}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
