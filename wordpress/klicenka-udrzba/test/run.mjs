#!/usr/bin/env node
// Test klicenka-udrzba na WP Playground vedle klicenka.php: tokeny, záloha, aktualizace testovacího pluginu
// a šablony z lokálních zipů, vynucená chyba → návrat, obnova DB a souborů, držení posledních 3 záloh.
// Použití:  [PHP_VERSION=7.4] node wordpress/klicenka-udrzba/test/run.mjs [--keep]
// Nic neposílá ven: JWKS běží lokálně, wordpress.org je v testu zablokovaný.
import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, "..");
const klicenkaPhp = path.resolve(pluginDir, "../klicenka/klicenka.php");
const WP_PORT = Number(process.env.WP_PORT || 3108);
const JWKS_PORT = Number(process.env.JWKS_PORT || 3396);
const ISSUER = `http://127.0.0.1:${JWKS_PORT}`;
const AUD = "example-wordpress@local";
const WP = `http://127.0.0.1:${WP_PORT}`;
const keep = process.argv.includes("--keep");

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const otherKey = crypto.generateKeyPairSync("ed25519").privateKey;
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test1", alg: "EdDSA", use: "sig" };
const jwks = http.createServer((req, res) => {
  if (req.url === "/.well-known/jwks.json") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ keys: [jwk] })); }
  else res.writeHead(404).end();
});
await new Promise((r) => jwks.listen(JWKS_PORT, "127.0.0.1", r));

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sign(akce, req = {}, claims = {}, { typ = "klicenka-udrzba+jwt", key = privateKey, ttl = 60 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const iat = claims.iat ?? now;
  const payload = { iss: ISSUER, aud: AUD, sub: "tracker", jti: crypto.randomUUID(), iat, exp: iat + ttl, act: { sub: "u1", name: "Ondřej (test)", email: "o@example.test" }, scope: "udrzba", akce, req, ...claims };
  const h = b64({ alg: "EdDSA", typ, kid: "test1" });
  const p = b64(payload);
  return `${h}.${p}.${crypto.sign(null, Buffer.from(`${h}.${p}`), key).toString("base64url")}`;
}

// ---------- testovací plugin, šablona a jejich „aktualizace“ ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "klicenka-udrzba-test-"));
const mu = path.join(tmp, "mu-plugins");
const zalohy = path.join(tmp, "zalohy");
const zips = path.join(tmp, "zips");
for (const d of [mu, zalohy, zips]) fs.mkdirSync(d);
fs.copyFileSync(klicenkaPhp, path.join(mu, "klicenka.php"));
fs.copyFileSync(path.join(pluginDir, "klicenka-udrzba.php"), path.join(mu, "klicenka-udrzba.php"));
fs.copyFileSync(path.join(here, "test-helper.php"), path.join(mu, "zz-test-helper.php"));

const pluginCode = (v, body = "") => `<?php\n/**\n * Plugin Name: KUT Dummy\n * Version: ${v}\n */\nif (!defined('ABSPATH')) { exit; }\n${body}\n`;
const themeCss = (v) => `/*\nTheme Name: KUT Theme\nVersion: ${v}\n*/\n`;
function makeZip(name, files) {
  const stage = fs.mkdtempSync(path.join(tmp, "stage-"));
  for (const [rel, content] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true }); fs.writeFileSync(path.join(stage, rel), content); }
  execFileSync("zip", ["-qr", path.join(zips, name), "."], { cwd: stage });
}
makeZip("plugin-2.0.0.zip", { "kut-dummy/kut-dummy.php": pluginCode("2.0.0", "function kut_dummy_v2() { return 2; }"), "kut-dummy/readme.txt": "v2" });
// 3.0.0 shodí web (fatal na úvodní stránce, přihlášení jede dál).
makeZip("plugin-3.0.0-broken.zip", { "kut-dummy/kut-dummy.php": pluginCode("3.0.0", "add_action('wp', function () { kut_neexistujici_funkce(); });") });
makeZip("theme-1.1.0.zip", { "kut-theme/style.css": themeCss("1.1.0"), "kut-theme/index.php": "<?php // v1.1\n" });

const steps = [
  { step: "defineWpConfigConsts", consts: { KLICENKA_AUDIENCE: "example-wordpress", KLICENKA_ENVIRONMENT: "local", KLICENKA_ISSUER: ISSUER } },
  { step: "setSiteOptions", options: { blogname: "Původní název" } },
  { step: "mkdir", path: "/wordpress/wp-content/plugins/kut-dummy" },
  { step: "writeFile", path: "/wordpress/wp-content/plugins/kut-dummy/kut-dummy.php", data: pluginCode("1.0.0", "function kut_dummy_v1() { return 1; }") },
  { step: "activatePlugin", pluginPath: "kut-dummy/kut-dummy.php" },
  { step: "mkdir", path: "/wordpress/wp-content/themes/kut-theme" },
  { step: "writeFile", path: "/wordpress/wp-content/themes/kut-theme/style.css", data: themeCss("1.0.0") },
  { step: "writeFile", path: "/wordpress/wp-content/themes/kut-theme/index.php", data: "<?php // v1.0\n" },
];
fs.writeFileSync(path.join(tmp, "blueprint.json"), JSON.stringify({ steps, features: { networking: true } }));
const wpLog = fs.openSync(path.join(tmp, "playground.log"), "a");
// Víc workerů: kontrola webu po aktualizaci volá stejný web, zatímco první požadavek ještě běží.
const child = spawn("npx", ["-y", "@wp-playground/cli@3.1.60", "server", `--port=${WP_PORT}`,
  `--mount=${mu}:/wordpress/wp-content/mu-plugins`, `--mount=${zalohy}:/wordpress/wp-content/klicenka-zalohy`, `--mount=${zips}:/kut-zips`,
  `--blueprint=${path.join(tmp, "blueprint.json")}`, "--workers=3", `--php=${process.env.PHP_VERSION || "8.3"}`], { stdio: ["ignore", wpLog, wpLog], detached: true });
let stopped = false;
function stop() { if (stopped) return; stopped = true; try { process.kill(-child.pid, "SIGTERM"); } catch {} jwks.close(); if (!keep) fs.rmSync(tmp, { recursive: true, force: true }); else console.log(`  ponecháno: ${tmp}`); }
process.on("SIGINT", () => { stop(); process.exit(130); });

const api = (r) => `${WP}/?rest_route=/klicenka-udrzba/v1/${r}`;
const METHOD = { zaloha: "POST", aktualizace: "POST", obnova: "POST", zalohy: "GET" };
async function call(route, token, extra = "") {
  const r = await fetch(api(route) + extra, { method: METHOD[route], headers: token ? { authorization: `Bearer ${token}` } : {} });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, text: t };
}
const run = (akce, req = {}, claims = {}) => call(akce, sign(akce, req, claims));
const state = async () => (await fetch(`${WP}/?rest_route=/kut/v1/state&_=${Date.now()}`)).json();
const set = (o) => fetch(`${WP}/?rest_route=/kut/v1/set`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(o) });
const homeOk = async () => { const r = await fetch(`${WP}/?_=${Date.now()}`); const t = await r.text(); return r.status === 200 && !/critical error|Fatal error/i.test(t); };
let ok = 0, fail = 0;
const check = (n, c, d) => { if (c) { ok++; console.log(`  ✔ ${n}`); } else { fail++; console.log(`  ✘ ${n}  → ${JSON.stringify(d)?.slice(0, 600)}`); } };

try {
  process.stdout.write(`Playground (PHP ${process.env.PHP_VERSION || "8.3"}) startuje…`);
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > 600_000) throw new Error("Playground nenaběhl");
    try { const r = await fetch(`${WP}/`); if (r.status === 200) break; } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(` ${Math.round((Date.now() - t0) / 1000)} s`);
  check("web běží", await homeOk());
  const s0 = await state();
  check("testovací plugin 1.0.0 aktivní, šablona 1.0.0", s0.pluginVersion === "1.0.0" && s0.pluginActive && s0.themeVersion === "1.0.0", s0);

  console.log("Tokeny");
  check("bez tokenu 401", (await call("zalohy")).status === 401);
  check("přihlašovací token (klicenka+jwt) 401", (await call("zalohy", sign("zalohy", {}, {}, { typ: "klicenka+jwt" }))).status === 401);
  check("token stavu (klicenka-stav+jwt) 401", (await call("zalohy", sign("zalohy", {}, { scope: "stav" }, { typ: "klicenka-stav+jwt" }))).status === 401);
  check("cizí klíč 401", (await call("zalohy", sign("zalohy", {}, {}, { key: otherKey }))).status === 401);
  check("jiný web 401", (await call("zalohy", sign("zalohy", {}, { aud: "jiny@local" }))).status === 401);
  check("jiný vydavatel 401", (await call("zalohy", sign("zalohy", {}, { iss: "https://evil.example" }))).status === 401);
  check("vypršelý 401", (await call("zalohy", sign("zalohy", {}, { iat: Math.floor(Date.now() / 1000) - 600 }))).status === 401);
  check("platnost 5 min 401", (await call("zalohy", sign("zalohy", {}, {}, { ttl: 300 }))).status === 401);
  check("špatný scope 403", (await call("zalohy", sign("zalohy", {}, { scope: "stav" }))).status === 403);
  check("token pro jinou akci 403 (seznam → záloha)", (await call("zaloha", sign("zalohy"))).status === 403);
  check("token pro jinou akci 403 (záloha → aktualizace)", (await call("aktualizace", sign("zaloha", { items: [{ type: "plugin", slug: "kut-dummy" }] }))).status === 403);
  check("token v URL se nečte", (await call("zalohy", null, `&token=${sign("zalohy")}`)).status === 401);
  const lt = sign("zalohy");
  let r = await call("zalohy", lt);
  check("seznam záloh 200, zatím prázdný, zip a přímý zápis k dispozici", r.status === 200 && r.json?.backups?.length === 0 && r.json?.checks?.zip === true && r.json?.checks?.filesystem === "direct", r.json ?? r.text);
  check("stejný token podruhé 401", (await call("zalohy", lt)).status === 401);

  console.log("Záloha");
  const zt = sign("zaloha", { uploads: false });
  r = await call("zaloha", zt);
  const A = r.json?.backup;
  check("záloha 200: id, velikost, sha256", r.status === 200 && r.json?.ok && /^\d{8}-\d{6}-[a-f0-9]{12}$/.test(A?.id ?? "") && A.size > 0 && /^[a-f0-9]{64}$/.test(A.sha256), r.json ?? r.text);
  check("záloha s tokenem podruhé 401", (await call("zaloha", zt)).status === 401);
  const rootNames = fs.readdirSync(zalohy).filter((n) => /^[a-f0-9]{32}$/.test(n));
  check("náhodná složka (32 hex) + .htaccess a index.php", rootNames.length === 1 && fs.existsSync(path.join(zalohy, ".htaccess")) && fs.existsSync(path.join(zalohy, "index.php")) && fs.existsSync(path.join(zalohy, rootNames[0], ".htaccess")), fs.readdirSync(zalohy));
  const root = path.join(zalohy, rootNames[0] ?? "x");
  const bdir = path.join(root, A?.id ?? "x");
  const sqlA = fs.existsSync(path.join(bdir, "db.sql.gz")) ? zlib.gunzipSync(fs.readFileSync(path.join(bdir, "db.sql.gz"))).toString("utf8") : "";
  check("db.sql.gz: CREATE TABLE, INSERT, název webu, značka konce", /CREATE TABLE/.test(sqlA) && /INSERT INTO/.test(sqlA) && sqlA.includes("Původní název") && sqlA.endsWith("-- konec zálohy\n"), sqlA.slice(0, 300));
  const zipList = fs.existsSync(path.join(bdir, "soubory.zip")) ? execFileSync("unzip", ["-Z1", path.join(bdir, "soubory.zip")]).toString() : "";
  check("soubory.zip: plugins a themes, bez uploads", zipList.includes("plugins/kut-dummy/kut-dummy.php") && zipList.includes("themes/kut-theme/style.css") && !/^uploads\//m.test(zipList), zipList.slice(0, 300));
  const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  check("otisky v odpovědi sedí se soubory", A?.files?.every((f) => sha(path.join(bdir, f.name)) === f.sha256), A?.files);
  check("adresář záloh se nevypisuje", !(await (await fetch(`${WP}/wp-content/klicenka-zalohy/`)).text()).includes(rootNames[0] ?? "@@"));

  console.log("Aktualizace");
  await set({ kut_plugin_package: "/kut-zips/plugin-3.0.0-broken.zip", kut_plugin_version: "3.0.0" });
  r = await run("aktualizace", { items: [{ type: "plugin", slug: "kut-dummy" }] });
  let it = r.json?.items?.[0];
  check("rozbitá 3.0.0 → návrat na 1.0.0", r.json?.ok === false && it?.ok === false && it?.rolledBack === true && it?.from === "1.0.0" && it?.to === "1.0.0" && /nefunguje/.test(it?.error ?? ""), r.json ?? r.text);
  check("před aktualizací použita čerstvá záloha (žádná nová)", r.json?.backupNew === false && r.json?.backup?.id === A?.id, r.json?.backup);
  let s = await state();
  check("plugin po návratu 1.0.0 a pořád aktivní", s.pluginVersion === "1.0.0" && s.pluginActive, s);
  check("web po návratu běží", await homeOk());
  check("kopie pluginu uložená v záloze", fs.existsSync(path.join(bdir, "snap")) && fs.readdirSync(path.join(bdir, "snap")).some((n) => n.endsWith("plugin-kut-dummy")));

  await set({ kut_plugin_package: "/kut-zips/plugin-2.0.0.zip", kut_plugin_version: "2.0.0", kut_theme_package: "/kut-zips/theme-1.1.0.zip", kut_theme_version: "1.1.0" });
  r = await run("aktualizace", { items: [{ type: "theme", slug: "kut-theme" }, { type: "plugin", slug: "kut-dummy" }, { type: "plugin", slug: "kut-dummy" }, { type: "plugin", slug: "../evil" }] });
  const byKey = Object.fromEntries((r.json?.items ?? []).map((x) => [`${x.type}:${x.slug}`, x]));
  check("plugin 1.0.0 → 2.0.0 ok", byKey["plugin:kut-dummy"]?.ok === true && byKey["plugin:kut-dummy"]?.from === "1.0.0" && byKey["plugin:kut-dummy"]?.to === "2.0.0" && !byKey["plugin:kut-dummy"]?.rolledBack, r.json ?? r.text);
  check("šablona 1.0.0 → 1.1.0 ok", byKey["theme:kut-theme"]?.ok === true && byKey["theme:kut-theme"]?.to === "1.1.0", byKey["theme:kut-theme"]);
  check("duplicity a nepovolený slug vynechané", r.json?.items?.length === 2 && r.json?.ok === true, r.json?.items);
  s = await state();
  check("plugin 2.0.0 zůstal aktivní, šablona 1.1.0", s.pluginVersion === "2.0.0" && s.pluginActive && s.themeVersion === "1.1.0", s);
  check("web po aktualizaci běží", await homeOk());
  await set({ kut_plugin_package: "", kut_theme_package: "" });
  r = await run("aktualizace", { items: [{ type: "plugin", slug: "neexistuje" }, { type: "plugin", slug: "kut-dummy" }] });
  check("chybějící plugin a plugin bez aktualizace: chyba, nic se nemění", r.json?.ok === false && r.json?.items?.every((x) => !x.ok && !x.rolledBack) && /není/.test(r.json?.items?.[0]?.error ?? ""), r.json ?? r.text);
  check("prázdný seznam položek 400", (await run("aktualizace", { items: [] })).status === 400);

  console.log("Obnova");
  await set({ blogname: "Změněný název" });
  check("obnova bez potvrzení 403", (await call("obnova", sign("obnova", { backup: A?.id, db: true, files: true }))).status === 403);
  check("obnova s potvrzením jiné zálohy 403", (await call("obnova", sign("obnova", { backup: A?.id, db: true, files: true }, { confirm: "obnovit:20990101-000000-aaaaaaaaaaaa" }))).status === 403);
  check("obnova neexistující zálohy 404", (await call("obnova", sign("obnova", { backup: "20990101-000000-aaaaaaaaaaaa", db: true }, { confirm: "obnovit:20990101-000000-aaaaaaaaaaaa" }))).status === 404);
  const ot = sign("obnova", { backup: A?.id, db: true, files: true }, { confirm: `obnovit:${A?.id}` });
  r = await call("obnova", ot);
  check("obnova DB i souborů 200 s pojistnou zálohou", r.status === 200 && r.json?.ok && r.json?.db === "ok" && r.json?.files === "ok" && !!r.json?.safetyBackup, r.json ?? r.text);
  s = await state();
  check("po obnově: plugin 1.0.0, šablona 1.0.0, původní název", s.pluginVersion === "1.0.0" && s.themeVersion === "1.0.0" && s.blogname === "Původní název" && s.pluginActive, s);
  check("web po obnově běží", await homeOk());
  check("obnova s tokenem podruhé 401 (jti přežije obnovu DB)", (await call("obnova", ot)).status === 401);
  r = await run("zalohy");
  check("seznam: původní + pojistná (pred-obnovou), poslední akce", r.json?.backups?.length === 2 && r.json.backups[0].kind === "pred-obnovou" && r.json?.runs?.[0]?.akce === "obnova", r.json ?? r.text);

  console.log("Poškozená záloha a držení posledních 3");
  const newest = r.json?.backups?.[0]?.id;
  fs.appendFileSync(path.join(root, newest ?? "x", "db.sql.gz"), "x");
  check("obnova poškozené zálohy 409", (await call("obnova", sign("obnova", { backup: newest, db: true }, { confirm: `obnovit:${newest}` }))).status === 409);
  await set({ kut_plugin_package: "/kut-zips/plugin-2.0.0.zip", kut_plugin_version: "2.0.0" });
  r = await run("aktualizace", { items: [{ type: "plugin", slug: "kut-dummy" }] });
  check("poškozená poslední záloha → před aktualizací nová", r.json?.backupNew === true && r.json?.backup?.id !== newest && r.json?.items?.[0]?.ok === true, r.json ?? r.text);
  for (let i = 0; i < 2; i++) await run("zaloha");
  r = await run("zalohy");
  check("drží se poslední 3 zálohy", r.json?.backups?.length === 3 && !r.json.backups.some((b) => b.id === A?.id), r.json?.backups?.map((b) => b.id));
  check("na disku zůstaly jen 3 složky záloh", fs.readdirSync(root).filter((n) => /^\d{8}-\d{6}-/.test(n)).length === 3, fs.readdirSync(root));
  check("web na konci běží", await homeOk());
} catch (e) {
  fail++; console.log(`\n✘ ${e.stack ?? e.message}`);
} finally {
  console.log(`\n${ok} ok, ${fail} chyb`);
  stop();
  process.exit(fail ? 1 : 0);
}
