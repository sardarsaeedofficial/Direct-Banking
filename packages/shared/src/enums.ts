// String-literal enums mirrored from the Prisma schema so the web bundle never
// needs to import the Prisma client. Keep these in sync with prisma/schema.prisma.

export const ACCOUNT_TYPES = ["CURRENT", "SAVINGS", "CREDIT_CARD", "LOAN", "CASH", "OTHER"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const TXN_DIRECTIONS = ["INCOME", "EXPENSE", "TRANSFER"] as const;
export type TxnDirection = (typeof TXN_DIRECTIONS)[number];

export const TXN_STATUSES = ["PENDING", "COMPLETED", "REFUNDED", "CANCELLED"] as const;
export type TxnStatus = (typeof TXN_STATUSES)[number];

export const TXN_SOURCES = ["MANUAL", "CSV_IMPORT", "NOTIFICATION", "OPEN_BANKING", "STATEMENT_IMPORT"] as const;
export type TxnSource = (typeof TXN_SOURCES)[number];

// Canonical ledger classification (Phase 1).
export const TXN_TYPES = [
  "INCOME",
  "PURCHASE",
  "INTERNAL_TRANSFER",
  "DIRECT_DEBIT",
  "STANDING_ORDER",
  "CASH_WITHDRAWAL",
  "BANK_FEE",
  "REFUND",
  "TRANSFER",
  "OTHER",
] as const;
export type TxnType = (typeof TXN_TYPES)[number];

// Strength of an internal-transfer match. Only CONFIRMED/HIGH auto-classify.
export const TRANSFER_CONFIDENCES = ["CONFIRMED", "HIGH", "POSSIBLE", "NOT_INTERNAL"] as const;
export type TransferConfidence = (typeof TRANSFER_CONFIDENCES)[number];

// Phase 2 — Direct Debit engine.
export const DD_STATUSES = ["ACTIVE", "PAUSED", "CANCELLED", "UNKNOWN"] as const;
export type DdStatus = (typeof DD_STATUSES)[number];

export const DD_FREQUENCIES = ["WEEKLY", "FORTNIGHTLY", "MONTHLY", "QUARTERLY", "YEARLY", "VARIABLE"] as const;
export type DdFrequency = (typeof DD_FREQUENCIES)[number];

export const DD_EXPECTATION_MODES = ["FIXED", "RANGE", "LEARNED"] as const;
export type DdExpectationMode = (typeof DD_EXPECTATION_MODES)[number];

export const DD_ANOMALIES = ["NORMAL", "ABOVE_EXPECTED", "BELOW_EXPECTED", "UNEXPECTED_DATE", "FIRST_PAYMENT", "UNKNOWN"] as const;
export type DdAnomaly = (typeof DD_ANOMALIES)[number];

export const RECURRING_KINDS = ["DIRECT_DEBIT", "STANDING_ORDER", "SUBSCRIPTION", "RECURRING_CARD"] as const;
export type RecurringKind = (typeof RECURRING_KINDS)[number];

export const RECURRING_TYPES = [
  "DIRECT_DEBIT",
  "STANDING_ORDER",
  "SUBSCRIPTION",
  "CARD_RECURRING",
  "RENT",
  "LOAN",
  "INSURANCE",
  "COUNCIL_TAX",
  "MANUAL",
] as const;
export type RecurringType = (typeof RECURRING_TYPES)[number];

export const FREQUENCIES = [
  "WEEKLY",
  "FORTNIGHTLY",
  "FOUR_WEEKLY",
  "MONTHLY",
  "QUARTERLY",
  "BIANNUAL",
  "ANNUAL",
  "CUSTOM",
] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export const RECURRING_STATUSES = ["ACTIVE", "PAUSED", "ENDED"] as const;
export type RecurringStatus = (typeof RECURRING_STATUSES)[number];

export const EXPECTED_STATUSES = ["PROJECTED", "DUE", "MATCHED", "PAID", "SKIPPED", "OVERDUE"] as const;
export type ExpectedStatus = (typeof EXPECTED_STATUSES)[number];

export const REMINDER_CHANNELS = ["IN_APP", "EMAIL", "PUSH"] as const;
export type ReminderChannel = (typeof REMINDER_CHANNELS)[number];

export const REMINDER_STATUSES = ["SCHEDULED", "SENT", "DISMISSED", "FAILED"] as const;
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];

export const IMPORT_STATUSES = ["PENDING", "PREVIEW", "COMMITTED", "ROLLED_BACK", "FAILED"] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export const NOTIF_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;
export type NotifStatus = (typeof NOTIF_STATUSES)[number];

export const BUDGET_PERIODS = ["MONTHLY", "YEARLY"] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

// Human-friendly labels for the UI.
export const FREQUENCY_LABELS: Record<Frequency, string> = {
  WEEKLY: "Weekly",
  FORTNIGHTLY: "Fortnightly",
  FOUR_WEEKLY: "Every 4 weeks",
  MONTHLY: "Monthly",
  QUARTERLY: "Quarterly",
  BIANNUAL: "Every 6 months",
  ANNUAL: "Annual",
  CUSTOM: "Custom",
};

export const RECURRING_TYPE_LABELS: Record<RecurringType, string> = {
  DIRECT_DEBIT: "Direct debit",
  STANDING_ORDER: "Standing order",
  SUBSCRIPTION: "Subscription",
  CARD_RECURRING: "Recurring card payment",
  RENT: "Rent",
  LOAN: "Loan",
  INSURANCE: "Insurance",
  COUNCIL_TAX: "Council tax",
  MANUAL: "Manual recurring payment",
};

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  CURRENT: "Current",
  SAVINGS: "Savings",
  CREDIT_CARD: "Credit card",
  LOAN: "Loan",
  CASH: "Cash",
  OTHER: "Other",
};
