import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { createLoginHandler, type LoginHandlerOptions } from "./handler.js";
import { createJtiStore } from "./jti.js";
import type { KlicenkaConfig } from "./verify.js";

/**
 * Supabase Auth sites. The account (sub) is the Supabase user's id or e-mail. The
 * service role makes a one-time sign-in link for exactly that user and redeems it
 * on the server, so the browser gets a normal Supabase session — no password, no
 * e-mail sent. Used token ids live in a table (SQL in docs/ZAPOJENI.md):
 *   create table public.klicenka_jti (jti text primary key, expires_at timestamptz not null);
 *
 * Supabase decides how long its own session lasts; the keyring's shorter limit is
 * kept in the `klicenka_until` cookie — check it with klicenkaSessionExpired() in
 * the middleware and sign out when it has passed.
 */
export type SupabaseKlicenkaOptions = Omit<KlicenkaConfig, "jtiStore"> & {
  supabaseUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  /** Where to land after signing in (default "/admin"). */
  redirectTo?: string;
  /** Optional: who may come in at all, e.g. only users with an admin role. */
  allow?(user: User): boolean | Promise<boolean>;
  jtiTable?: string;
  log?: LoginHandlerOptions<User>["log"];
};

export const UNTIL_COOKIE = "klicenka_until";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function findUser(admin: SupabaseClient, sub: string): Promise<User | null> {
  if (UUID.test(sub)) {
    const { data } = await admin.auth.admin.getUserById(sub);
    return data.user ?? null;
  }
  const email = sub.toLowerCase();
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email?.toLowerCase() === email);
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  return null;
}

export function supabaseKlicenka(opts: SupabaseKlicenkaOptions) {
  const admin = createClient(opts.supabaseUrl, opts.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const table = opts.jtiTable ?? "klicenka_jti";
  const jtiStore = createJtiStore({
    async insert(jti, expiresAt) {
      const { error } = await admin.from(table).insert({ jti, expires_at: expiresAt.toISOString() });
      if (error) throw error;
      return true;
    },
    cleanup: (now) => Promise.resolve(admin.from(table).delete().lt("expires_at", now.toISOString())),
  });

  return createLoginHandler<User>({
    ...opts,
    jtiStore,
    log: opts.log,
    async findAccount(sub) {
      const user = await findUser(admin, sub);
      if (!user?.email) return null;
      if (opts.allow && !(await opts.allow(user))) return null;
      return user;
    },
    async startSession({ user, maxAgeSeconds, request }) {
      const { data: link, error } = await admin.auth.admin.generateLink({ type: "magiclink", email: user.email! });
      if (error || !link.properties?.hashed_token) throw error ?? new Error("generateLink returned no token");

      const target = new URL(opts.redirectTo ?? "/admin", request.url);
      const res = new Response(null, { status: 303, headers: { Location: target.toString(), "Cache-Control": "no-store" } });
      const cookieHeader = request.headers.get("cookie") ?? "";
      const supabase = createServerClient(opts.supabaseUrl, opts.anonKey, {
        cookies: {
          getAll: () => cookieHeader.split(/;\s*/).filter(Boolean).map((c) => {
            const i = c.indexOf("=");
            return { name: c.slice(0, i), value: decodeURIComponent(c.slice(i + 1)) };
          }),
          setAll: (list) => {
            for (const { name, value, options } of list) res.headers.append("Set-Cookie", serialize(name, value, options));
          },
        },
      });
      const { error: otpError } = await supabase.auth.verifyOtp({ type: "email", token_hash: link.properties.hashed_token });
      if (otpError) throw otpError;
      const until = Date.now() + maxAgeSeconds * 1000;
      res.headers.append("Set-Cookie", serialize(UNTIL_COOKIE, String(until), { path: "/", maxAge: maxAgeSeconds, httpOnly: true, sameSite: "lax", secure: true }));
      return res;
    },
  });
}

/** In middleware: true when a keyring session has outlived its limit — sign the user out. */
export function klicenkaSessionExpired(cookieValue: string | undefined, now = Date.now()): boolean {
  if (!cookieValue) return false;
  const until = Number(cookieValue);
  return Number.isFinite(until) && until < now;
}

type CookieOpts = { path?: string; maxAge?: number; domain?: string; httpOnly?: boolean; secure?: boolean; sameSite?: boolean | "lax" | "strict" | "none"; expires?: Date };
function serialize(name: string, value: string, o: CookieOpts = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${o.path ?? "/"}`];
  if (o.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(o.maxAge)}`);
  if (o.expires) parts.push(`Expires=${o.expires.toUTCString()}`);
  if (o.domain) parts.push(`Domain=${o.domain}`);
  if (o.httpOnly) parts.push("HttpOnly");
  if (o.secure) parts.push("Secure");
  if (o.sameSite) parts.push(`SameSite=${o.sameSite === true ? "Strict" : o.sameSite[0].toUpperCase() + o.sameSite.slice(1)}`);
  return parts.join("; ");
}
