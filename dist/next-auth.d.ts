import { type KlicenkaClaims, type KlicenkaConfig } from "./verify.js";
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
    log?(event: {
        result: "signed-in" | "refused";
        code?: string;
        account?: string;
        act?: KlicenkaClaims["act"];
    }): void | Promise<void>;
};
type CredentialsFactory = (options: {
    id: string;
    name: string;
    credentials: Record<string, {
        label?: string;
        type?: string;
    }>;
    authorize: (credentials: Record<string, unknown> | undefined) => Promise<unknown>;
}) => unknown;
export declare function klicenkaProvider<User extends object>(Credentials: CredentialsFactory, opts: NextAuthKlicenkaOptions<User>): unknown;
/**
 * The receiving endpoint (/klicenka/login): an auto-submitting page that hands the
 * token to NextAuth's credentials callback with its CSRF token. `basePath` is
 * NextAuth's API path, `redirectTo` where to land.
 */
export declare function nextAuthReceiver(opts: {
    basePath?: string;
    redirectTo?: string;
    issuer?: string;
    nonce?: () => string | undefined;
}): (request: Request) => Promise<Response>;
/** jwt callback helper: keep the keyring's time limit on the token. */
export declare function klicenkaJwt<T extends Record<string, unknown>>(token: T, user?: unknown): T;
/** False once a keyring session has outlived its limit (sessions from a password sign-in are unaffected). */
export declare function klicenkaSessionValid(token: Record<string, unknown> | null | undefined, now?: number): boolean;
export {};
