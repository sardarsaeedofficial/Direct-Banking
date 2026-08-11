import { beforeAll, describe, expect, it } from "vitest";

// AES-GCM field encryption. The key is set before importing the module so env
// parsing picks it up.
let encryptField: (s: string) => string;
let decryptField: (s: string) => string;
let encryptionAvailable: () => boolean;

beforeAll(async () => {
  process.env.OPEN_BANKING_DATA_KEY = "0".repeat(64); // 32 zero bytes (hex) — test only
  const m = await import("./crypto.js");
  encryptField = m.encryptField;
  decryptField = m.decryptField;
  encryptionAvailable = m.encryptionAvailable;
});

describe("open-banking crypto", () => {
  it("reports availability when a valid key is configured", () => {
    expect(encryptionAvailable()).toBe(true);
  });

  it("round-trips a value and never stores plaintext", () => {
    const secret = "provider-refresh-token-abc123";
    const ct = encryptField(secret);
    expect(ct).not.toContain(secret);
    expect(ct.startsWith("v1.")).toBe(true);
    expect(decryptField(ct)).toBe(secret);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    expect(encryptField("x")).not.toBe(encryptField("x"));
  });

  it("rejects tampered ciphertext (authenticated encryption)", () => {
    const ct = encryptField("sensitive");
    const parts = ct.split(".");
    parts[3] = Buffer.from("tampered-bytes").toString("base64");
    expect(() => decryptField(parts.join("."))).toThrow();
  });
});
