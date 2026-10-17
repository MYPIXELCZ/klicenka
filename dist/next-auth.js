import { verifyKlicenkaToken } from "./verify.js";
import { errorPage, esc, htmlPage } from "./pages.js";
import { readToken, tokenFromRequest } from "./handler.js";
export function klicenkaProvider(Credentials, opts) {
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
export function nextAuthReceiver(opts) {
    const base = (opts.basePath ?? "/api/auth").replace(/\/$/, "");
    // Export it as both POST (form) and GET (link with a one-time code).
    return async function receive(request) {
        const viaLink = request.method === "GET" && new URL(request.url).searchParams.has("code");
        if (request.method !== "POST" && !viaLink)
            return errorPage("Sem se přichází tlačítkem „Přihlásit se“ v Klíčence.", opts.issuer, 405);
        const env = typeof process !== "undefined" ? process.env : {};
        const issuer = opts.issuer ?? env.KLICENKA_ISSUER ?? "";
        const token = viaLink
            ? await tokenFromRequest(request, { issuer, audience: opts.audience ?? env.KLICENKA_AUDIENCE ?? "", environment: opts.environment ?? env.KLICENKA_ENVIRONMENT ?? "" })
            : await readToken(request);
        if (!token || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
            return errorPage("Chybí přihlašovací token.", opts.issuer);
        }
        const nonce = opts.nonce?.();
        const n = nonce ? ` nonce="${esc(nonce)}"` : "";
        const cb = esc(opts.redirectTo ?? "/admin");
        return htmlPage("Přihlašuji…", `<p>Přihlašuji…</p>
<form id="k" method="post" action="${esc(base)}/callback/klicenka">
<input type="hidden" name="token" value="${esc(token)}"><input type="hidden" name="callbackUrl" value="${cb}">
<input type="hidden" name="csrfToken" id="c"></form>
<script${n}>fetch(${JSON.stringify(base + "/csrf")},{credentials:"same-origin"}).then(function(r){return r.json()}).then(function(d){document.getElementById("c").value=d.csrfToken;document.getElementById("k").submit()}).catch(function(){document.body.textContent="Přihlášení se nepodařilo. Zkuste to v Klíčence znovu."})</script>`);
    };
}
/** jwt callback helper: keep the keyring's time limit on the token. */
export function klicenkaJwt(token, user) {
    const u = user;
    if (u?.klicenkaUntil)
        return { ...token, klicenkaUntil: u.klicenkaUntil, klicenkaAct: u.klicenkaAct };
    return token;
}
/** False once a keyring session has outlived its limit (sessions from a password sign-in are unaffected). */
export function klicenkaSessionValid(token, now = Date.now()) {
    const until = token?.klicenkaUntil;
    return typeof until !== "number" || until > now;
}
