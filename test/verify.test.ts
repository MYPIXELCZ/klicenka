import { beforeAll, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { verifyKlicenkaToken } from "../src/verify.js";
import { setup, token } from "./helpers.js";

let s: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { s = await setup(); });

describe("verifyKlicenkaToken", () => {
  it("accepts a fresh token for this site and environment", async () => {
    const r = await verifyKlicenkaToken(await token(s.privateKey, { sh: 4 }), s.config());
    expect(r).toMatchObject({ ok: true, claims: { sub: "admin@kozi.test", act: { sub: "u1", name: "Ann", email: "ann@test" }, sessionHours: 4 } });
  });
  it("refuses an expired token", async () => {
    const iat = Math.floor(Date.now() / 1000) - 200;
    expect(await verifyKlicenkaToken(await token(s.privateKey, { iat }), s.config())).toMatchObject({ ok: false, code: "expired" });
  });
  it("refuses a used token (jti once)", async () => {
    const cfg = s.config();
    const t = await token(s.privateKey);
    expect((await verifyKlicenkaToken(t, cfg)).ok).toBe(true);
    expect(await verifyKlicenkaToken(t, cfg)).toMatchObject({ ok: false, code: "used" });
  });
  it("refuses a token for another site", async () => {
    expect(await verifyKlicenkaToken(await token(s.privateKey, { aud: "barvypp@production" }), s.config())).toMatchObject({ ok: false, code: "audience" });
  });
  it("refuses a token for another environment", async () => {
    const t = await token(s.privateKey, { aud: "kozi-pelisek@production" });
    expect(await verifyKlicenkaToken(t, s.config({ environment: "preview" }))).toMatchObject({ ok: false, code: "audience" });
  });
  it("refuses a bad signature", async () => {
    expect(await verifyKlicenkaToken(await token(s.otherKey), s.config())).toMatchObject({ ok: false, code: "signature" });
    const t = await token(s.privateKey);
    const [h, p] = t.split(".");
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), sub: "root" })).toString("base64url")}.${t.split(".")[2]}`;
    expect(await verifyKlicenkaToken(forged, s.config())).toMatchObject({ ok: false, code: "signature" });
  });
  it("refuses an unknown kid", async () => {
    expect(await verifyKlicenkaToken(await token(s.privateKey, { kid: "rotated-away" }), s.config())).toMatchObject({ ok: false, code: "unknown-key" });
  });
  it("refuses another issuer", async () => {
    expect(await verifyKlicenkaToken(await token(s.privateKey, { iss: "https://evil.test" }), s.config())).toMatchObject({ ok: false, code: "issuer" });
  });
  it("refuses a token that lives longer than 60 s", async () => {
    const iat = Math.floor(Date.now() / 1000);
    expect(await verifyKlicenkaToken(await token(s.privateKey, { iat, exp: iat + 3600 }), s.config())).toMatchObject({ ok: false, code: "claims" });
  });
  it("refuses a missing or garbage token and the wrong type", async () => {
    expect(await verifyKlicenkaToken(null, s.config())).toMatchObject({ ok: false, code: "missing" });
    expect(await verifyKlicenkaToken("nope", s.config())).toMatchObject({ ok: false, code: "malformed" });
    expect((await verifyKlicenkaToken(await token(s.privateKey, { typ: "JWT" }), s.config())).ok).toBe(false);
  });
  it("refuses an HS256 token even with a matching kid (algorithm pinned)", async () => {
    const t = await new SignJWT({ act: { sub: "u", email: "e" } }).setProtectedHeader({ alg: "HS256", kid: "k1", typ: "klicenka+jwt" })
      .setIssuer("https://tracker.test").setAudience("kozi-pelisek@production").setSubject("x").setIssuedAt().setExpirationTime("60s").setJti("j")
      .sign(new TextEncoder().encode("secret"));
    expect((await verifyKlicenkaToken(t, s.config())).ok).toBe(false);
  });
  it("refuses a token without act", async () => {
    expect((await verifyKlicenkaToken(await token(s.privateKey, { act: "nobody" }), s.config())).ok).toBe(false);
  });
});
