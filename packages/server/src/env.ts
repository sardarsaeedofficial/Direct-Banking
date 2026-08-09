import { config as loadEnv } from "dotenv";
import { z } from "zod";
import { resolve } from "node:path";

// Load .env from the repo root (two levels up from packages/server).
loadEnv({ path: resolve(process.cwd(), ".env") });
loadEnv({ path: resolve(import.meta.dirname, "../../../.env") });

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  SESSION_SECRET: z
    .string()
    .min(16, "SESSION_SECRET must be at least 16 characters")
    .default("dev-insecure-secret-change-me-please"),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(7),
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  SCHEDULER_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  // Mobile (native Android) auth. Access tokens are short-lived JWTs; refresh
  // tokens are opaque, rotated, and stored hashed. Use a dedicated secret.
  MOBILE_JWT_SECRET: z
    .string()
    .min(16, "MOBILE_JWT_SECRET must be at least 16 characters")
    .default("dev-insecure-mobile-secret-change-me"),
  MOBILE_ACCESS_TTL_MIN: z.coerce.number().int().positive().default(15),
  MOBILE_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  // ---- Open Banking (Phase 3). All optional so CI/tests need no real secrets. ----
  // When disabled the notification-only app keeps working normally.
  OPEN_BANKING_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  OPEN_BANKING_PROVIDER: z.string().default("truelayer"),
  TRUELAYER_ENV: z.enum(["sandbox", "live"]).default("sandbox"),
  TRUELAYER_CLIENT_ID: z.string().optional(),
  TRUELAYER_CLIENT_SECRET: z.string().optional(),
  TRUELAYER_RETURN_URI: z.string().optional(),
  // 32-byte key (hex or base64) for AES-256-GCM encryption of connection material.
  OPEN_BANKING_DATA_KEY: z.string().optional(),
  BANK_SYNC_CRON: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Never print secret values — only the offending keys.
  const keys = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
  console.error(`[env] Invalid environment configuration. Check: ${keys}`);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === "production";
