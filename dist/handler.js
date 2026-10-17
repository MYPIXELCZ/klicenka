import { verifyKlicenkaToken } from "./verify.js";
import { errorPage } from "./pages.js";
import { PROTOCOL, VERSION } from "./version.js";
function defaultLog(event) {
    console.info("[klicenka]", JSON.stringify(event));
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
        if (request.method !== "POST") {
            return errorPage("Sem se přichází tlačítkem „Přihlásit se“ v Klíčence.", opts.issuer, 405);
        }
        const result = await verifyKlicenkaToken(await readToken(request), opts);
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
/** /klicenka/status — version and adapter, nothing sensitive. */
export function statusResponse(adapter) {
    return new Response(JSON.stringify({ name: "klicenka", version: VERSION, protocol: PROTOCOL, adapter }), {
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
