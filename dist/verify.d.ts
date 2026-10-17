import { type JWTVerifyGetKey } from "jose";
export type Environment = "production" | "preview" | "local";
export type KlicenkaConfig = {
    /** The tracker, e.g. https://tracker.mypixel.cz — the token's iss. */
    issuer: string;
    /** This site's stable identifier as entered in the tracker (not its URL). */
    audience: string;
    /** Which environment this deployment is; a token for another one is refused. */
    environment: Environment;
    /** Defaults to `${issuer}/.well-known/jwks.json`. */
    jwksUrl?: string;
    /** Remembers used token ids; see jti.ts. */
    jtiStore: JtiStore;
    /** Clock difference tolerated, seconds (default 30). */
    clockToleranceSec?: number;
    /** For tests: verify against these keys instead of fetching the JWKS. */
    keys?: JWTVerifyGetKey;
};
export interface JtiStore {
    /** Records the id; resolves true the first time, false if it was used before. */
    consume(jti: string, expiresAt: Date): Promise<boolean>;
}
export type KlicenkaClaims = {
    /** The account on this site to sign in as. */
    sub: string;
    /** The real person behind the click, from the tracker. */
    act: {
        sub: string;
        name: string | null;
        email: string;
    };
    /** How long the session started here should last. */
    sessionHours: number;
    jti: string;
    exp: number;
};
export type VerifyFailure = {
    ok: false;
    code: VerifyCode;
    message: string;
};
export type VerifyCode = "missing" | "malformed" | "signature" | "unknown-key" | "expired" | "audience" | "issuer" | "used" | "claims";
export declare const TOKEN_TYPE = "klicenka+jwt";
export declare function audienceOf(config: Pick<KlicenkaConfig, "audience" | "environment">): string;
/**
 * Verifies a token from the tracker: EdDSA signature against the JWKS, issuer,
 * audience including the environment, expiry, a lifetime of at most 60 s, and that
 * its jti was never used (recorded now). Never trusts anything before all pass.
 */
export declare function verifyKlicenkaToken(token: string | null | undefined, config: KlicenkaConfig): Promise<{
    ok: true;
    claims: KlicenkaClaims;
} | VerifyFailure>;
