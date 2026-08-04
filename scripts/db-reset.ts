/**
 * DEVELOPMENT-ONLY database reset.
 *
 * Drops all local data, re-applies migrations, and runs the development seed.
 * Guarded so it can never be run casually or against production:
 *   - refuses when NODE_ENV=production
 *   - refuses when the target database is clearly not local (unless --force)
 *   - loudly warns that ALL local data will be deleted
 *   - requires explicit typed confirmation (or an explicit --force / env flag)
 *
 * Usage:
 *   pnpm db:reset            # interactive; asks you to type "reset"
 *   pnpm db:reset --force    # non-interactive (CI/dev automation)
 *   DB_RESET_CONFIRM=reset pnpm db:reset
 */
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { config as loadEnv } from "dotenv";

loadEnv();

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function die(message: string): never {
  console.error(`${RED}✖ ${message}${RESET}`);
  process.exit(1);
}

const force = process.argv.includes("--force") || process.argv.includes("--yes");
const envConfirm = (process.env.DB_RESET_CONFIRM ?? "").toLowerCase() === "reset";

async function confirm(dbUrl: string): Promise<void> {
  if (force || envConfirm) {
    console.log("Confirmation provided via flag/env — proceeding.");
    return;
  }
  if (!stdin.isTTY) {
    die("No TTY for confirmation. Re-run with --force or set DB_RESET_CONFIRM=reset.");
  }
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(`Type ${BOLD}reset${RESET} to confirm: `);
  rl.close();
  if (answer.trim().toLowerCase() !== "reset") {
    die("Confirmation did not match. Aborted — nothing was changed.");
  }
  void dbUrl;
}

async function main(): Promise<void> {
  // 1. Never in production.
  if (process.env.NODE_ENV === "production") {
    die("Refusing to reset: NODE_ENV=production. This command is for local development only.");
  }

  // 2. Refuse an obviously non-local database unless explicitly forced.
  const dbUrl = process.env.DATABASE_URL ?? "";
  const isLocal = /@(localhost|127\.0\.0\.1|::1|db)(:|\/)/.test(dbUrl);
  if (!isLocal && !force) {
    die(
      "DATABASE_URL does not look local (localhost/127.0.0.1/db). " +
        "Refusing to reset a remote database. Re-run with --force only if you are certain.",
    );
  }

  // 3. Loud warning.
  console.log(`${YELLOW}${BOLD}`);
  console.log("╔════════════════════════════════════════════════════════════════╗");
  console.log("║  ⚠  DEVELOPMENT DATABASE RESET                                   ║");
  console.log("║                                                                ║");
  console.log("║  This will PERMANENTLY DELETE ALL DATA in your local database,  ║");
  console.log("║  re-apply all migrations, and load the development seed.       ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  console.log(RESET);
  console.log(`Target: ${dbUrl.replace(/:\/\/([^:]+):[^@]*@/, "://$1:****@") || "(DATABASE_URL not set)"}\n`);

  await confirm(dbUrl);

  // 4. Run the reset. `prisma migrate reset` drops the schema, re-applies every
  //    migration, and (because prisma.seed is configured) runs the dev seed.
  console.log("\nResetting database…\n");
  // Single command string with shell:true — avoids the args+shell deprecation
  // warning; all tokens are static constants (no interpolation, no user input).
  const result = spawnSync("pnpm exec prisma migrate reset --force --skip-generate", {
    stdio: "inherit",
    shell: true,
  });

  if (result.status !== 0) {
    die(`Reset failed (exit code ${result.status ?? "unknown"}).`);
  }
  console.log(`\n${BOLD}✔ Development database reset, migrated and seeded.${RESET}`);
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
