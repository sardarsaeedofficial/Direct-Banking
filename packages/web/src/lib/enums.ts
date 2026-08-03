export const FREQUENCY_LABELS: Record<string, string> = {
  WEEKLY: "Weekly",
  FORTNIGHTLY: "Fortnightly",
  FOUR_WEEKLY: "Every 4 weeks",
  MONTHLY: "Monthly",
  QUARTERLY: "Quarterly",
  BIANNUAL: "Every 6 months",
  ANNUAL: "Annual",
  CUSTOM: "Custom",
};

export const RECURRING_TYPE_LABELS: Record<string, string> = {
  DIRECT_DEBIT: "Direct debit",
  STANDING_ORDER: "Standing order",
  SUBSCRIPTION: "Subscription",
  CARD_RECURRING: "Recurring card",
  RENT: "Rent",
  LOAN: "Loan",
  INSURANCE: "Insurance",
  COUNCIL_TAX: "Council tax",
  MANUAL: "Manual",
};

export const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  CURRENT: "Current",
  SAVINGS: "Savings",
  CREDIT_CARD: "Credit card",
  LOAN: "Loan",
  CASH: "Cash",
  OTHER: "Other",
};

export const ACCOUNT_TYPES = Object.keys(ACCOUNT_TYPE_LABELS);
export const FREQUENCIES = Object.keys(FREQUENCY_LABELS);
export const RECURRING_TYPES = Object.keys(RECURRING_TYPE_LABELS);

export const STATUS_BADGE: Record<string, string> = {
  COMPLETED: "bg-emerald-100 text-emerald-700",
  PENDING: "bg-amber-100 text-amber-700",
  REFUNDED: "bg-sky-100 text-sky-700",
  CANCELLED: "bg-slate-200 text-slate-600",
  PROJECTED: "bg-slate-100 text-slate-600",
  DUE: "bg-amber-100 text-amber-700",
  PAID: "bg-emerald-100 text-emerald-700",
  OVERDUE: "bg-red-100 text-red-700",
  SKIPPED: "bg-slate-200 text-slate-600",
  ACTIVE: "bg-emerald-100 text-emerald-700",
  PAUSED: "bg-amber-100 text-amber-700",
  ENDED: "bg-slate-200 text-slate-600",
  PENDING_REVIEW: "bg-amber-100 text-amber-700",
};
