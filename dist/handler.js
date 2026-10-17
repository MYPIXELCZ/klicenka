import { verifyKlicenkaToken } from "./verify.js";
import { errorPage } from "./pages.js";
import { PROTOCOL, VERSION } from "./version.js";
function defaultLog(event) {
    console.info("[klicenka]", JSON.stringify(event));
}
/**
 * Opening the site from the installed tracker app has to be a plain link (only
 * those leave the app for Safari), and a token never goes in a URL. So the link
 * carries a one-time code instead (60 s) and the site collects the token for it
 * straight from the tracker, server to server.
 */
export async function redeemHandoff(code, config) {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(code))
        return null;
    try {
        const res = await fetch(`${config.issuer.replace(/\/$/, "")}/api/klicenka/handoff`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code, audience: `${config.audience}@${config.environment}` }),
            signal: AbortSignal.timeout(5000),
            cache: "no-store",
        });
        if (!res.ok)
            return null;
        const data = (await res.json());
        return typeof data.token === "string" ? data.token : null;
    }
    catch {
        return null;
    }
}
/**
 * The one-time code on a link. The parameter is "k" on /klicenka/otevrit: a link
 * shaped like OAuth (".../login?code=…") is kept inside the installed tracker app by
 * Safari's OAuth heuristic instead of going to the normal Safari window. "code" is
 * still read for links from 1.1.
 */
export function handoffCode(request) {
    if (request.method !== "GET")
        return null;
    const q = new URL(request.url).searchParams;
    return q.get("k") ?? q.get("code");
}
/** The token from a form POST, or for a one-time code on a GET link. */
export async function tokenFromRequest(request, config) {
    if (request.method === "GET") {
        const code = handoffCode(request);
        return code ? redeemHandoff(code, config) : null;
    }
    return readToken(request);
}
/** Reads the token from a form POST (field "token"); JSON bodies work too. */
export async function readToken(request) {
    const type = request.headers.get("content-type") ?? "";
    try {
        if (type.includes("application/json")) {
            const body = (await request.json());
            return typeof body.token === "string" ? body.token : null;
        }
        const form = await request.formData();
        const t = form.get("token");
        return typeof t === "string" ? t : null;
    }
    catch {
        return null;
    }
}
/**
 * The receiving endpoint as a standard Request → Response function: POST only,
 * verify, find exactly the named account, log who really clicked, start the
 * session. Adapters wrap it for Next.js App/Pages Router, Supabase, NextAuth.
 */
export function createLoginHandler(opts) {
    const log = opts.log ?? defaultLog;
    return async function handle(request) {
        const viaLink = handoffCode(request) !== null;
        if (request.method !== "POST" && !viaLink) {
            return errorPage("Sem se přichází tlačítkem „Přihlásit se“ v Klíčence.", opts.issuer, 405);
        }
        const token = await tokenFromRequest(request, opts);
        if (viaLink && !token) {
            await log({ result: "refused", code: "handoff" });
            return errorPage("Přihlašovací odkaz vypršel nebo už byl použit. Klikněte v Klíčence znovu.", opts.issuer);
        }
        const result = await verifyKlicenkaToken(token, opts);
        if (!result.ok) {
            await log({ result: "refused", code: result.code });
            return errorPage(result.message, opts.issuer);
        }
        const { claims } = result;
        let user;
        try {
            user = await opts.findAccount(claims.sub, claims);
        }
        catch (e) {
            console.error("[klicenka] findAccount failed", e);
            return errorPage("Web teď nemůže ověřit účet. Zkuste to za chvíli.", opts.issuer, 503);
        }
        if (!user) {
            await log({ result: "refused", code: "no-account", account: claims.sub, act: claims.act });
            return errorPage(`Účet „${claims.sub}“ na tomto webu neexistuje. Opravte ho v Klíčence.`, opts.issuer, 403);
        }
        await log({ result: "signed-in", account: claims.sub, act: claims.act, jti: claims.jti });
        return opts.startSession({ user, claims, maxAgeSeconds: Math.round(claims.sessionHours * 3600), request });
    };
}
/**
 * /klicenka/status — version, adapter, and the identifier + environment this
 * deployment answers to (public anyway: they're the token's audience). The tracker
 * reads them when a site is added, so nobody has to type them twice. Both default
 * to KLICENKA_AUDIENCE / KLICENKA_ENVIRONMENT.
 */
export function statusResponse(adapter, site = {}) {
    const env = typeof process !== "undefined" ? process.env : {};
    const audience = site.audience ?? env.KLICENKA_AUDIENCE;
    const environment = site.environment ?? env.KLICENKA_ENVIRONMENT;
    const body = {
        name: "klicenka", version: VERSION, protocol: PROTOCOL, adapter,
        ...(audience ? { audience } : {}),
        ...(environment ? { environment } : {}),
    };
    return new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
    });
}
/** A 303 redirect that sets a session cookie — the usual end of startSession. */
export function redirectWithCookie(location, cookie) {
    const parts = [
        `${cookie.name}=${encodeURIComponent(cookie.value)}`,
        `Path=${cookie.path ?? "/"}`,
        `Max-Age=${cookie.maxAgeSeconds}`,
        "HttpOnly",
        `SameSite=${cookie.sameSite ?? "Lax"}`,
    ];
    if (cookie.secure ?? true)
        parts.push("Secure");
    return new Response(null, { status: 303, headers: { Location: location, "Set-Cookie": parts.join("; "), "Cache-Control": "no-store" } });
}
