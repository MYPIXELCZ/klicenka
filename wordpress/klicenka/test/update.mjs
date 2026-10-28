#!/usr/bin/env node
// Test samoaktualizace klicenka.php na WP Playground: lokální „tracker“ (JWKS + podepsaný manifest + soubory)
// a web se starší kopií. Použití:  node wordpress/klicenka/test/update.mjs [--keep]
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const wp = path.resolve(here, "../..");
const NEW = fs.readFileSync(path.join(wp, "klicenka/klicenka.php"), "utf8");
const UPRAVY = fs.readFileSync(path.join(wp, "klicenka-upravy/klicenka-upravy.php"), "utf8");
const STAV = fs.readFileSync(path.join(wp, "klicenka-stav/klicenka-stav.php"), "utf8");
const UDRZBA = fs.readFileSync(path.join(wp, "klicenka-udrzba/klicenka-udrzba.php"), "utf8");
const OVERENI = fs.readFileSync(path.join(wp, "klicenka-overeni/klicenka-overeni.php"), "utf8");
const MERENI = fs.readFileSync(path.join(wp, "klicenka-mereni/klicenka-mereni.php"), "utf8");
const GSC_TOKEN = "TestZnacka_1234-abcdEF";
const NEW_VERSION = NEW.match(/Version:\s*([\d.]+)/)[1];
// „Stará“ kopie = nová s jinou verzí v hlavičce (stará 1.2 by se sama aktualizovat neuměla).
const OLD = NEW.replace(`define('KLICENKA_PLUGIN_VERSION', '${NEW_VERSION}')`, "define('KLICENKA_PLUGIN_VERSION', '1.4.0-old')");
const OLD_STAV = STAV + "\n// stará kopie\n";
const WP_PORT = 3107, T_PORT = 3397;
const ISSUER = `http://127.0.0.1:${T_PORT}`;
const keep = process.argv.includes("--keep");

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const otherKey = crypto.generateKeyPairSync("ed25519").privateKey;
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test1", alg: "EdDSA", use: "sig" };
let files = { "klicenka.php": NEW, "klicenka-upravy.php": UPRAVY, "klicenka-stav.php": STAV, "klicenka-udrzba.php": UDRZBA, "klicenka-overeni.php": OVERENI, "klicenka-mereni.php": MERENI };
const gscHosts = [];
let mode = "ok"; // ok | badsig | stale | badhash | syntax
const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
function manifest() {
  const served = { ...files };
  if (mode === "syntax") served["klicenka-stav.php"] = "<?php\nfunction (\n";
  const payload = { iss: ISSUER, iat: Math.floor(Date.now() / 1000) - (mode === "stale" ? 7200 : 0), version: NEW_VERSION,
    files: Object.entries(served).map(([name, c]) => ({ name, sha256: sha(c), size: Buffer.byteLength(c) })) };
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.sign(null, Buffer.from(p), mode === "badsig" ? otherKey : privateKey).toString("base64url");
  return { payload: p, kid: "test1", sig };
}
const tracker = http.createServer((req, res) => {
  if (req.url === "/.well-known/jwks.json") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [jwk] }));
  if (req.url === "/api/klicenka/wordpress/manifest") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(manifest()));
  if (req.url.startsWith("/api/gsc-overeni?")) {
    gscHosts.push(new URL(req.url, ISSUER).searchParams.get("host"));
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ token: GSC_TOKEN }));
  }
  const m = req.url.match(/^\/api\/klicenka\/wordpress\/file\/(.+)$/);
  if (m) {
    const name = decodeURIComponent(m[1]);
    let c = files[name];
    if (mode === "badhash" && name === "klicenka-stav.php") c = c + "\n// podvržený\n";
    if (mode === "syntax" && name === "klicenka-stav.php") c = "<?php\nfunction (\n";
    return c ? res.writeHead(200).end(c) : res.writeHead(404).end();
  }
  res.writeHead(404).end();
});
await new Promise((r) => tracker.listen(T_PORT, "127.0.0.1", r));

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function token(claims = {}, { typ = "klicenka-update+jwt", key = privateKey } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const p = { iss: ISSUER, aud: "example-wordpress@local", sub: "klicenka-update", jti: crypto.randomUUID(), iat: now, exp: now + 60, act: { sub: "u1", email: "o@example.test", name: "O" }, install: [], ...claims };
  const h = b64({ alg: "EdDSA", typ, kid: "test1" }), pl = b64(p);
  return `${h}.${pl}.${crypto.sign(null, Buffer.from(`${h}.${pl}`), key).toString("base64url")}`;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "klicenka-update-test-"));
const mu = path.join(tmp, "mu-plugins");
fs.mkdirSync(mu);
fs.writeFileSync(path.join(mu, "klicenka.php"), OLD);
fs.writeFileSync(path.join(mu, "klicenka-stav.php"), OLD_STAV);
fs.writeFileSync(path.join(tmp, "blueprint.json"), JSON.stringify({ steps: [{ step: "defineWpConfigConsts", consts: { KLICENKA_AUDIENCE: "example-wordpress", KLICENKA_ENVIRONMENT: "local", KLICENKA_ISSUER: ISSUER } }], features: { networking: true } }));
const log = fs.openSync(path.join(tmp, "playground.log"), "a");
const child = spawn("npx", ["-y", "@wp-playground/cli@3.1.60", "server", `--port=${WP_PORT}`, `--mount=${mu}:/wordpress/wp-content/mu-plugins`, `--blueprint=${path.join(tmp, "blueprint.json")}`, "--workers=1"], { stdio: ["ignore", log, log], detached: true });
const stop = () => { try { process.kill(-child.pid, "SIGTERM"); } catch {} tracker.close(); if (!keep) fs.rmSync(tmp, { recursive: true, force: true }); };
process.on("SIGINT", () => { stop(); process.exit(130); });

const WP = `http://127.0.0.1:${WP_PORT}`;
const status = async () => (await fetch(`${WP}/wp-admin/admin-ajax.php?action=klicenka_status&_=${Date.now()}`)).json();
const update = async (t) => { const r = await fetch(`${WP}/wp-admin/admin-ajax.php?action=klicenka_update`, { method: "POST", body: new URLSearchParams({ token: t }) }); return { status: r.status, json: await r.json().catch(() => null) }; };
const read = (n) => fs.existsSync(path.join(mu, n)) ? fs.readFileSync(path.join(mu, n), "utf8") : null;
let ok = 0, fail = 0;
const nTags = (html) => html.match(/<script\b[^>]*\/n\.js"[^>]*>/g) ?? [];
const check = (n, c, d) => { if (c) { ok++; console.log(`  ✔ ${n}`); } else { fail++; console.log(`  ✘ ${n}  → ${JSON.stringify(d)?.slice(0, 300)}`); } };

try {
  process.stdout.write("Playground startuje…");
  const t0 = Date.now();
  for (;;) { if (Date.now() - t0 > 600_000) throw new Error("Playground nenaběhl"); try { if ((await fetch(`${WP}/`)).status === 200) break; } catch {} await new Promise((r) => setTimeout(r, 2000)); }
  console.log(` ${Math.round((Date.now() - t0) / 1000)} s`);
  check("stará kopie běží", (await status()).version === "1.4.0-old");

  check("bez tokenu 401", (await update("")).status === 401);
  check("cizí klíč 401", (await update(token({}, { key: otherKey }))).status === 401);
  check("přihlašovací typ tokenu 401", (await update(token({}, { typ: "klicenka+jwt" }))).status === 401);
  check("jiný web 401", (await update(token({ aud: "jiny@local" }))).status === 401);

  mode = "badsig";
  let r = await update(token());
  check("podvržený podpis manifestu odmítnut", r.json?.error === "signature" && read("klicenka.php") === OLD, r.json);
  mode = "stale";
  r = await update(token());
  check("starý manifest (2 h) odmítnut", r.json?.error === "manifest" && read("klicenka.php") === OLD, r.json);
  mode = "badhash";
  r = await update(token());
  check("nesedící otisk souboru → nic nezměněno", r.json?.error === "download" && read("klicenka.php") === OLD && read("klicenka-stav.php") === OLD_STAV, r.json);
  mode = "syntax";
  r = await update(token());
  check("soubor s chybou syntaxe → nic nezměněno", r.json?.error === "syntax" && read("klicenka.php") === OLD, r.json);
  check("web po odmítnutích běží", (await fetch(`${WP}/`)).status === 200);

  mode = "ok";
  r = await update(token());
  check("platná aktualizace: klicenka.php i klicenka-stav.php", r.json?.ok && r.json.updated.includes("klicenka.php") && r.json.updated.includes("klicenka-stav.php") && read("klicenka.php") === NEW && read("klicenka-stav.php") === STAV, r.json);
  check("klicenka-upravy.php bez pokynu nepřibyl", read("klicenka-upravy.php") === null);
  check("klicenka-udrzba.php bez pokynu nepřibyl", read("klicenka-udrzba.php") === null && (await status()).udrzba === false);
  check("klicenka-overeni.php přibyl sám (neškodný)", r.json.updated.includes("klicenka-overeni.php") && read("klicenka-overeni.php") === OVERENI && (await status()).overeni === true, r.json);
  const home = await (await fetch(`${WP}/?_=${Date.now()}`)).text();
  check("úvodní stránka má značku google-site-verification", home.includes(`<meta name="google-site-verification" content="${GSC_TOKEN}" />`), home.slice(0, 300));
  check("značka se bere podle hostitele webu", gscHosts[0] === "127.0.0.1", gscHosts);
  const before = gscHosts.length;
  await fetch(`${WP}/?_=${Date.now()}`);
  check("značka z uložené hodnoty (tracker podruhé nevolá)", gscHosts.length === before, gscHosts);
  check("klicenka-mereni.php přibyl sám (neškodný)", r.json.updated.includes("klicenka-mereni.php") && read("klicenka-mereni.php") === MERENI && (await status()).mereni === true, r.json);
  const tags = nTags(home);
  check("úvodní stránka má měřicí skript jednou", tags.length === 1, tags);
  check("měřicí skript: defer, src z issueru, data-site = KLICENKA_AUDIENCE", /\sdefer(=|\s|>)/.test(tags[0] ?? "") && (tags[0] ?? "").includes(`src="${ISSUER}/n.js"`) && (tags[0] ?? "").includes('data-site="example-wordpress"'), tags);
  check("předchozí verze uložena jako .prev", read("klicenka.php.prev") === OLD);
  check("žádné .new po aktualizaci", !fs.readdirSync(mu).some((f) => f.endsWith(".new")));
  const st = await status();
  check(`stav hlásí ${NEW_VERSION}`, st.version === NEW_VERSION, st);
  check("web po aktualizaci běží", (await fetch(`${WP}/`)).status === 200);
  r = await update(token());
  check("opakovaně: vše beze změny", r.json?.ok && r.json.updated.length === 0 && r.json.unchanged.includes("klicenka.php"), r.json);
  r = await update(token({ install: ["klicenka-upravy.php", "../wp-config.php", "evil.php"] }));
  check("install přidá jen povolený soubor", r.json?.ok && read("klicenka-upravy.php") === UPRAVY && !fs.existsSync(path.join(mu, "evil.php")), r.json);
  check("stav hlásí upravy: true", (await status()).upravy === true);
  r = await update(token({ install: ["klicenka-udrzba.php"] }));
  check("install přidá klicenka-udrzba.php", r.json?.ok && read("klicenka-udrzba.php") === UDRZBA && (await status()).udrzba === true, r.json);
  check("web s klicenka-udrzba běží (pasivní)", (await fetch(`${WP}/`)).status === 200);
  const pas = await fetch(`${WP}/?rest_route=/klicenka-udrzba/v1/zalohy`);
  check("údržba bez tokenu 401", pas.status === 401);
  const t = token();
  await update(t);
  check("stejný token podruhé 401", (await update(t)).status === 401);

  // Přihlášený správce (přes Klíčenku) měřicí skript nedostane — až na konci, ať přihlášení neovlivní nic jiného.
  const login = await fetch(`${WP}/wp-login.php?action=klicenka`, { method: "POST", body: new URLSearchParams({ token: token({ sub: "admin" }, { typ: "klicenka+jwt" }) }), redirect: "manual" });
  const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  check("přihlášení správce přes Klíčenku", login.status === 302 && cookie.includes("wordpress_logged_in_"), login.status);
  const adminHome = await (await fetch(`${WP}/?_=${Date.now()}`, { headers: { cookie } })).text();
  check("přihlášený správce bez měřicího skriptu", adminHome.includes("admin-bar") && nTags(adminHome).length === 0, nTags(adminHome));
  check("nepřihlášený návštěvník ho dál má", nTags(await (await fetch(`${WP}/?_=${Date.now()}`)).text()).length === 1);
} catch (e) {
  fail++; console.log(`\n✘ ${e.message}`);
} finally {
  console.log(`\n${ok} ok, ${fail} chyb`);
  stop();
  process.exit(fail ? 1 : 0);
}
