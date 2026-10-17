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
/** Reads the token from a form POST (field "token"); JSON bodies work too. */
export declare function readToken(request: Request): Promise<string | null>;
/**
 * The receiving endpoint as a standard Request → Response function: POST only,
 * verify, find exactly the named account, log who really clicked, start the
 * session. Adapters wrap it for Next.js App/Pages Router, Supabase, NextAuth.
 */
export declare function createLoginHandler<User>(opts: LoginHandlerOptions<User>): (request: Request) => Promise<Response>;
/** /klicenka/status — version and adapter, nothing sensitive. */
export declare function statusResponse(adapter: string): Response;
/** A 303 redirect that sets a session cookie — the usual end of startSession. */
export declare function redirectWithCookie(location: string, cookie: {
    name: string;
    value: string;
    maxAgeSeconds: number;
    path?: string;
    sameSite?: "Lax" | "Strict";
    secure?: boolean;
}): Response;
