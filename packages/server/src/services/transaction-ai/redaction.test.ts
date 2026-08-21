import { describe, expect, it } from "vitest";
import { redactForAi, assertNoForbiddenFields, NEVER_SEND_FIELDS } from "./redaction.js";

describe("redactForAi", () => {
  it("redacts a full card/account number but keeps a bare last-4", () => {
    const out = redactForAi("Card 4929 1234 5678 9012 charged, ending 9012");
    expect(out).not.toContain("4929");
    expect(out).toContain("[card-number-redacted]");
    expect(out).toContain("ending 9012"); // a bare last-4 is not a full number
  });

  it("redacts a UK sort code", () => {
    expect(redactForAi("Sort code 12-34-56")).toContain("[sort-code-redacted]");
  });

  it("redacts an email address", () => {
    expect(redactForAi("Contact user@example.com for help")).toContain("[email-redacted]");
  });

  it("redacts a UK mobile phone number", () => {
    expect(redactForAi("Call 07911 123456")).toContain("[phone-redacted]");
  });

  it("redacts a JWT-shaped token", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(redactForAi(`token=${jwt}`)).toContain("[token-redacted]");
  });

  it("truncates to the configured max length", () => {
    // Ordinary prose, not token-shaped text — a long run of identical
    // word characters legitimately matches the generic-token pattern below
    // and gets redacted down to a short placeholder before length even
    // becomes relevant, which is correct behaviour, not what this test
    // is checking.
    const out = redactForAi("This is a perfectly ordinary sentence about a purchase. ".repeat(20), 50);
    expect(out.length).toBe(50);
  });

  it("handles null/empty input safely", () => {
    expect(redactForAi(null)).toBe("");
    expect(redactForAi(undefined)).toBe("");
    expect(redactForAi("")).toBe("");
  });
});

describe("assertNoForbiddenFields", () => {
  it("passes for a clean payload", () => {
    expect(() => assertNoForbiddenFields({ title: "Tesco", amountMinor: 500 })).not.toThrow();
  });

  it.each([...NEVER_SEND_FIELDS])("throws when the payload carries the forbidden field %s", (field) => {
    expect(() => assertNoForbiddenFields({ [field]: "secret-value" })).toThrow();
  });

  it("is case-insensitive", () => {
    expect(() => assertNoForbiddenFields({ AccessToken: "xyz" })).toThrow();
  });
});
