import { z } from "zod";
import {
  ACCOUNT_TYPES,
  BUDGET_PERIODS,
  EXPECTED_STATUSES,
  FREQUENCIES,
  NOTIF_STATUSES,
  RECURRING_STATUSES,
  RECURRING_TYPES,
  REMINDER_CHANNELS,
  TXN_DIRECTIONS,
  TXN_SOURCES,
  TXN_STATUSES,
} from "./enums.js";

// Reusable primitives -------------------------------------------------------
export const cuid = z.string().min(1);
const minorAmount = z.number().int(); // pence; positive, sign implied by direction
const isoDate = z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}/));
const currency = z.string().length(3).default("GBP");
const colour = z.string().regex(/^#([0-9a-fA-F]{6})$/, "Must be a hex colour");

// Auth ----------------------------------------------------------------------
export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(10, "Use at least 10 characters").max(200),
  displayName: z.string().min(1).max(120).optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
  totp: z.string().regex(/^\d{6}$/).optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(10).max(200),
});

// Bank accounts -------------------------------------------------------------
export const bankAccountSchema = z.object({
  bankName: z.string().min(1).max(120),
  nickname: z.string().min(1).max(120),
  accountType: z.enum(ACCOUNT_TYPES).default("CURRENT"),
  lastFour: z.string().regex(/^\d{4}$/).optional().or(z.literal("")),
  currency,
  balanceMinor: minorAmount.default(0),
  colour: colour.default("#2563eb"),
  icon: z.string().max(60).optional(),
  isArchived: z.boolean().default(false),
});
export type BankAccountInput = z.infer<typeof bankAccountSchema>;

// Categories ----------------------------------------------------------------
export const categorySchema = z.object({
  name: z.string().min(1).max(80),
  colour: colour.default("#64748b"),
  icon: z.string().max(60).optional(),
  parentId: cuid.optional().nullable(),
});

// Transactions --------------------------------------------------------------
export const transactionSchema = z.object({
  accountId: cuid,
  direction: z.enum(TXN_DIRECTIONS),
  status: z.enum(TXN_STATUSES).default("COMPLETED"),
  source: z.enum(TXN_SOURCES).default("MANUAL"),
  amountMinor: minorAmount.positive("Amount must be greater than zero"),
  currency,
  bookedAt: isoDate,
  description: z.string().min(1).max(240),
  notes: z.string().max(2000).optional(),
  tags: z.array(z.string().max(40)).max(20).default([]),
  merchantName: z.string().max(160).optional(),
  categoryId: cuid.optional().nullable(),
  transferAccountId: cuid.optional().nullable(),
  refundOfId: cuid.optional().nullable(),
});
export type TransactionInput = z.infer<typeof transactionSchema>;

export const splitSchema = z.object({
  splits: z
    .array(
      z.object({
        amountMinor: minorAmount.positive(),
        description: z.string().min(1).max(240),
        categoryId: cuid.optional().nullable(),
      }),
    )
    .min(2, "A split needs at least two parts"),
});

export const transactionQuerySchema = z.object({
  accountId: cuid.optional(),
  categoryId: cuid.optional(),
  merchantId: cuid.optional(),
  direction: z.enum(TXN_DIRECTIONS).optional(),
  status: z.enum(TXN_STATUSES).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  search: z.string().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

// Recurring payments --------------------------------------------------------
export const recurringBase = z.object({
  type: z.enum(RECURRING_TYPES).default("DIRECT_DEBIT"),
  merchantName: z.string().min(1).max(160),
  accountId: cuid,
  expectedAmountMinor: minorAmount.positive(),
  isVariable: z.boolean().default(false),
  currency,
  frequency: z.enum(FREQUENCIES).default("MONTHLY"),
  dayOfMonth: z.number().int().min(1).max(31).optional().nullable(),
  intervalDays: z.number().int().min(1).max(3650).optional().nullable(),
  nextDueDate: isoDate,
  startDate: isoDate,
  endDate: isoDate.optional().nullable(),
  categoryId: cuid.optional().nullable(),
  reminderDays: z.number().int().min(0).max(60).default(5),
  status: z.enum(RECURRING_STATUSES).default("ACTIVE"),
  notes: z.string().max(2000).optional(),
});

export const recurringSchema = recurringBase.refine(
  (v) => v.frequency !== "CUSTOM" || (v.intervalDays ?? 0) > 0,
  { message: "Custom frequency requires intervalDays", path: ["intervalDays"] },
);
export type RecurringInput = z.infer<typeof recurringSchema>;

// Partial schema for updates (ZodEffects has no .partial(), so use the base).
export const recurringUpdateSchema = recurringBase.partial();

export const expectedStatusSchema = z.object({
  status: z.enum(EXPECTED_STATUSES),
});

// Budgets -------------------------------------------------------------------
export const budgetSchema = z.object({
  name: z.string().min(1).max(120),
  categoryId: cuid.optional().nullable(),
  period: z.enum(BUDGET_PERIODS).default("MONTHLY"),
  limitMinor: minorAmount.positive(),
  currency,
  startDate: isoDate,
});

// Reminders -----------------------------------------------------------------
export const reminderSchema = z.object({
  expectedPaymentId: cuid.optional().nullable(),
  recurringId: cuid.optional().nullable(),
  channel: z.enum(REMINDER_CHANNELS).default("IN_APP"),
  fireAt: isoDate,
  message: z.string().max(240).optional(),
});

// CSV import ----------------------------------------------------------------
export const csvMappingSchema = z.object({
  accountId: cuid,
  hasHeader: z.boolean().default(true),
  dateFormat: z.enum(["DMY", "MDY", "YMD"]).default("DMY"),
  columns: z.object({
    date: z.number().int().min(0),
    description: z.number().int().min(0),
    amount: z.number().int().min(0).optional(),
    debit: z.number().int().min(0).optional(),
    credit: z.number().int().min(0).optional(),
    balance: z.number().int().min(0).optional(),
  }),
});
export type CsvMappingInput = z.infer<typeof csvMappingSchema>;

// Notification import review ------------------------------------------------
export const notifDecisionSchema = z.object({
  status: z.enum(NOTIF_STATUSES),
  parsedMerchant: z.string().max(160).optional(),
  parsedAmountMinor: minorAmount.optional(),
  accountId: cuid.optional(),
  categoryId: cuid.optional().nullable(),
});

// Settings ------------------------------------------------------------------
export const settingSchema = z.object({
  key: z.string().min(1).max(80),
  value: z.unknown(),
});
