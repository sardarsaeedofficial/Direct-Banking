import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { normaliseMerchant } from "./merchant-normalise.service.js";

// Priority order for how a transaction's category is decided (highest first):
//   1. USER_EXPLICIT   — the user set it directly (handled at the call site).
//   2. USER_RULE       — a user-defined CategoryRule matched.
//   3. MERCHANT_LEARNED— the merchant has a learned default (taught by a past correction).
//   4. PROVIDER        — a trusted Open Banking provider category mapped cleanly.
//   5. HEURISTIC       — a conservative built-in merchant → category map.
//   6. UNCATEGORIZED   — nothing matched; falls to the "Other" category.
export type CategorizationSource =
  | "USER_EXPLICIT"
  | "USER_RULE"
  | "MERCHANT_LEARNED"
  | "PROVIDER"
  | "HEURISTIC"
  | "UNCATEGORIZED";

export interface CategorizationInput {
  merchantName?: string | null;
  description: string;
  recipientName?: string | null;
  senderName?: string | null;
  providerCategory?: string | null;
  direction: "INCOME" | "EXPENSE" | "TRANSFER";
  isDirectDebit?: boolean;
  transactionType?: string | null;
  merchantId?: string | null;
}

export interface CategorizationResult {
  categoryId: string | null;
  subcategoryId: string | null;
  subcategoryName: string | null;
  code: string | null;
  source: CategorizationSource;
}

interface CatRow {
  id: string;
  code: string | null;
  name: string;
  parentId: string | null;
}

// Built-in, deliberately CONSERVATIVE merchant → category-code map. Keys are matched
// as whole tokens against the normalised descriptor, so "tesco" matches "TESCO
// STORES 1234" but "best" never matches "bestway". No fuzzy/edit-distance matching.
const MERCHANT_KEYWORDS: { keywords: string[]; code: string }[] = [
  { code: "GROCERIES", keywords: ["tesco", "sainsburys", "sainsbury", "asda", "aldi", "lidl", "morrisons", "waitrose", "coop", "iceland", "ocado", "costcutter", "spar"] },
  { code: "FUEL", keywords: ["shell", "esso", "texaco", "gulf", "bp"] },
  { code: "SUBSCRIPTIONS", keywords: ["netflix", "spotify", "disney", "audible", "icloud", "youtube", "hbo", "hulu", "patreon", "notion"] },
  { code: "EATING_OUT", keywords: ["mcdonalds", "kfc", "greggs", "nandos", "dominos", "starbucks", "costa", "pret", "deliveroo", "ubereats", "justeat", "wagamama", "subway"] },
  { code: "TAXI", keywords: ["uber", "bolt", "lyft", "freenow", "gett"] },
  { code: "PUBLIC_TRANSPORT", keywords: ["tfl", "trainline", "lner", "gwr", "northern", "citymapper", "nationalrail"] },
  { code: "UTILITIES", keywords: ["britishgas", "edf", "eon", "octopus", "ovo", "scottishpower", "thameswater", "anglianwater"] },
  { code: "PHONE", keywords: ["vodafone", "giffgaff", "tesco mobile", "lycamobile"] },
  { code: "INTERNET", keywords: ["virginmedia", "talktalk", "plusnet", "hyperoptic"] },
  { code: "SHOPPING", keywords: ["amazon", "argos", "ebay", "asos", "zara", "primark", "ikea", "currys", "next"] },
  { code: "HEALTH", keywords: ["boots", "superdrug", "pharmacy", "puregym", "nuffield"] },
  { code: "ENTERTAINMENT", keywords: ["cineworld", "odeon", "vue", "steam", "playstation", "xbox", "nintendo"] },
  { code: "COUNCIL_TAX", keywords: ["counciltax", "council tax"] },
];

// Trusted provider category strings → canonical code. Only clean, unambiguous
// mappings — anything uncertain falls through to the heuristic.
const PROVIDER_CATEGORY_MAP: Record<string, string> = {
  groceries: "GROCERIES",
  supermarkets: "GROCERIES",
  "food and drink": "EATING_OUT",
  restaurants: "EATING_OUT",
  "eating out": "EATING_OUT",
  fuel: "FUEL",
  "gas stations": "FUEL",
  transport: "TRANSPORT",
  travel: "TRAVEL",
  shopping: "SHOPPING",
  entertainment: "ENTERTAINMENT",
  utilities: "UTILITIES",
  bills: "UTILITIES",
  insurance: "INSURANCE",
  health: "HEALTH",
  healthcare: "HEALTH",
  education: "EDUCATION",
  income: "INCOME",
  salary: "SALARY",
  savings: "SAVINGS",
  transfer: "TRANSFERS",
  transfers: "TRANSFERS",
  subscriptions: "SUBSCRIPTIONS",
  fees: "FEES",
  cash: "CASH",
};

async function loadCategoryIndex(userId: string, client: Prisma.TransactionClient | typeof prisma): Promise<Map<string, CatRow>> {
  const cats = await client.category.findMany({
    where: { userId },
    select: { id: true, code: true, name: true, parentId: true },
  });
  const byCode = new Map<string, CatRow>();
  for (const c of cats) if (c.code) byCode.set(c.code, c);
  return byCode;
}

/** Resolve a canonical code to categoryId + subcategory. A child code yields its
 *  parent as categoryId and itself as the subcategory. */
function resolveCode(code: string, index: Map<string, CatRow>): { categoryId: string | null; subcategoryId: string | null; subcategoryName: string | null } {
  const row = index.get(code);
  if (!row) return { categoryId: null, subcategoryId: null, subcategoryName: null };
  if (row.parentId) return { categoryId: row.parentId, subcategoryId: row.id, subcategoryName: row.name };
  return { categoryId: row.id, subcategoryId: null, subcategoryName: null };
}

function ruleFieldValue(field: string, input: CategorizationInput): string {
  switch (field) {
    case "MERCHANT": return input.merchantName ?? "";
    case "NORMALIZED_MERCHANT": return normaliseMerchant(input.merchantName ?? input.description);
    case "DESCRIPTION": return input.description ?? "";
    case "RECIPIENT": return input.recipientName ?? "";
    case "SENDER": return input.senderName ?? "";
    case "DD_COMPANY": return input.merchantName ?? input.description ?? "";
    default: return "";
  }
}

function ruleMatches(operator: string, haystack: string, value: string): boolean {
  const h = haystack.toLowerCase().trim();
  const v = value.toLowerCase().trim();
  if (!h || !v) return false;
  switch (operator) {
    case "EQUALS": return h === v;
    case "STARTS_WITH": return h.startsWith(v);
    case "CONTAINS":
    default: return h.includes(v);
  }
}

/** Whether a keyword appears as a token/substring in the normalised descriptor. We
 *  strip spaces from both sides so multi-word keys ("british gas") still match the
 *  4-token normalised key, but require the keyword to be a contiguous run. */
function keywordHit(normalised: string, keyword: string): boolean {
  const hay = normalised.replace(/\s+/g, "");
  const needle = keyword.replace(/\s+/g, "");
  return hay.includes(needle);
}

function heuristicCode(input: CategorizationInput): string | null {
  const normalised = normaliseMerchant(input.merchantName ?? input.description);
  for (const entry of MERCHANT_KEYWORDS) {
    if (entry.keywords.some((k) => keywordHit(normalised, k))) return entry.code;
  }
  // Coarse direction fallbacks (never override a real merchant match above).
  if (input.transactionType === "TRANSFER" || input.direction === "TRANSFER") return "TRANSFERS";
  if (input.direction === "INCOME") return "INCOME";
  return null;
}

/**
 * Decide the category for a transaction using the documented priority chain. Never
 * throws — an unresolved category returns the user's "Other" bucket (or null codes
 * if, exceptionally, the user has no Other category). Pass a preloaded `index` when
 * categorising many transactions to avoid a query per row.
 */
export async function categorizeTransaction(
  userId: string,
  input: CategorizationInput,
  client: Prisma.TransactionClient | typeof prisma = prisma,
  preloadedIndex?: Map<string, CatRow>,
): Promise<CategorizationResult> {
  const index = preloadedIndex ?? (await loadCategoryIndex(userId, client));

  // 2. User rules (explicit user-set categories are handled before this is called).
  const rules = await client.categoryRule.findMany({
    where: { userId, enabled: true },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  });
  for (const r of rules) {
    if (ruleMatches(r.operator, ruleFieldValue(r.field, input), r.value)) {
      const row = [...index.values()].find((c) => c.id === r.categoryId);
      const subRow = r.subcategoryId ? [...index.values()].find((c) => c.id === r.subcategoryId) : null;
      return { categoryId: r.categoryId, subcategoryId: r.subcategoryId ?? null, subcategoryName: subRow?.name ?? null, code: row?.code ?? null, source: "USER_RULE" };
    }
  }

  // 3. Learned merchant default (taught by a previous user correction).
  if (input.merchantId) {
    const merchant = await client.merchant.findUnique({
      where: { id: input.merchantId },
      select: { defaultCategoryId: true },
    });
    if (merchant?.defaultCategoryId) {
      const row = [...index.values()].find((c) => c.id === merchant.defaultCategoryId);
      return {
        categoryId: row?.parentId ?? merchant.defaultCategoryId,
        subcategoryId: row?.parentId ? row.id : null,
        subcategoryName: row?.parentId ? row.name : null,
        code: row?.code ?? null,
        source: "MERCHANT_LEARNED",
      };
    }
  }

  // 4. Trusted provider category.
  if (input.providerCategory) {
    const mapped = PROVIDER_CATEGORY_MAP[input.providerCategory.toLowerCase().trim()];
    if (mapped) {
      const r = resolveCode(mapped, index);
      if (r.categoryId) return { ...r, code: mapped, source: "PROVIDER" };
    }
  }

  // 5. Built-in heuristic.
  const code = heuristicCode(input);
  if (code) {
    const r = resolveCode(code, index);
    if (r.categoryId) return { ...r, code, source: "HEURISTIC" };
  }

  // 6. Uncategorized → "Other".
  const other = index.get("OTHER");
  return { categoryId: other?.id ?? null, subcategoryId: null, subcategoryName: null, code: other ? "OTHER" : null, source: "UNCATEGORIZED" };
}

/**
 * Record a user correction so future transactions from the same merchant inherit the
 * chosen category. Stores the learned default on the Merchant. Existing history is
 * never rewritten — only future categorisation is affected.
 */
export async function teachMerchantCategory(
  userId: string,
  merchantId: string,
  categoryId: string | null,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<void> {
  // Ownership guard: only touch a merchant the user owns.
  const merchant = await client.merchant.findFirst({ where: { id: merchantId, userId }, select: { id: true } });
  if (!merchant) return;
  await client.merchant.update({ where: { id: merchantId }, data: { defaultCategoryId: categoryId } });
}
