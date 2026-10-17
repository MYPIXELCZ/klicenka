import { beforeAll, describe, expect, it, vi } from "vitest";
import { createLoginHandler, redirectWithCookie, statusResponse } from "../src/handler.js";
import { toPagesHandler } from "../src/next.js";
import { klicenkaJwt, klicenkaProvider, klicenkaSessionValid, nextAuthReceiver } from "../src/next-auth.js";
import { clearUntilCookie, klicenkaSessionExpired, untilCookie } from "../src/supabase.js";
import { setup, token } from "./helpers.js";
import { EventEmitter } from "node:events";

let s: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { s = await setup(); });

const post = (t: string) => new Request("https://kozi.test/klicenka/login", {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: t }),
});

describe("login handler", () => {
  it("signs in exactly the named account, logs the real person, uses the session length", async () => {
    const log = vi.fn();
    const startSession = vi.fn(async ({ user, maxAgeSeconds }) => redirectWithCookie("/admin", { name: "s", value: String(user.id), maxAgeSeconds }));
    const handle = createLoginHandler({ ...s.config(), findAccount: async (sub) => (sub === "admin@kozi.test" ? { id: 7 } : null), startSession, log });
    const res = await handle(post(await token(s.privateKey, { sh: 2 })));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin");
    expect(res.headers.get("set-cookie")).toContain("Max-Age=7200");
    expect(startSession.mock.calls[0][0].maxAgeSeconds).toBe(7200);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ result: "signed-in", account: "admin@kozi.test", act: { sub: "u1", name: "Ann", email: "ann@test" } }));
  });
  it("never falls back to another account when the named one is missing", async () => {
    const startSession = vi.fn();
    const handle = createLoginHandler({ ...s.config(), findAccount: async () => null, startSession, log: () => {} });
    const res = await handle(post(await token(s.privateKey, { sub: "ghost@kozi.test" })));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("ghost@kozi.test");
    expect(startSession).not.toHaveBeenCalled();
  });
  it("refuses GET and a bad token with a Czech page", async () => {
    const handle = createLoginHandler({ ...s.config(), findAccount: async () => ({}), startSession: vi.fn(), log: () => {} });
    expect((await handle(new Request("https://kozi.test/klicenka/login"))).status).toBe(405);
    const res = await handle(post(await token(s.otherKey)));
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("Podpis");
  });
  it("status reports the identifier and environment it answers to", async () => {
    expect(await statusResponse("cookie", { audience: "kozi-pelisek", environment: "production" }).json())
      .toMatchObject({ adapter: "cookie", audience: "kozi-pelisek", environment: "production" });
  });
  it("status reports version and adapter only", async () => {
    expect(await statusResponse("cookie").json()).toEqual({ name: "klicenka", version: "1.0.3", protocol: 1, adapter: "cookie" });
  });
});

describe("Pages Router wrapper", () => {
  it("turns a parsed form body into a Request and writes the Response back", async () => {
    const seen: string[] = [];
    const handler = toPagesHandler(async (req) => {
      seen.push((await req.formData()).get("token") as string);
      return redirectWithCookie("/admin", { name: "s", value: "1", maxAgeSeconds: 60 });
    });
    const req = Object.assign(new EventEmitter(), { method: "POST", url: "/api/klicenka/login", headers: { host: "kozi.test" }, body: { token: "abc" } });
    const out: { status?: number; headers: Record<string, unknown>; body?: Buffer } = { headers: {} };
    const res = { set statusCode(v: number) { out.status = v; }, setHeader: (k: string, v: unknown) => { out.headers[k.toLowerCase()] = v; }, end: (b: Buffer) => { out.body = b; } };
    await handler(req as never, res as never);
    expect(seen).toEqual(["abc"]);
    expect(out.status).toBe(303);
    expect(out.headers["location"]).toBe("/admin");
    expect(String(out.headers["set-cookie"])).toContain("s=1");
  });
});

describe("NextAuth adapter", () => {
  const Credentials = (o: { authorize: (c: Record<string, unknown>) => Promise<unknown> }) => o;
  it("authorize returns the named user with the keyring time limit", async () => {
    const p = klicenkaProvider(Credentials as never, { ...s.config(), findUser: async (sub) => ({ id: "1", email: sub }), log: () => {} }) as { authorize: (c: unknown) => Promise<Record<string, unknown> | null> };
    const user = await p.authorize({ token: await token(s.privateKey, { sh: 1 }) });
    expect(user).toMatchObject({ id: "1", email: "admin@kozi.test" });
    expect((user!.klicenkaUntil as number) - Date.now()).toBeGreaterThan(3500 * 1000);
    expect(await p.authorize({ token: await token(s.otherKey) })).toBeNull();
  });
  it("session limit helpers", () => {
    const t = klicenkaJwt({ sub: "1" }, { klicenkaUntil: 1000 });
    expect(klicenkaSessionValid(t, 999)).toBe(true);
    expect(klicenkaSessionValid(t, 1001)).toBe(false);
    expect(klicenkaSessionValid({ sub: "password-login" }, 1e15)).toBe(true);
    expect(klicenkaSessionExpired("1000", 1001)).toBe(true);
    expect(klicenkaSessionExpired(undefined)).toBe(false);
  });
  it("Supabase limit cookie outlives the limit, so the middleware can see it pass", () => {
    const c = untilCookie(2 * 3600, 1_000_000);
    expect(c).toContain("klicenka_until=8200000");
    const maxAge = Number(/Max-Age=(\d+)/.exec(c)![1]);
    expect(maxAge).toBeGreaterThan(2 * 3600);
    expect(klicenkaSessionExpired("8200000", 8200001)).toBe(true);
    expect(clearUntilCookie()).toContain("Max-Age=0");
  });
  it("receiver passes the token on in a form, never a URL", async () => {
    const res = await nextAuthReceiver({ redirectTo: "/admin" })(post("aaa.bbb.ccc"));
    const html = await res.text();
    expect(html).toContain('action="/api/auth/callback/klicenka"');
    expect(html).toContain('name="token" value="aaa.bbb.ccc"');
    expect(html).not.toContain("?token=");
    expect((await nextAuthReceiver({})(post("<script>"))).status).toBe(401);
  });
});
