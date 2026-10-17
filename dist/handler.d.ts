import { type KlicenkaClaims, type KlicenkaConfig } from "./verify.js";
export type LoginEvent = {
    result: "signed-in";
    account: string;
    act: KlicenkaClaims["act"];
    jti: string;
} | {
    result: "refused";
    code: string;
    account?: string;
    act?: KlicenkaClaims["act"];
};
export type LoginHandlerOptions<User> = KlicenkaConfig & {
    /**
     * The account the token names (claims.sub) — exactly that one. Return null when it
     * doesn't exist; the sign-in is then refused (never "the first admin").
     */
    findAccount(sub: string, claims: KlicenkaClaims): Promise<User | null>;
    /** Start this site's own session for the user and answer (usually a redirect + cookie). */
    startSession(input: {
        user: User;
        claims: KlicenkaClaims;
        maxAgeSeconds: number;
        request: Request;
    }): Promise<Response>;
    /** Write the real person (claims.act) to the site's log. Defaults to console. */
    log?(event: LoginEvent): void | Promise<void>;
};
/**
 * Opening the site from the installed tracker app has to be a plain link (only
 * those leave the app for Safari), and a token never goes in a URL. So the link
 * carries a one-time code instead (60 s) and the site collects the token for it
 * straight from the tracker, server to server.
 */
export declare function redeemHandoff(code: string, config: {
    issuer: string;
    audience: string;
    environment: string;
}): Promise<string | null>;
/**
 * The one-time code on a link. The parameter is "k" on /klicenka/otevrit: a link
 * shaped like OAuth (".../login?code=…") is kept inside the installed tracker app by
 * Safari's OAuth heuristic instead of going to the normal Safari window. "code" is
 * still read for links from 1.1.
 */
export declare function handoffCode(request: Request): string | null;
/** The token from a form POST, or for a one-time code on a GET link. */
export declare function tokenFromRequest(request: Request, config: {
    issuer: string;
    audience: string;
    environment: string;
}): Promise<string | null>;
/** Reads the token from a form POST (field "token"); JSON bodies work too. */
export declare function readToken(request: Request): Promise<string | null>;
/**
 * The receiving endpoint as a standard Request → Response function: POST only,
 * verify, find exactly the named account, log who really clicked, start the
 * session. Adapters wrap it for Next.js App/Pages Router, Supabase, NextAuth.
 */
export declare function createLoginHandler<User>(opts: LoginHandlerOptions<User>): (request: Request) => Promise<Response>;
/**
 * /klicenka/status — version, adapter, and the identifier + environment this
 * deployment answers to (public anyway: they're the token's audience). The tracker
 * reads them when a site is added, so nobody has to type them twice. Both default
 * to KLICENKA_AUDIENCE / KLICENKA_ENVIRONMENT.
 */
export declare function statusResponse(adapter: string, site?: {
    audience?: string;
    environment?: string;
}): Response;
/** A 303 redirect that sets a session cookie — the usual end of startSession. */
export declare function redirectWithCookie(location: string, cookie: {
    name: string;
    value: string;
    maxAgeSeconds: number;
    path?: string;
    sameSite?: "Lax" | "Strict";
    secure?: boolean;
}): Response;
