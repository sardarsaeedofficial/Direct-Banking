import { createHmac, timingSafeEqual } from "node:crypto";

// Minimal HS256 JWT (sign/verify) using Node crypto — no external dependency.
// Used only for short-lived mobile ACCESS tokens. Refresh tokens are opaque and
// stored hashed in the database (see mobile-session.ts).

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export interface AccessClaims {
  sub: string; // userId
  did: string; // MobileDevice.id
  typ: "access";
  iat: number;
  exp: number;
}

export function signAccessToken(
  payload: { sub: string; did: string },
  secret: string,
  ttlSeconds: number,
  now = Math.floor(Date.now() / 1000),
): string {
  const header = { alg: "HS256", typ: "JWT" };
  const claims: AccessClaims = { ...payload, typ: "access", iat: now, exp: now + ttlSeconds };
  const head = b64url(JSON.stringify(header));
  const body = b64url(JSON.stringify(claims));
  const data = `${head}.${body}`;
  const sig = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export function verifyAccessToken(
  token: string,
  secret: string,
  now = Math.floor(Date.now() / 1000),
): AccessClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts as [string, string, string];
  const expected = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let claims: AccessClaims;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as AccessClaims;
  } catch {
    return null;
  }
  if (claims.typ !== "access") return null;
  if (typeof claims.exp !== "number" || claims.exp < now) return null;
  if (!claims.sub || !claims.did) return null;
  return claims;
}
