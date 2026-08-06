import { describe, expect, it } from "vitest";
import { signAccessToken, verifyAccessToken } from "./jwt.js";

const SECRET = "unit-test-secret-0123456789";

describe("mobile access token (HS256)", () => {
  it("round-trips valid claims", () => {
    const token = signAccessToken({ sub: "user_1", did: "dev_1" }, SECRET, 900);
    const claims = verifyAccessToken(token, SECRET);
    expect(claims?.sub).toBe("user_1");
    expect(claims?.did).toBe("dev_1");
    expect(claims?.typ).toBe("access");
  });

  it("rejects an expired token", () => {
    const past = Math.floor(Date.now() / 1000) - 10_000;
    const token = signAccessToken({ sub: "u", did: "d" }, SECRET, 60, past);
    expect(verifyAccessToken(token, SECRET)).toBeNull();
  });

  it("rejects a wrong secret", () => {
    const token = signAccessToken({ sub: "u", did: "d" }, SECRET, 900);
    expect(verifyAccessToken(token, "different-secret")).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const token = signAccessToken({ sub: "u", did: "d" }, SECRET, 900);
    const [h, , s] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "attacker", did: "d", typ: "access", iat: 0, exp: 9_999_999_999 })).toString("base64url");
    expect(verifyAccessToken(`${h}.${forged}.${s}`, SECRET)).toBeNull();
  });

  it("rejects malformed tokens", () => {
    expect(verifyAccessToken("not-a-jwt", SECRET)).toBeNull();
    expect(verifyAccessToken("a.b", SECRET)).toBeNull();
  });
});
