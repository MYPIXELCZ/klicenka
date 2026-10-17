import { createRemoteJWKSet, errors, jwtVerify } from "jose";
const MESSAGES = {
    missing: "Chybí přihlašovací token.",
    malformed: "Přihlašovací token je poškozený.",
    signature: "Podpis přihlašovacího tokenu nesedí.",
    "unknown-key": "Token je podepsaný klíčem, který tracker už nepoužívá.",
    expired: "Přihlašovací odkaz vypršel. Klikněte v trackeru znovu.",
    audience: "Token je určený pro jiný web nebo jiné prostředí.",
    issuer: "Token nevydal náš Project Tracker.",
    used: "Tento přihlašovací odkaz už byl použit. Klikněte v trackeru znovu.",
    claims: "Přihlašovací token nemá potřebné údaje.",
};
export const TOKEN_TYPE = "klicenka+jwt";
const MAX_TTL_SEC = 60;
const jwksCache = new Map();
function keysFor(config) {
    if (config.keys)
        return config.keys;
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
export function audienceOf(config) {
    return `${config.audience}@${config.environment}`;
}
function fail(code) {
    return { ok: false, code, message: MESSAGES[code] };
}
/**
 * Verifies a token from the tracker: EdDSA signature against the JWKS, issuer,
 * audience including the environment, expiry, a lifetime of at most 60 s, and that
 * its jti was never used (recorded now). Never trusts anything before all pass.
 */
export async function verifyKlicenkaToken(token, config) {
    if (!token)
        return fail("missing");
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
    }
    catch (e) {
        if (e instanceof errors.JWTExpired)
            return fail("expired");
        if (e instanceof errors.JWKSNoMatchingKey)
            return fail("unknown-key");
        if (e instanceof errors.JWSSignatureVerificationFailed)
            return fail("signature");
        if (e instanceof errors.JWTClaimValidationFailed) {
            if (e.claim === "aud")
                return fail("audience");
            if (e.claim === "iss")
                return fail("issuer");
            if (e.claim === "iat")
                return fail("expired");
            return fail("claims");
        }
        return fail("malformed");
    }
    const act = payload.act;
    if (typeof payload.sub !== "string" || !payload.sub ||
        typeof payload.jti !== "string" || typeof payload.exp !== "number" || typeof payload.iat !== "number" ||
        !act || typeof act.sub !== "string" || typeof act.email !== "string")
        return fail("claims");
    if (payload.exp - payload.iat > MAX_TTL_SEC)
        return fail("claims");
    if (!(await config.jtiStore.consume(payload.jti, new Date((payload.exp + tolerance) * 1000))))
        return fail("used");
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
