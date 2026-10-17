import { verifyKlicenkaToken, type KlicenkaClaims, type KlicenkaConfig } from "./verify.js";
import { errorPage } from "./pages.js";
import { PROTOCOL, VERSION } from "./version.js";

export type LoginEvent =
  | { result: "signed-in"; account: string; act: KlicenkaClaims["act"]; jti: string }
  | { result: "refused"; code: string; account?: string; act?: KlicenkaClaims["act"] };

export type LoginHandlerOptions<User> = KlicenkaConfig & {
  /**
   * The account the token names (claims.sub) — exactly that one. Return null when it
   * doesn't exist; the sign-in is then refused (never "the first admin").
   */
  findAccount(sub: string, claims: KlicenkaClaims): Promise<User | null>;
  /** Start this site's own session for the user and answer (usually a redirect + cookie). */
  startSession(input: { user: User; claims: KlicenkaClaims; maxAgeSeconds: number; request: Request }): Promise<Response>;
  /** Write the real person (claims.act) to the site's log. Defaults to console. */
  log?(event: LoginEvent): void | Promise<void>;
};

function defaultLog(event: LoginEvent) {
  console.info("[klicenka]", JSON.stringify(event));
}

/** Reads the token from a form POST (field "token"); JSON bodies work too. */
export async function readToken(request: Request): Promise<string | null> {
  const type = request.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/json")) {
      const body = (await request.json()) as { token?: unknown };
      return typeof body.token === "string" ? body.token : null;
    }
    const form = await request.formData();
    const t = form.get("token");
    return typeof t === "string" ? t : null;
  } catch {
    return null;
  }
}

/**
 * The receiving endpoint as a standard Request → Response function: POST only,
 * verify, find exactly the named account, log who really clicked, start the
 * session. Adapters wrap it for Next.js App/Pages Router, Supabase, NextAuth.
 */
export function createLoginHandler<User>(opts: LoginHandlerOptions<User>) {
  const log = opts.log ?? defaultLog;
  return async function handle(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return errorPage("Sem se přichází tlačítkem „Přihlásit se“ v Klíčence.", opts.issuer, 405);
    }
    const result = await verifyKlicenkaToken(await readToken(request), opts);
    if (!result.ok) {
      await log({ result: "refused", code: result.code });
      return errorPage(result.message, opts.issuer);
    }
    const { claims } = result;
    let user: User | null;
    try {
      user = await opts.findAccount(claims.sub, claims);
    } catch (e) {
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
export function statusResponse(
  adapter: string,
  site: { audience?: string; environment?: string } = {},
): Response {
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
export function redirectWithCookie(
  location: string,
  cookie: { name: string; value: string; maxAgeSeconds: number; path?: string; sameSite?: "Lax" | "Strict"; secure?: boolean },
): Response {
  const parts = [
    `${cookie.name}=${encodeURIComponent(cookie.value)}`,
    `Path=${cookie.path ?? "/"}`,
    `Max-Age=${cookie.maxAgeSeconds}`,
    "HttpOnly",
    `SameSite=${cookie.sameSite ?? "Lax"}`,
  ];
  if (cookie.secure ?? true) parts.push("Secure");
  return new Response(null, { status: 303, headers: { Location: location, "Set-Cookie": parts.join("; "), "Cache-Control": "no-store" } });
}
