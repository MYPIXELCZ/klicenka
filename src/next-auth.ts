import { verifyKlicenkaToken, type KlicenkaClaims, type KlicenkaConfig } from "./verify.js";
import { errorPage, esc, htmlPage } from "./pages.js";
import { readToken } from "./handler.js";

/**
 * NextAuth v4 (App or Pages Router) and v5 (Auth.js). NextAuth creates sessions only
 * through its own sign-in, so the keyring adds a credentials provider "klicenka":
 * the receiving page passes the token on (POST, never the URL) to NextAuth's own
 * callback, and the provider verifies it there.
 *
 *   import Credentials from "next-auth/providers/credentials";
 *   providers: [klicenkaProvider(Credentials, { ...config, findUser }), …]
 *
 * The provider's user carries `klicenkaUntil`; copy it in the jwt callback with
 * klicenkaJwt() and refuse the session once klicenkaSessionValid() says so —
 * NextAuth's own maxAge is global and usually longer than the keyring's 8 h.
 */
export type NextAuthKlicenkaOptions<User> = KlicenkaConfig & {
  /** The account the token names (claims.sub) — exactly that one, or null. */
  findUser(sub: string, claims: KlicenkaClaims): Promise<User | null>;
  log?(event: { result: "signed-in" | "refused"; code?: string; account?: string; act?: KlicenkaClaims["act"] }): void | Promise<void>;
};

type CredentialsFactory = (options: {
  id: string;
  name: string;
  credentials: Record<string, { label?: string; type?: string }>;
  authorize: (credentials: Record<string, unknown> | undefined) => Promise<unknown>;
}) => unknown;

export function klicenkaProvider<User extends object>(Credentials: CredentialsFactory, opts: NextAuthKlicenkaOptions<User>) {
  const log = opts.log ?? ((e) => console.info("[klicenka]", JSON.stringify(e)));
  return Credentials({
    id: "klicenka",
    name: "Klíčenka",
    credentials: { token: { type: "text" } },
    async authorize(credentials) {
      const token = typeof credentials?.token === "string" ? credentials.token : null;
      const result = await verifyKlicenkaToken(token, opts);
      if (!result.ok) {
        await log({ result: "refused", code: result.code });
        return null;
      }
      const user = await opts.findUser(result.claims.sub, result.claims);
      if (!user) {
        await log({ result: "refused", code: "no-account", account: result.claims.sub, act: result.claims.act });
        return null;
      }
      await log({ result: "signed-in", account: result.claims.sub, act: result.claims.act });
      return { ...user, klicenkaUntil: Date.now() + result.claims.sessionHours * 3600 * 1000, klicenkaAct: result.claims.act };
    },
  });
}

/**
 * The receiving endpoint (/klicenka/login): an auto-submitting page that hands the
 * token to NextAuth's credentials callback with its CSRF token. `basePath` is
 * NextAuth's API path, `redirectTo` where to land.
 */
export function nextAuthReceiver(opts: { basePath?: string; redirectTo?: string; issuer?: string; nonce?: () => string | undefined }) {
  const base = (opts.basePath ?? "/api/auth").replace(/\/$/, "");
  return async function POST(request: Request): Promise<Response> {
    if (request.method !== "POST") return errorPage("Sem se přichází tlačítkem „Přihlásit se“ v Klíčence.", opts.issuer, 405);
    const token = await readToken(request);
    if (!token || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
      return errorPage("Chybí přihlašovací token.", opts.issuer);
    }
    const nonce = opts.nonce?.();
    const n = nonce ? ` nonce="${esc(nonce)}"` : "";
    const cb = esc(opts.redirectTo ?? "/admin");
    return htmlPage(
      "Přihlašuji…",
      `<p>Přihlašuji…</p>
<form id="k" method="post" action="${esc(base)}/callback/klicenka">
<input type="hidden" name="token" value="${esc(token)}"><input type="hidden" name="callbackUrl" value="${cb}">
<input type="hidden" name="csrfToken" id="c"></form>
<script${n}>fetch(${JSON.stringify(base + "/csrf")},{credentials:"same-origin"}).then(function(r){return r.json()}).then(function(d){document.getElementById("c").value=d.csrfToken;document.getElementById("k").submit()}).catch(function(){document.body.textContent="Přihlášení se nepodařilo. Zkuste to v Klíčence znovu."})</script>`,
    );
  };
}

/** jwt callback helper: keep the keyring's time limit on the token. */
export function klicenkaJwt<T extends Record<string, unknown>>(token: T, user?: unknown): T {
  const u = user as { klicenkaUntil?: number; klicenkaAct?: unknown } | undefined;
  if (u?.klicenkaUntil) return { ...token, klicenkaUntil: u.klicenkaUntil, klicenkaAct: u.klicenkaAct };
  return token;
}

/** False once a keyring session has outlived its limit (sessions from a password sign-in are unaffected). */
export function klicenkaSessionValid(token: Record<string, unknown> | null | undefined, now = Date.now()): boolean {
  const until = token?.klicenkaUntil;
  return typeof until !== "number" || until > now;
}
