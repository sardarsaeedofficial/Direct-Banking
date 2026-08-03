/**
 * Copies the built Vite frontend (packages/web/dist) into the Express server's
 * public directory (packages/server/public), so the single production Node
 * process serves the SPA at "/" and the API under "/api".
 */
import { existsSync, rmSync, cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const from = resolve(root, "packages/web/dist");
const to = resolve(root, "packages/server/public");

if (!existsSync(from)) {
  console.error(`[copy-web] Frontend build not found at ${from}. Run the web build first.`);
  process.exit(1);
}

rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
console.log(`[copy-web] Copied frontend -> ${to}`);
