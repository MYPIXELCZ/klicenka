import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type CryptoKey, type KeyObject } from "jose";
import { MemoryJtiStore } from "../src/jti.js";
import type { KlicenkaConfig } from "../src/verify.js";

export const ISSUER = "https://tracker.test";

export async function setup() {
  const kp = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  const other = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  const pub = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "EdDSA" };
  const keys = createLocalJWKSet({ keys: [pub] });
  const config = (over: Partial<KlicenkaConfig> = {}): KlicenkaConfig => ({
    issuer: ISSUER, audience: "kozi-pelisek", environment: "production", jtiStore: new MemoryJtiStore(), keys, ...over,
  });
  return { privateKey: kp.privateKey, otherKey: other.privateKey, config };
}

export async function token(
  key: CryptoKey | KeyObject,
  over: { aud?: string; iss?: string; kid?: string; sub?: string; iat?: number; exp?: number; typ?: string; jti?: string; sh?: number; act?: unknown } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const iat = over.iat ?? now;
  return new SignJWT({ act: over.act ?? { sub: "u1", name: "Ann", email: "ann@test" }, sh: over.sh ?? 8 })
    .setProtectedHeader({ alg: "EdDSA", kid: over.kid ?? "k1", typ: over.typ ?? "klicenka+jwt" })
    .setIssuer(over.iss ?? ISSUER)
    .setAudience(over.aud ?? "kozi-pelisek@production")
    .setSubject(over.sub ?? "admin@kozi.test")
    .setIssuedAt(iat)
    .setExpirationTime(over.exp ?? iat + 60)
    .setJti(over.jti ?? crypto.randomUUID())
    .sign(key);
}
