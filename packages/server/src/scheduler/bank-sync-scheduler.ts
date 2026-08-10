import { env } from "../env.js";
import { logger } from "../logger.js";
import { prisma } from "../db.js";
import { syncConnection } from "../services/open-banking/bank-feed.service.js";
import { getProvider } from "../services/open-banking/registry.js";

// Scheduled Open Banking sync (Phase 3). Enabled only when OPEN_BANKING_ENABLED
// and a BANK_SYNC_CRON is set and a provider is configured. State lives in the DB
// (per-connection lastSuccessfulSyncAt checkpoint), so it is safe across PM2/server
// restarts and never needs to re-download unbounded history.

const CONCURRENCY = 3; // bounded concurrency — do not hammer the provider
const CHECK_INTERVAL_MS = 30_000; // evaluate the cron twice a minute

let timer: NodeJS.Timeout | null = null;
let running = false;
let lastFiredMinute = "";

function parseField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart ? Number(stepPart) : 1;
    let lo = min;
    let hi = max;
    if (rangePart !== "*") {
      const [a, b] = rangePart.split("-");
      lo = Number(a);
      hi = b !== undefined ? Number(b) : lo;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !Number.isFinite(step) || step < 1) continue;
    for (let v = lo; v <= hi; v += step) if (v >= min && v <= max) out.add(v);
  }
  return out;
}

/** Standard 5-field cron matcher (minute hour day-of-month month day-of-week). */
export function cronMatches(expr: string, date: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [m, h, dom, mon, dow] = parts;
  const minutes = parseField(m, 0, 59);
  const hours = parseField(h, 0, 23);
  const months = parseField(mon, 1, 12);
  const doms = parseField(dom, 1, 31);
  const dows = parseField(dow, 0, 6);

  if (!minutes.has(date.getMinutes()) || !hours.has(date.getHours()) || !months.has(date.getMonth() + 1)) return false;

  const domRestricted = dom !== "*";
  const dowRestricted = dow !== "*";
  const domHit = doms.has(date.getDate());
  const dowHit = dows.has(date.getDay());
  if (domRestricted && dowRestricted) return domHit || dowHit; // standard cron OR semantics
  if (domRestricted) return domHit;
  if (dowRestricted) return dowHit;
  return true;
}

/** Sync all ACTIVE connections with bounded concurrency; failures never delete data. */
export async function runBankSyncPass(): Promise<{ synced: number; failed: number }> {
  if (running) return { synced: 0, failed: 0 }; // prevent overlapping runs
  running = true;
  let synced = 0;
  let failed = 0;
  try {
    const conns = await prisma.bankConnection.findMany({ where: { status: "ACTIVE" }, select: { id: true, userId: true } });
    for (let i = 0; i < conns.length; i += CONCURRENCY) {
      const batch = conns.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map((c) =>
          syncConnection(c.userId, c.id)
            .then(() => { synced++; })
            .catch((err) => {
              failed++;
              // syncConnection already stamped the error + preserved data.
              logger.warn("Scheduled bank sync failed", { connectionId: c.id, code: (err as Error).message });
            }),
        ),
      );
    }
  } finally {
    running = false;
  }
  return { synced, failed };
}

export function startBankSyncScheduler(): void {
  if (!env.OPEN_BANKING_ENABLED || !env.BANK_SYNC_CRON || !getProvider()) return;
  const cron = env.BANK_SYNC_CRON;
  logger.info("Bank sync scheduler started", { cron });
  timer = setInterval(() => {
    const now = new Date();
    const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
    if (minuteKey === lastFiredMinute) return; // fire at most once per matching minute
    if (cronMatches(cron, now)) {
      lastFiredMinute = minuteKey;
      void runBankSyncPass();
    }
  }, CHECK_INTERVAL_MS);
  timer.unref?.();
}

/** Clean shutdown: stop scheduling and wait for any in-flight pass to finish. */
export async function stopBankSyncScheduler(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  const deadline = Date.now() + 30_000;
  while (running && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
}
