#!/usr/bin/env node
// Test klicenka-udrzba na WP Playground vedle klicenka.php: tokeny, záloha, aktualizace testovacího pluginu
// a šablony z lokálních zipů, vynucená chyba → návrat, obnova DB a souborů, držení posledních 3 záloh,
// záloha po krocích s médii (víc částí zipu), stažení s HTTP Range a uvolnění místa po záloze mimo hosting.
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
// uploads o složku níž než přípojný bod (UPLOADS), aby ji obnova mohla vyměnit přejmenováním jako na hostingu.
const mediaMount = path.join(tmp, "media");
const uploads = path.join(mediaMount, "uploads");
for (const d of [mu, zalohy, zips, mediaMount, uploads]) fs.mkdirSync(d);

// Média: hodně malých „fotek“ (náhodná, nekomprimovatelná data), pár větších, text, prázdná složka
// a složky, které se zálohovat nemají (mezipaměť, zálohy jiného pluginu).
const media = {};
const put = (rel, buf) => { const p = path.join(uploads, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); media[rel] = buf; };
for (let i = 0; i < 600; i++) put(`2024/01/foto-${String(i).padStart(3, "0")}.jpg`, crypto.randomBytes(2048 + (i % 7) * 1024));
for (let i = 0; i < 6; i++) put(`2024/03/velka-${i}.jpg`, crypto.randomBytes(700 * 1024));
for (let i = 0; i < 300; i++) put(`2025/06/text ${i} á.txt`, Buffer.from(`Příliš žluťoučký kůň ${i}\n`.repeat(40)));
fs.mkdirSync(path.join(uploads, "2024/02/prazdna"), { recursive: true });
fs.mkdirSync(path.join(uploads, "cache"), { recursive: true });
fs.writeFileSync(path.join(uploads, "cache/x.txt"), "cache");
fs.mkdirSync(path.join(uploads, "backwpup-abc123"), { recursive: true });
fs.writeFileSync(path.join(uploads, "backwpup-abc123/zaloha.zip"), "jiny plugin");
const mediaCount = Object.keys(media).length;
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
  { step: "defineWpConfigConsts", consts: { KLICENKA_AUDIENCE: "example-wordpress", KLICENKA_ENVIRONMENT: "local", KLICENKA_ISSUER: ISSUER, UPLOADS: "wp-content/media/uploads" } },
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
  `--mount=${mu}:/wordpress/wp-content/mu-plugins`, `--mount=${zalohy}:/wordpress/wp-content/klicenka-zalohy`, `--mount=${zips}:/kut-zips`, `--mount=${mediaMount}:/wordpress/wp-content/media`,
  `--blueprint=${path.join(tmp, "blueprint.json")}`, "--workers=3", `--php=${process.env.PHP_VERSION || "8.3"}`], { stdio: ["ignore", wpLog, wpLog], detached: true });
let stopped = false;
function stop() { if (stopped) return; stopped = true; try { process.kill(-child.pid, "SIGTERM"); } catch {} jwks.close(); if (!keep) fs.rmSync(tmp, { recursive: true, force: true }); else console.log(`  ponecháno: ${tmp}`); }
process.on("SIGINT", () => { stop(); process.exit(130); });

const api = (r) => `${WP}/?rest_route=/klicenka-udrzba/v1/${r}`;
const METHOD = { zaloha: "POST", aktualizace: "POST", obnova: "POST", zalohy: "GET", stahnout: "GET", uvolnit: "POST" };
async function call(route, token, extra = "") {
  const r = await fetch(api(route) + extra, { method: METHOD[route], headers: token ? { authorization: `Bearer ${token}` } : {} });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, text: t };
}
const run = (akce, req = {}, claims = {}) => call(akce, sign(akce, req, claims));
/** Stažení souboru zálohy (syrová data), volitelně s hlavičkou Range. */
async function download(token, range) {
  const r = await fetch(api("stahnout") + `&_=${Date.now()}`, { headers: { authorization: `Bearer ${token}`, ...(range ? { range } : {}) } });
  return { status: r.status, headers: r.headers, body: Buffer.from(await r.arrayBuffer()) };
}
/** Jednoduché čtení zipu (centrální adresář, bez ZIP64): jméno → {method, data()}; unzip v macOS kazí UTF-8 jména. */
function readZip(file) {
  const b = fs.readFileSync(file);
  let e = b.length - 22;
  while (e >= 0 && b.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error(`není zip: ${file}`);
  const n = b.readUInt16LE(e + 10);
  let p = b.readUInt32LE(e + 16);
  const out = new Map();
  for (let i = 0; i < n; i++) {
    const method = b.readUInt16LE(p + 10), csize = b.readUInt32LE(p + 20), nl = b.readUInt16LE(p + 28), xl = b.readUInt16LE(p + 30), cl = b.readUInt16LE(p + 32), off = b.readUInt32LE(p + 42);
    const name = b.subarray(p + 46, p + 46 + nl).toString("utf8");
    out.set(name, { method, data: () => { const start = off + 30 + b.readUInt16LE(off + 26) + b.readUInt16LE(off + 28); const raw = b.subarray(start, start + csize); return method === 8 ? zlib.inflateRawSync(raw) : raw; } });
    p += 46 + nl + xl + cl;
  }
  return out;
}
/** Záloha po krocích: volá „zaloha“ s req.krok, dokud není hotovo. */
async function chunked(req, max = 300) {
  const out = { steps: 0, job: null, backup: null, last: null };
  while (out.steps < max) {
    const r = await run("zaloha", { krok: true, ...req });
    out.steps++;
    out.last = r;
    if (r.status !== 200 || !r.json?.ok) return out;
    if (r.json.done) { out.backup = r.json.backup; return out; }
    out.job = r.json.job;
  }
  return out;
}
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

  console.log("Záloha po krocích s médii");
  const hashOf = (b) => crypto.createHash("sha256").update(b).digest("hex");
  const req = { uploads: true, kind: "mimo-hosting", budget: 1, part: 1048576, partFiles: 200 };
  const first = await run("zaloha", { krok: true, ...req });
  check("první krok: rozpracováno, ne hotovo", first.status === 200 && first.json?.done === false && first.json?.job?.phase && /^\d{8}-\d{6}-/.test(first.json?.job?.id ?? ""), first.json ?? first.text);
  r = await run("zalohy");
  check("seznam ukazuje rozpracovanou zálohu", r.json?.job?.id === first.json?.job?.id && !r.json?.backups?.some((b) => b.id === first.json?.job?.id), r.json?.job);
  check("aktualizace během rozpracované zálohy 409", (await run("aktualizace", { items: [{ type: "plugin", slug: "kut-dummy" }] })).status === 409);
  check("obnova během rozpracované zálohy 409", (await call("obnova", sign("obnova", { backup: r.json?.backups?.[0]?.id, db: true }, { confirm: `obnovit:${r.json?.backups?.[0]?.id}` }))).status === 409);
  check("jiná záloha po krocích (bez médií) mezitím 409", (await run("zaloha", { krok: true, uploads: false })).status === 409);
  check("rozpracovanou zálohu nejde stáhnout (404)", (await download(sign("stahnout", { backup: first.json?.job?.id, file: "db.sql.gz" }))).status === 404);
  const C = await chunked(req);
  const cb = C.backup;
  check("záloha po krocích doběhla (víc kroků, stejná záloha)", !!cb && C.steps + 1 >= 2 && cb.id === first.json?.job?.id && cb.chunked === true && cb.kind === "mimo-hosting" && cb.uploads === true, { steps: C.steps, last: C.last?.json ?? C.last?.text });
  const cdir = path.join(root, cb?.id ?? "x");
  const zipParts = (cb?.files ?? []).filter((f) => /^soubory(-\d{3})?\.zip$/.test(f.name));
  check("soubory ve víc částech zipu (soubory.zip, soubory-002.zip, …)", zipParts.length >= 5 && zipParts[0].name === "soubory.zip" && zipParts[1]?.name === "soubory-002.zip", cb?.files?.map((f) => f.name));
  check("otisky všech částí sedí", (cb?.files ?? []).every((f) => fs.existsSync(path.join(cdir, f.name)) && hashOf(fs.readFileSync(path.join(cdir, f.name))) === f.sha256 && fs.statSync(path.join(cdir, f.name)).size === f.size), cb?.files);
  check("po dokončení žádný job.json ani seznam.txt", !fs.existsSync(path.join(cdir, "job.json")) && !fs.existsSync(path.join(cdir, "seznam.txt")) && fs.existsSync(path.join(cdir, "manifest.json")), fs.readdirSync(cdir));
  const sqlC = zlib.gunzipSync(fs.readFileSync(path.join(cdir, "db.sql.gz"))).toString("utf8");
  check("db.sql.gz celá (gzip z víc kroků), značka konce", /INSERT INTO/.test(sqlC) && sqlC.endsWith("-- konec zálohy\n") && sqlC.split("-- konec zálohy").length === 2, sqlC.slice(-200));
  const inZip = new Map();
  for (const p of zipParts) for (const [n, entry] of readZip(path.join(cdir, p.name))) inZip.set(n, entry);
  const mediaRels = Object.keys(media);
  check(`všech ${mediaCount} souborů médií je v částech`, mediaRels.every((rel) => inZip.has(`uploads/${rel}`)), mediaRels.filter((rel) => !inZip.has(`uploads/${rel}`)).slice(0, 5));
  check("i pluginy, šablony a prázdná složka", inZip.has("plugins/kut-dummy/kut-dummy.php") && inZip.has("themes/kut-theme/style.css") && inZip.has("uploads/2024/02/prazdna/"), [...inZip.keys()].filter((n) => !n.startsWith("uploads/2")).slice(0, 20));
  check("mezipaměť a zálohy jiných pluginů vynechané", ![...inZip.keys()].some((n) => n.startsWith("uploads/cache/") || n.startsWith("uploads/backwpup-")), [...inZip.keys()].filter((n) => /cache|backwpup/.test(n)));
  const sample = ["2024/03/velka-3.jpg", "2025/06/text 7 á.txt", "2024/01/foto-599.jpg"];
  check("obsah souborů v zipu sedí s originálem", sample.every((rel) => inZip.has(`uploads/${rel}`) && hashOf(inZip.get(`uploads/${rel}`).data()) === hashOf(media[rel])));
  check("fotky se jen ukládají (stored), text se komprimuje (deflate)", inZip.get("uploads/2024/03/velka-3.jpg")?.method === 0 && inZip.get("uploads/2025/06/text 7 á.txt")?.method === 8, [inZip.get("uploads/2024/03/velka-3.jpg")?.method, inZip.get("uploads/2025/06/text 7 á.txt")?.method]);

  console.log("Stažení zálohy");
  const big = zipParts.reduce((a, b) => (b.size > a.size ? b : a), zipParts[0]);
  const bigBuf = fs.readFileSync(path.join(cdir, big.name));
  let d = await download(sign("stahnout", { backup: cb?.id, file: big.name }));
  check("celé stažení 200, otisk sedí, hlavičky", d.status === 200 && hashOf(d.body) === big.sha256 && d.headers.get("x-klicenka-sha256") === big.sha256 && d.headers.get("accept-ranges") === "bytes" && Number(d.headers.get("content-length")) === big.size, { status: d.status, len: d.body.length, size: big.size, ct: d.headers.get("content-type") });
  d = await download(sign("stahnout", { backup: cb?.id, file: big.name }), "bytes=10-109");
  check("Range bytes=10-109 → 206, 100 B, Content-Range", d.status === 206 && d.body.length === 100 && d.body.equals(bigBuf.subarray(10, 110)) && d.headers.get("content-range") === `bytes 10-109/${big.size}`, { status: d.status, len: d.body.length, cr: d.headers.get("content-range") });
  const half = Math.floor(big.size / 2);
  const d1 = await download(sign("stahnout", { backup: cb?.id, file: big.name }), `bytes=0-${half - 1}`);
  const d2 = await download(sign("stahnout", { backup: cb?.id, file: big.name }), `bytes=${half}-`);
  check("přerušené stahování naváže (dvě půlky = celý soubor)", d1.status === 206 && d2.status === 206 && hashOf(Buffer.concat([d1.body, d2.body])) === big.sha256, { s1: d1.status, s2: d2.status, l1: d1.body.length, l2: d2.body.length });
  d = await download(sign("stahnout", { backup: cb?.id, file: big.name }), "bytes=-50");
  check("Range bytes=-50 → posledních 50 B", d.status === 206 && d.body.equals(bigBuf.subarray(big.size - 50)), { status: d.status, len: d.body.length });
  check("Range za koncem → 416", (await download(sign("stahnout", { backup: cb?.id, file: big.name }), `bytes=${big.size}-`)).status === 416);
  const dbp = cb?.files?.find((f) => f.name === "db.sql.gz");
  d = await download(sign("stahnout", { backup: cb?.id, file: "db.sql.gz" }));
  check("stažení db.sql.gz sedí", d.status === 200 && hashOf(d.body) === dbp?.sha256);
  d = await download(sign("stahnout", { backup: cb?.id, file: "manifest.json" }));
  check("stažení manifest.json (popis pro obnovu)", d.status === 200 && JSON.parse(d.body.toString()).id === cb?.id && JSON.parse(d.body.toString()).complete === true);
  const dt = sign("stahnout", { backup: cb?.id, file: "db.sql.gz" });
  await download(dt);
  check("stejný token ke stažení podruhé 401", (await download(dt)).status === 401);
  check("token se scope stav 403", (await download(sign("stahnout", { backup: cb?.id, file: "db.sql.gz" }, { scope: "stav" }))).status === 403);
  check("token pro jinou akci (seznam) 403", (await download(sign("zalohy", { backup: cb?.id, file: "db.sql.gz" }))).status === 403);
  check("token na stažení neotevře zálohu ani obnovu (403)", (await call("zaloha", sign("stahnout", { uploads: true }))).status === 403 && (await call("obnova", sign("stahnout", { backup: cb?.id, db: true }, { confirm: `obnovit:${cb?.id}` }))).status === 403);
  check("přihlašovací token ke stažení 401", (await download(sign("stahnout", { backup: cb?.id, file: "db.sql.gz" }, {}, { typ: "klicenka+jwt" }))).status === 401);
  check("neexistující část 404", (await download(sign("stahnout", { backup: cb?.id, file: "soubory-999.zip" }))).status === 404);
  check("cesta mimo zálohu 400", (await download(sign("stahnout", { backup: cb?.id, file: "../stav.json" }))).status === 400 && (await download(sign("stahnout", { backup: "../x", file: "db.sql.gz" }))).status === 400);
  check("stav.json ani job.json stáhnout nejde (400)", (await download(sign("stahnout", { backup: cb?.id, file: "stav.json" }))).status === 400 && (await download(sign("stahnout", { backup: cb?.id, file: "job.json" }))).status === 400);

  console.log("Druhá záloha s médii, uvolnění místa, obnova z víc částí");
  const D = await chunked({ ...req, budget: 5 });
  check("druhá záloha po krocích hotová", !!D.backup && D.backup.id !== cb?.id, D.last?.json ?? D.last?.text);
  r = await run("uvolnit", { backup: D.backup?.id });
  check("uvolnit nejnovější: označí, nic nesmaže", r.status === 200 && r.json?.deleted?.length === 0 && r.json?.newest === D.backup?.id && fs.existsSync(path.join(root, D.backup?.id ?? "x")), r.json ?? r.text);
  r = await run("uvolnit", { backup: cb?.id });
  check("uvolnit starší zálohu s médii: smaže ji, nejnovější zůstane", r.status === 200 && r.json?.deleted?.includes(cb?.id) && !fs.existsSync(cdir) && fs.existsSync(path.join(root, D.backup?.id ?? "x")), r.json ?? r.text);
  check("uvolnit neexistující 404", (await run("uvolnit", { backup: cb?.id })).status === 404);
  r = await run("zalohy");
  check("seznam: nejnovější označená offsite, bez rozpracované", r.json?.backups?.[0]?.id === D.backup?.id && !!r.json?.backups?.[0]?.offsite && r.json?.job === null, r.json?.backups?.map((b) => [b.id, b.offsite]));
  fs.rmSync(path.join(uploads, "2024/03/velka-3.jpg"));
  fs.writeFileSync(path.join(uploads, "2025/06/text 7 á.txt"), "přepsáno");
  fs.writeFileSync(path.join(uploads, "nove-po-zaloze.txt"), "x");
  const Did = D.backup?.id;
  r = await call("obnova", sign("obnova", { backup: Did, db: true, files: true }, { confirm: `obnovit:${Did}` }));
  check("obnova ze zálohy po krocích (víc částí) 200", r.status === 200 && r.json?.ok && r.json?.files === "ok" && r.json?.db === "ok", r.json ?? r.text);
  check("média po obnově zpět (smazaný i přepsaný soubor)", fs.existsSync(path.join(uploads, "2024/03/velka-3.jpg")) && hashOf(fs.readFileSync(path.join(uploads, "2024/03/velka-3.jpg"))) === hashOf(media["2024/03/velka-3.jpg"]) && fs.readFileSync(path.join(uploads, "2025/06/text 7 á.txt")).equals(media["2025/06/text 7 á.txt"]));
  check("soubor přidaný po záloze po obnově není", !fs.existsSync(path.join(uploads, "nove-po-zaloze.txt")));
  check("po obnově všech médií stejně", Object.entries(media).every(([rel, buf]) => fs.existsSync(path.join(uploads, rel)) && fs.statSync(path.join(uploads, rel)).size === buf.length));
  check("web na konci běží", await homeOk());
} catch (e) {
  fail++; console.log(`\n✘ ${e.stack ?? e.message}`);
} finally {
  console.log(`\n${ok} ok, ${fail} chyb`);
  stop();
  process.exit(fail ? 1 : 0);
}
