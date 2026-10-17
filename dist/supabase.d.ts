import { type User } from "@supabase/supabase-js";
import { type LoginHandlerOptions } from "./handler.js";
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
export declare const UNTIL_COOKIE = "klicenka_until";
export declare function supabaseKlicenka(opts: SupabaseKlicenkaOptions): (request: Request) => Promise<Response>;
/** In middleware: true when a keyring session has outlived its limit — sign the user out. */
export declare function klicenkaSessionExpired(cookieValue: string | undefined, now?: number): boolean;
