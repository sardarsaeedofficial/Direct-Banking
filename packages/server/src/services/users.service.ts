import { prisma } from "../db.js";
import { hashPassword } from "../auth/password.js";
import { HttpError } from "../middleware/error.js";

// Default categories seeded for every new account (shared by web + mobile register).
export const DEFAULT_CATEGORIES = [
  { name: "Housing", colour: "#6366f1" },
  { name: "Utilities", colour: "#0ea5e9" },
  { name: "Groceries", colour: "#22c55e" },
  { name: "Transport", colour: "#f59e0b" },
  { name: "Subscriptions", colour: "#a855f7" },
  { name: "Insurance", colour: "#14b8a6" },
  { name: "Eating out", colour: "#ef4444" },
  { name: "Income", colour: "#10b981" },
  { name: "Savings", colour: "#3b82f6" },
  { name: "Other", colour: "#64748b" },
];

/**
 * Creates a Direct Banking user with the default category set. Shared by the web
 * cookie-session register route and the native mobile register endpoint so both
 * use identical creation logic and validation. Throws 409 if the email exists.
 */
export async function registerUser(input: { email: string; password: string; displayName?: string }) {
  const email = input.email.toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new HttpError(409, "An account with that email already exists");

  return prisma.user.create({
    data: {
      email,
      passwordHash: await hashPassword(input.password),
      displayName: input.displayName,
      categories: { create: DEFAULT_CATEGORIES },
    },
  });
}
