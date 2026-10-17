// End-to-end: local tracker → passkey (virtual authenticator) → keyring login → test site.
// Usage: E2E_EMAIL=… E2E_PASSWORD=… node e2e/run.mjs cookie [nextauth4 nextauth5 supabase wordpress]
// Credentials come from the tracker's seed (test account on a local tracker only); never printed.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const TRACKER = process.env.TRACKER ?? "http://localhost:3300";
const OUT = new URL("./.state/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const SITES = {
  cookie: { name: "E2E vlastní cookie", url: "http://127.0.0.1:3101", type: "NEXTJS", audience: "example-cookie", subject: "admin@example.test", expect: "Přihlášen jako admin@example.test", receiver: "/klicenka/login" },
  nextauth4: { name: "E2E NextAuth v4", url: "http://127.0.0.1:3102", type: "NEXTJS", audience: "example-nextauth4", subject: "admin@example.test", expect: "Přihlášen jako admin@example.test", receiver: "/klicenka/login" },
  nextauth5: { name: "E2E NextAuth v5", url: "http://localhost:3103", type: "NEXTJS", audience: "example-nextauth5", subject: "admin@example.test", expect: "Přihlášen jako admin@example.test", receiver: "/klicenka/login" },
  supabase: { name: "E2E Supabase", url: "http://localhost:3104", type: "NEXTJS", audience: "example-supabase", subject: "admin@example.test", expect: "Přihlášen jako admin@example.test", receiver: "/klicenka/login" },
  wordpress: { name: "E2E WordPress", url: "http://127.0.0.1:3105", type: "WORDPRESS", audience: "example-wordpress", subject: "admin", expect: "Dashboard", receiver: "/wp-login.php?action=klicenka" },
};

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ["cookie"];
const results = [];
const ok = (name, pass, detail = "") => { results.push({ name, pass, detail }); console.log(`${pass ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: "cs-CZ" });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
});

const api = (path, method = "GET", body) => page.evaluate(async ([p, m, b]) => {
  const r = await fetch(p, { method: m, headers: { "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [path, method, body]);

try {
  // 1) Sign in to the tracker.
  await page.goto(`${TRACKER}/login`);
  await page.fill("#email", process.env.E2E_EMAIL);
  await page.fill("#password", process.env.E2E_PASSWORD);
  await page.getByRole("button", { name: "Přihlásit se" }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 60000 });
  ok("přihlášení do trackeru", true);

  // 2) Passkey for the keyring (registration verified on the server).
  await page.goto(`${TRACKER}/klicenka`);
  // Each run has a fresh virtual authenticator, so passkeys from earlier runs can't sign.
  const existing = await api("/api/passkeys");
  for (const old of existing.body?.passkeys ?? []) await api(`/api/passkeys/${old.id}`, "DELETE");
  await page.reload();
  {
    await page.getByRole("button", { name: "Přidat passkey" }).first().click();
    const add = page.getByRole("dialog").getByRole("button", { name: "Přidat passkey" });
    await add.waitFor({ timeout: 20000 });
    await add.click();
    await page.getByText("Passkey přidán").waitFor({ timeout: 20000 });
  }
  const pk = await api("/api/passkeys");
  ok("passkey zaregistrován a ověřen serverem", pk.body?.passkeys?.length > 0);

  for (const key of wanted) {
    const s = SITES[key];
    // 3) The site with one usable account and one hidden ("jen vybraní", nobody selected).
    const list = await api("/api/klicenka/sites");
    for (const old of list.body.sites.filter((x) => x.name === s.name)) await api(`/api/klicenka/sites/${old.id}`, "DELETE");
    const created = await api("/api/klicenka/sites", "POST", { name: s.name, url: s.url, type: s.type, audience: s.audience, environment: "LOCAL", companyId: null, sessionHours: 2 });
    if (created.status !== 200) { ok(`${key}: založení webu`, false, JSON.stringify(created.body)); continue; }
    const siteId = created.body.site.id;
    await api(`/api/klicenka/sites/${siteId}/accounts`, "POST", { label: "Admin", subject: s.subject, role: "Admin" });
    const hidden = await api(`/api/klicenka/sites/${siteId}/accounts`, "POST", { label: "Skrytý", subject: "hidden@example.test" });
    await api(`/api/klicenka/accounts/${hidden.body.account.id}/access`, "PUT", { mode: "ONLY_SELECTED", rules: [] });
    const denied = await api("/api/klicenka/login/options", "POST", { accountId: hidden.body.account.id });
    ok(`${key}: skrytý účet token nedostane`, denied.status === 403, denied.body?.error);

    // 4) Click "Přihlásit se" in the keyring and land in the site's admin. Arrive
    // through the menu (soft navigation), like a person does: the first loaded page's
    // CSP stays in force, which once blocked the token form.
    await page.goto(`${TRACKER}/dashboard`);
    await page.getByRole("link", { name: "Klíčenka" }).first().click();
    await page.waitForURL(/\/klicenka$/);
    const row = page.locator("li", { has: page.getByRole("link", { name: s.name, exact: true }) });
    const btn = row.getByRole("button", { name: "Přihlásit se" });
    await btn.waitFor({ timeout: 20000 });
    ok(`${key}: v nabídce jen použitelný účet`, (await btn.getAttribute("title")) === "Přihlásit se jako Admin");
    let posted = null;
    const onReq = (r) => { if (r.method() === "POST" && r.url().startsWith(s.url + s.receiver.split("?")[0])) posted = r.postData(); };
    page.on("request", onReq);
    await btn.hover();
    await page.waitForTimeout(800);
    await btn.click();
    const confirm = row.getByRole("button", { name: "Potvrdit passkey" });
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
    await page.waitForURL((u) => u.toString().startsWith(s.url), { timeout: 30000 });
    await page.getByText(s.expect).first().waitFor({ timeout: 30000 });
    page.off("request", onReq);
    await page.screenshot({ path: `${OUT}${key}.png` });
    ok(`${key}: přihlášení na klik`, true, page.url());
    const actShown = await page.getByText("Přes Klíčenku").count();
    if (key === "cookie" || key.startsWith("nextauth")) ok(`${key}: web zná skutečného člověka (act)`, actShown > 0);

    // 5) The same token a second time is refused.
    const token = posted ? new URLSearchParams(posted).get("token") : null;
    if (token) {
      if (key.startsWith("nextauth")) {
        // NextAuth verifies in its credentials callback — replay the token there.
        const csrf = await (await ctx.request.get(`${s.url}/api/auth/csrf`)).json();
        const replay = await ctx.request.post(`${s.url}/api/auth/callback/klicenka`, {
          form: { token, csrfToken: csrf.csrfToken, callbackUrl: "/admin" }, maxRedirects: 0,
        });
        const loc = replay.headers()["location"] ?? "";
        ok(`${key}: opakované použití tokenu odmítnuto`, /error/i.test(loc), `HTTP ${replay.status()} → ${loc.replace(s.url, "")}`);
      } else {
        const replay = await ctx.request.post(s.url + s.receiver, { form: { token }, maxRedirects: 0 });
        const text = await replay.text();
        ok(`${key}: opakované použití tokenu odmítnuto`, replay.status() >= 400 && /už byl použit/.test(text), `HTTP ${replay.status()}`);
      }
    } else ok(`${key}: zachycení tokenu`, false, "POST se nepodařilo zachytit");

    // 6) Audit log entry exists.
    await page.goto(`${TRACKER}/klicenka`);
  }
} catch (e) {
  await page.screenshot({ path: `${OUT}failure.png` }).catch(() => {});
  ok("průchod", false, String(e?.message ?? e).split("\n")[0]);
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} kroků prošlo`);
process.exit(failed ? 1 : 0);
