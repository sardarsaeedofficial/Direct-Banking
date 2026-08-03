import { isProd } from "./env.js";

// Keys whose values must never reach the logs.
const REDACT_KEYS = new Set([
  "password",
  "newpassword",
  "currentpassword",
  "passwordhash",
  "token",
  "tokenhash",
  "csrfsecret",
  "sessionsecret",
  "twofactorsecret",
  "totp",
  "authorization",
  "cookie",
  "smtp_pass",
]);

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.has(k.toLowerCase()) ? "[redacted]" : redact(v);
    }
    return out;
  }
  return value;
}

function emit(level: "info" | "warn" | "error", msg: string, meta?: unknown) {
  const line = {
    t: new Date().toISOString(),
    level,
    msg,
    ...(meta !== undefined ? { meta: redact(meta) } : {}),
  };
  const text = isProd ? JSON.stringify(line) : `[${level}] ${msg}` + (meta ? ` ${JSON.stringify(redact(meta))}` : "");
  if (level === "error") console.error(text);
  else if (level === "warn") console.warn(text);
  else console.log(text);
}

export const logger = {
  info: (msg: string, meta?: unknown) => emit("info", msg, meta),
  warn: (msg: string, meta?: unknown) => emit("warn", msg, meta),
  error: (msg: string, meta?: unknown) => emit("error", msg, meta),
};
