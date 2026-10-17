import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";

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
  act: { sub: string; name: string | null; email: string };
  /** How long the session started here should last. */
  sessionHours: number;
  jti: string;
  exp: number;
};

export type VerifyFailure = { ok: false; code: VerifyCode; message: string };
export type VerifyCode = "missing" | "malformed" | "signature" | "unknown-key" | "expired" | "audience" | "issuer" | "used" | "claims" | "store";

const MESSAGES: Record<VerifyCode, string> = {
  missing: "Chybí přihlašovací token.",
  malformed: "Přihlašovací token je poškozený.",
  signature: "Podpis přihlašovacího tokenu nesedí.",
  "unknown-key": "Token je podepsaný klíčem, který tracker už nepoužívá.",
  expired: "Přihlašovací odkaz vypršel. Klikněte v trackeru znovu.",
  audience: "Token je určený pro jiný web nebo jiné prostředí.",
  issuer: "Token nevydal náš Project Tracker.",
  used: "Tento přihlašovací odkaz už byl použit. Klikněte v trackeru znovu.",
  claims: "Přihlašovací token nemá potřebné údaje.",
  store: "Web nemůže ověřit jednorázovost přihlášení. Nejspíš chybí tabulka klicenka_jti (spusťte migraci) nebo k ní nemá přístup.",
};

export const TOKEN_TYPE = "klicenka+jwt";
const MAX_TTL_SEC = 60;

const jwksCache = new Map<string, JWTVerifyGetKey>();
function keysFor(config: KlicenkaConfig): JWTVerifyGetKey {
  if (config.keys) return config.keys;
  const url = config.jwksUrl ?? `${config.issuer.replace(/\/$/, "")}/.well-known/jwks.json`;
  let k = jwksCache.get(url);
  if (!k) {
    // Cached for 10 minutes; an unknown kid triggers at most one refetch per 30 s,
    // which is how a rotated key reaches the site.
    k = createRemoteJWKSet(new URL(url), { cacheMaxAge: 10 * 60 * 1000, cooldownDuration: 30 * 1000 });
    jwksCache.set(url, k);
  }
  return k;
}

export function audienceOf(config: Pick<KlicenkaConfig, "audience" | "environment">): string {
  return `${config.audience}@${config.environment}`;
}

function fail(code: VerifyCode): VerifyFailure {
  return { ok: false, code, message: MESSAGES[code] };
}

/**
 * Verifies a token from the tracker: EdDSA signature against the JWKS, issuer,
 * audience including the environment, expiry, a lifetime of at most 60 s, and that
 * its jti was never used (recorded now). Never trusts anything before all pass.
 */
export async function verifyKlicenkaToken(
  token: string | null | undefined,
  config: KlicenkaConfig,
): Promise<{ ok: true; claims: KlicenkaClaims } | VerifyFailure> {
  if (!token) return fail("missing");
  const tolerance = config.clockToleranceSec ?? 30;
  let payload;
  try {
    ({ payload } = await jwtVerify(token, keysFor(config), {
      issuer: config.issuer.replace(/\/$/, ""),
      audience: audienceOf(config),
      algorithms: ["EdDSA"],
      typ: TOKEN_TYPE,
      clockTolerance: tolerance,
      maxTokenAge: MAX_TTL_SEC + tolerance,
      requiredClaims: ["sub", "jti", "exp", "iat", "act"],
    }));
  } catch (e) {
    if (e instanceof errors.JWTExpired) return fail("expired");
    if (e instanceof errors.JWKSNoMatchingKey) return fail("unknown-key");
    if (e instanceof errors.JWSSignatureVerificationFailed) return fail("signature");
    if (e instanceof errors.JWTClaimValidationFailed) {
      if (e.claim === "aud") return fail("audience");
      if (e.claim === "iss") return fail("issuer");
      if (e.claim === "iat") return fail("expired");
      return fail("claims");
    }
    return fail("malformed");
  }

  const act = payload.act as { sub?: unknown; name?: unknown; email?: unknown } | undefined;
  if (
    typeof payload.sub !== "string" || !payload.sub ||
    typeof payload.jti !== "string" || typeof payload.exp !== "number" || typeof payload.iat !== "number" ||
    !act || typeof act.sub !== "string" || typeof act.email !== "string"
  ) return fail("claims");
  if (payload.exp - payload.iat > MAX_TTL_SEC) return fail("claims");

  let fresh: boolean;
  try {
    fresh = await config.jtiStore.consume(payload.jti, new Date((payload.exp + tolerance) * 1000));
  } catch (e) {
    console.error("[klicenka] jti store failed", (e as { cause?: unknown }).cause ?? e);
    return fail("store");
  }
  if (!fresh) return fail("used");

  const sh = typeof payload.sh === "number" && payload.sh > 0 && payload.sh <= 72 ? payload.sh : 8;
  return {
    ok: true,
    claims: {
      sub: payload.sub,
      act: { sub: act.sub, name: typeof act.name === "string" ? act.name : null, email: act.email },
      sessionHours: sh,
      jti: payload.jti,
      exp: payload.exp,
    },
  };
}
