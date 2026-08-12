import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { hashPassword } from "../auth/password.js";
import { HttpError } from "../middleware/error.js";

export interface SeedCategory {
  code: string;
  name: string;
  colour: string;
  icon?: string;
  children?: { code: string; name: string }[];
}

// Canonical default category taxonomy seeded for every new account (shared by web
// + mobile register). Each category carries a stable `code` so categorisation and
// insights logic never depends on the display name (which the user may rename).
// A handful of categories expose subcategories to demonstrate the tree; the code is
// the contract, the name is presentational.
export const DEFAULT_CATEGORY_TREE: SeedCategory[] = [
  {
    code: "INCOME", name: "Income", colour: "#10b981", icon: "payments",
    children: [
      { code: "SALARY", name: "Salary" },
      { code: "BENEFITS", name: "Benefits" },
      { code: "REFUNDS", name: "Refunds" },
      { code: "OTHER_INCOME", name: "Other income" },
    ],
  },
  { code: "TRANSFERS", name: "Transfers", colour: "#3b82f6", icon: "swap_horiz" },
  { code: "GROCERIES", name: "Groceries", colour: "#22c55e", icon: "shopping_cart" },
  { code: "EATING_OUT", name: "Eating out", colour: "#ef4444", icon: "restaurant" },
  { code: "FUEL", name: "Fuel", colour: "#f97316", icon: "local_gas_station" },
  {
    code: "TRANSPORT", name: "Transport", colour: "#f59e0b", icon: "directions_bus",
    children: [
      { code: "PUBLIC_TRANSPORT", name: "Public transport" },
      { code: "TAXI", name: "Taxi & rideshare" },
      { code: "PARKING", name: "Parking & tolls" },
    ],
  },
  { code: "SHOPPING", name: "Shopping", colour: "#ec4899", icon: "shopping_bag" },
  { code: "ENTERTAINMENT", name: "Entertainment", colour: "#8b5cf6", icon: "movie" },
  { code: "TRAVEL", name: "Travel", colour: "#06b6d4", icon: "flight" },
  { code: "HEALTH", name: "Health", colour: "#14b8a6", icon: "health_and_safety" },
  { code: "EDUCATION", name: "Education", colour: "#0ea5e9", icon: "school" },
  { code: "FAMILY", name: "Family", colour: "#f472b6", icon: "family_restroom" },
  { code: "HOUSING", name: "Rent & Mortgage", colour: "#6366f1", icon: "home" },
  { code: "UTILITIES", name: "Utilities", colour: "#0ea5e9", icon: "bolt" },
  { code: "COUNCIL_TAX", name: "Council Tax", colour: "#64748b", icon: "account_balance" },
  { code: "INSURANCE", name: "Insurance", colour: "#14b8a6", icon: "shield" },
  { code: "PHONE", name: "Phone", colour: "#a855f7", icon: "smartphone" },
  { code: "INTERNET", name: "Internet", colour: "#6366f1", icon: "wifi" },
  { code: "SUBSCRIPTIONS", name: "Subscriptions", colour: "#a855f7", icon: "subscriptions" },
  { code: "DIRECT_DEBITS", name: "Direct Debits", colour: "#7c3aed", icon: "event_repeat" },
  { code: "FEES", name: "Fees & Charges", colour: "#dc2626", icon: "receipt_long" },
  { code: "CASH", name: "Cash Withdrawal", colour: "#78716c", icon: "atm" },
  { code: "SAVINGS", name: "Savings", colour: "#3b82f6", icon: "savings" },
  { code: "INVESTMENTS", name: "Investments", colour: "#2563eb", icon: "trending_up" },
  { code: "OTHER", name: "Other", colour: "#64748b", icon: "category" },
];

/** Total number of default categories (top-level + subcategories) seeded per user. */
export const DEFAULT_CATEGORY_COUNT =
  DEFAULT_CATEGORY_TREE.length +
  DEFAULT_CATEGORY_TREE.reduce((n, c) => n + (c.children?.length ?? 0), 0);

/**
 * Seed the canonical default categories for a user. Top-level categories are created
 * first (so their ids are known), then subcategories are inserted with an explicit
 * userId + parentId. Runs inside the caller's transaction client when supplied.
 */
export async function seedDefaultCategories(
  userId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<void> {
  await client.category.createMany({
    data: DEFAULT_CATEGORY_TREE.map((c) => ({
      userId,
      code: c.code,
      name: c.name,
      colour: c.colour,
      icon: c.icon,
      isSystem: true,
    })),
  });
  const parents = await client.category.findMany({
    where: { userId, code: { in: DEFAULT_CATEGORY_TREE.map((c) => c.code) } },
    select: { id: true, code: true },
  });
  const idByCode = new Map(parents.map((p) => [p.code, p.id]));
  const children = DEFAULT_CATEGORY_TREE.flatMap((c) =>
    (c.children ?? []).map((ch) => ({
      userId,
      parentId: idByCode.get(c.code)!,
      code: ch.code,
      name: ch.name,
      colour: c.colour,
      icon: c.icon,
      isSystem: true,
    })),
  );
  if (children.length) await client.category.createMany({ data: children });
}

/**
 * Creates a Direct Banking user with the canonical default category set. Shared by
 * the web cookie-session register route and the native mobile register endpoint so
 * both use identical creation logic and validation. Throws 409 if the email exists.
 */
export async function registerUser(input: { email: string; password: string; displayName?: string }) {
  const email = input.email.toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new HttpError(409, "An account with that email already exists");

  const passwordHash = await hashPassword(input.password);
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { email, passwordHash, displayName: input.displayName },
    });
    await seedDefaultCategories(user.id, tx);
    return user;
  });
}
