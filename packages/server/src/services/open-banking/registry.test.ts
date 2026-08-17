import { describe, expect, it } from "vitest";
import { computeReadiness } from "./registry.js";

// Pure-function unit tests for the Open Banking readiness decision (§5/§6 of
// the round-2 brief). Deliberately does not touch the process env or import
// app.js/db.js — computeReadiness() takes a plain config object, so every
// scenario here is fabricated and fast. No real secrets anywhere: every
// "present" value below is an obviously fake placeholder string.

describe("computeReadiness — Open Banking provider default fix", () => {
  it("Open Banking disabled -> DISABLED, regardless of provider/config", () => {
    const r = computeReadiness({ enabled: false });
    expect(r.enabled).toBe(false);
    expect(r.reason).toBe("DISABLED");
    expect(r.configured).toBe(false);
    expect(r.missing).toEqual([]);
  });

  it("enabled + provider missing -> NOT_CONFIGURED, never silently assumes a provider", () => {
    const r = computeReadiness({ enabled: true });
    expect(r.enabled).toBe(true);
    expect(r.reason).toBe("NOT_CONFIGURED");
    expect(r.configured).toBe(false);
    expect(r.provider).toBeNull();
    expect(r.missing).toEqual(["OPEN_BANKING_PROVIDER"]);
  });

  it("enabled + unrecognised provider value -> NOT_CONFIGURED, not a guess", () => {
    const r = computeReadiness({ enabled: true, provider: "not-a-real-provider" });
    expect(r.reason).toBe("NOT_CONFIGURED");
    expect(r.missing).toEqual(["OPEN_BANKING_PROVIDER"]);
  });

  it("provider=plaid + all secrets missing -> NOT_CONFIGURED listing every missing Plaid variable", () => {
    const r = computeReadiness({ enabled: true, provider: "plaid" });
    expect(r.reason).toBe("NOT_CONFIGURED");
    expect(r.missing).toEqual(["PLAID_CLIENT_ID", "PLAID_SECRET", "PLAID_WEBHOOK_URI", "OPEN_BANKING_DATA_KEY"]);
  });

  it("provider=plaid + partially configured -> NOT_CONFIGURED listing only what's actually missing", () => {
    const r = computeReadiness({
      enabled: true,
      provider: "plaid",
      plaidClientId: "fake-client-id",
      plaidSecret: "fake-secret",
    });
    expect(r.reason).toBe("NOT_CONFIGURED");
    expect(r.missing).toEqual(["PLAID_WEBHOOK_URI", "OPEN_BANKING_DATA_KEY"]);
  });

  it("provider=plaid + complete mock configuration -> READY", () => {
    const r = computeReadiness({
      enabled: true,
      provider: "plaid",
      plaidClientId: "fake-client-id",
      plaidSecret: "fake-secret",
      plaidWebhookUri: "https://example.test/webhook",
      openBankingDataKey: "0".repeat(64),
    });
    expect(r.reason).toBe("READY");
    expect(r.configured).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.provider).toBe("plaid");
  });

  it("provider=truelayer does not require any Plaid configuration", () => {
    const r = computeReadiness({
      enabled: true,
      provider: "truelayer",
      truelayerClientId: "fake-tl-client",
      truelayerClientSecret: "fake-tl-secret",
      truelayerReturnUri: "https://example.test/return",
      openBankingDataKey: "0".repeat(64),
    });
    expect(r.reason).toBe("READY");
    expect(r.missing).not.toContain("PLAID_CLIENT_ID");
    expect(r.missing).not.toContain("PLAID_SECRET");
    expect(r.missing).not.toContain("PLAID_WEBHOOK_URI");
  });

  it("provider=truelayer + missing config -> NOT_CONFIGURED listing only TrueLayer variables", () => {
    const r = computeReadiness({ enabled: true, provider: "truelayer" });
    expect(r.reason).toBe("NOT_CONFIGURED");
    expect(r.missing).toEqual(["TRUELAYER_CLIENT_ID", "TRUELAYER_CLIENT_SECRET", "TRUELAYER_RETURN_URI", "OPEN_BANKING_DATA_KEY"]);
  });

  it("never echoes back a credential value — only variable names appear anywhere in the result", () => {
    const r = computeReadiness({
      enabled: true,
      provider: "plaid",
      plaidClientId: "super-secret-client-id-value",
      plaidSecret: "super-secret-value",
    });
    const asText = JSON.stringify(r);
    expect(asText).not.toContain("super-secret-client-id-value");
    expect(asText).not.toContain("super-secret-value");
  });
});
