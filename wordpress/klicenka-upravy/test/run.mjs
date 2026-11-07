#!/usr/bin/env node
// Test klicenka-upravy na WP Playground (Elementor z wordpress.org + Gutenberg).
// Použití:  [PHP_VERSION=7.4] node wordpress/klicenka-upravy/test/run.mjs [--no-elementor] [--keep]
// ELEMENTOR_PRO_DIR=<složka plugins/elementor-pro> přidá testy podmínek zobrazení se skutečným Elementorem Pro (a motivem Hello).
// Spustí lokální JWKS (testovací klíč Ed25519, jen v paměti) a Playground na :3105, po testu vše zastaví a smaže.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, "..");
const klicenkaPhp = path.resolve(pluginDir, "../klicenka/klicenka.php");
const WP_PORT = Number(process.env.WP_PORT || 3105);
const JWKS_PORT = Number(process.env.JWKS_PORT || 3399);
const ISSUER = `http://127.0.0.1:${JWKS_PORT}`;
const AUD = "example-wordpress@local";
const WP = `http://127.0.0.1:${WP_PORT}`;
const withElementor = !process.argv.includes("--no-elementor");
const keep = process.argv.includes("--keep");

// ---------- klíče a JWKS ----------
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const otherKey = crypto.generateKeyPairSync("ed25519").privateKey;
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test1", alg: "EdDSA", use: "sig" };
const jwks = http.createServer((req, res) => {
  if (req.url === "/.well-known/jwks.json") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ keys: [jwk] }));
  } else {
    res.writeHead(404).end();
  }
});
await new Promise((r) => jwks.listen(JWKS_PORT, "127.0.0.1", r));

const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
function sign(claims = {}, { typ = "klicenka-upravy+jwt", key = privateKey, kid = "test1", ttl } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const scope = claims.scope ?? "drafts";
  const iat = claims.iat ?? now;
  const payload = {
    iss: ISSUER, aud: AUD, sub: "claude-upravy", jti: crypto.randomUUID(), iat,
    exp: iat + (ttl ?? (scope === "publish" ? 60 : 900)),
    act: { sub: "u-ondrej", name: "Ondřej (test)", email: "ondrej@example.test" },
    scope, ...claims,
  };
  for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
  const h = b64({ alg: "EdDSA", typ, kid });
  const p = b64(payload);
  const sig = crypto.sign(null, Buffer.from(`${h}.${p}`), key).toString("base64url");
  return `${h}.${p}.${sig}`;
}

// ---------- Playground ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "klicenka-upravy-test-"));
const mu = path.join(tmp, "mu-plugins");
fs.mkdirSync(mu);
fs.copyFileSync(klicenkaPhp, path.join(mu, "klicenka.php"));
fs.copyFileSync(path.join(pluginDir, "klicenka-upravy.php"), path.join(mu, "klicenka-upravy.php"));
fs.copyFileSync(path.join(here, "test-helper.php"), path.join(mu, "zz-test-helper.php"));
const steps = [
  { step: "defineWpConfigConsts", consts: { KLICENKA_AUDIENCE: "example-wordpress", KLICENKA_ENVIRONMENT: "local", KLICENKA_ISSUER: ISSUER, KLICENKA_UPRAVY_MAX_UPLOAD: 300000, KLICENKA_UPRAVY_MAX_PDF: 600000, ...(process.env.NO_LANGS ? { KUT_NO_LANGS: true } : {}) } },
  { step: "setSiteOptions", options: { permalink_structure: "/%postname%/", ...(process.env.NO_LANGS ? { WPLANG: "cs_CZ" } : {}) } },
];
if (withElementor) steps.push({ step: "installPlugin", pluginData: { resource: "wordpress.org/plugins", slug: "elementor" }, options: { activate: true } });
const proDir = process.env.ELEMENTOR_PRO_DIR;
const withPro = !!proDir && withElementor;
if (withPro) {
  steps.push({ step: "activatePlugin", pluginPath: "elementor-pro/elementor-pro.php" });
  steps.push({ step: "installTheme", themeData: { resource: "wordpress.org/themes", slug: "hello-elementor" }, options: { activate: true } });
}
const noLangs = !!process.env.NO_LANGS;
const withPolylang = !!process.env.WITH_POLYLANG || noLangs;
if (withPolylang) steps.push({ step: "installPlugin", pluginData: { resource: "wordpress.org/plugins", slug: "polylang" }, options: { activate: true } });
fs.writeFileSync(path.join(tmp, "blueprint.json"), JSON.stringify({ steps, features: { networking: true } }, null, 2));

const wpLog = fs.openSync(path.join(tmp, "playground.log"), "a");
const child = spawn("npx", ["-y", "@wp-playground/cli@3.1.60", "server", `--port=${WP_PORT}`, `--mount=${mu}:/wordpress/wp-content/mu-plugins`, ...(withPro ? [`--mount=${proDir}:/wordpress/wp-content/plugins/elementor-pro`] : []), `--blueprint=${path.join(tmp, "blueprint.json")}`, "--workers=1", `--php=${process.env.PHP_VERSION || "8.3"}`], {
  stdio: ["ignore", wpLog, wpLog], detached: true,
});
let stopped = false;
function stop() {
  if (stopped) return;
  stopped = true;
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  jwks.close();
  if (!keep) fs.rmSync(tmp, { recursive: true, force: true });
}
process.on("SIGINT", () => { stop(); process.exit(130); });

// ---------- HTTP ----------
const api = (p) => `${WP}/?rest_route=/klicenka-upravy/v1${p}`;
async function call(method, p, { token, header = "authorization", body, form, raw } = {}) {
  const headers = {};
  if (token) headers[header] = header === "authorization" ? `Bearer ${token}` : token;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(raw ? p : api(p), { method, headers, body: payload, redirect: "manual" });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}
const helper = async (p, method = "GET") => (await fetch(`${WP}/?rest_route=/kut/v1${p}`, { method })).json();

// ---------- assert ----------
let ok = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { ok++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  ✘ ${name}${detail !== undefined ? `  → ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 400)}` : ""}`); }
}

try {
  process.stdout.write(`Playground ${withElementor ? "+ Elementor " : ""}startuje (log: ${tmp}/playground.log)…`);
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > 600_000) throw new Error("Playground nenaběhl do 10 min");
    // Server odpovídá už během blueprintu, proto se čeká i na aktivní Elementor.
    try { const r = await fetch(api("/status")); if (r.status === 200 && (!withElementor || (await r.json()).elementor === true)) break; } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(` hotovo za ${Math.round((Date.now() - t0) / 1000)} s`);
  await fetch(`${WP}/`); // init → testovací stránky
  const st0 = await helper("/state");
  const ids = st0.pages;
  const EL = ids["Test Elementor"], GB = ids["Test Gutenberg"], CIZI = ids["Cizí stránka"];
  console.log(`  stránky: Elementor=${EL} Gutenberg=${GB} Cizí=${CIZI}, Elementor ${st0.elementor ?? "nenainstalován"}`);

  console.log("\nStav a tokeny");
  const s = await call("GET", "/status");
  check("status bez tokenu: verze a klicenka", s.json?.name === "klicenka-upravy" && s.json?.klicenka === fs.readFileSync(klicenkaPhp, "utf8").match(/Version:\s*([\d.]+)/)[1], s.json);
  if (withElementor) check("Elementor běží", s.json?.elementor === true, s.json);
  check("bez tokenu 401", (await call("GET", "/pages")).status === 401);
  check("přihlašovací token Klíčenky (typ klicenka+jwt) 401", (await call("GET", "/pages", { token: sign({}, { typ: "klicenka+jwt", ttl: 60 }) })).status === 401);
  check("cizí klíč 401", (await call("GET", "/pages", { token: sign({}, { key: otherKey }) })).status === 401);
  check("jiný adresát 401", (await call("GET", "/pages", { token: sign({ aud: "jiny-web@local" }) })).status === 401);
  check("vypršelý 401", (await call("GET", "/pages", { token: sign({ iat: Math.floor(Date.now() / 1000) - 1000 }) })).status === 401);
  check("drafts s platností 16 min 401", (await call("GET", "/pages", { token: sign({}, { ttl: 960 }) })).status === 401);
  check("publish s platností 5 min 401", (await call("POST", `/drafts/1/publish`, { token: sign({ scope: "publish", req: "r1", post: EL }, { ttl: 300 }) })).status === 401);
  check("token v URL se nečte", (await call("GET", `${WP}/?rest_route=/klicenka-upravy/v1/pages&token=${sign()}`, { raw: true })).status === 401);
  const tokPages = sign({ req: "r1" });
  const pages = await call("GET", "/pages", { token: tokPages });
  check("GET pages (Bearer) 200, drafts 15 min", pages.status === 200 && pages.json.pages.some((p) => p.id === EL), pages.json);
  check("stejný drafts token jde použít znovu", (await call("GET", "/pages", { token: tokPages })).status === 200);
  const pagesX = await call("GET", "/pages", { token: sign({ req: "r1" }), header: "x-klicenka-token" });
  check("GET pages přes X-Klicenka-Token 200", pagesX.status === 200, pagesX.status);
  if (withElementor) check("editor elementor rozpoznán", pages.json.pages.find((p) => p.id === EL)?.editor === "elementor", pages.json.pages);
  check("Gutenberg rozpoznán", pages.json.pages.find((p) => p.id === GB)?.editor === "gutenberg");

  const st1 = await helper("/state");
  const forbidden = ["publish_pages", "publish_posts", "edit_others_pages", "edit_published_pages", "manage_options", "install_plugins", "edit_users", "edit_theme_options", "unfiltered_html", "delete_others_pages"];
  check("uživatel claude-upravy založen s rolí claude_upravy", st1.user?.roles?.length === 1 && st1.user.roles[0] === "claude_upravy", st1.user);
  check("role nemá zakázaná oprávnění", forbidden.every((c) => !st1.user.allcaps.includes(c)), st1.user.allcaps);
  check("heslem se účet nepřihlásí", st1.password_login === "klicenka_upravy", st1.password_login);

  // ---------- Elementor ----------
  console.log("\nElementor");
  const T = (claims = {}) => sign({ req: "r1", post: EL, ...claims });
  check("duplicate s tokenem pro jinou stránku 403", (await call("POST", `/pages/${CIZI}/duplicate`, { token: T() })).status === 403);
  const dup = await call("POST", `/pages/${EL}/duplicate`, { token: T() });
  check("duplicate 200", dup.status === 200 && dup.json.created === true, dup.json);
  const D = dup.json.id;
  const dupAgain = await call("POST", `/pages/${EL}/duplicate`, { token: T() });
  check("opakovaný duplicate vrátí stejný koncept", dupAgain.json?.id === D && dupAgain.json.created === false, dupAgain.json);
  const insO = await helper(`/inspect&post=${EL}`);
  const insD = await helper(`/inspect&post=${D}`);
  check("koncept: status draft, autor claude-upravy, název [Úprava #r1]", insD.post.status === "draft" && insD.author === "claude-upravy" && insD.post.title === "[Úprava #r1] Test Elementor", insD.post);
  for (const k of ["_elementor_data", "_elementor_page_settings", "_elementor_edit_mode", "_wp_page_template", "vlastni_meta"]) {
    check(`meta ${k} zkopírováno beze změny`, insD.meta[k] === insO.meta[k], { d: insD.meta[k]?.slice(0, 80), o: insO.meta[k]?.slice(0, 80) });
  }
  check("draft na originálu jako koncept nejde (outline originálu 404)", (await call("GET", `/drafts/${EL}/outline`, { token: T() })).status === 404);
  check("koncept s tokenem jiného req 404", (await call("GET", `/drafts/${D}/outline`, { token: T({ req: "r2" }) })).status === 404);
  check("koncept s tokenem jiné stránky 404", (await call("GET", `/drafts/${D}/outline`, { token: T({ post: CIZI }) })).status === 404);
  const out = await call("GET", `/drafts/${D}/outline`, { token: T() });
  const flat = [];
  const walk = (n) => n.forEach((x) => { flat.push(x); walk(x.children || []); });
  walk(out.json?.outline || []);
  const byId = Object.fromEntries(flat.map((x) => [x.id, x]));
  check("outline: strom s id a typy", byId.head1?.type === "heading" && byId.sec1?.elType === "section", out.json);
  check("outline: texty", byId.head1?.texts?.title === "Původní nadpis stránky" && byId.text1?.texts?.editor?.startsWith("Původní odstavec"), byId.text1);
  check("outline: bez barev a velikostí", !byId.head1?.texts?.title_color && !byId.head1?.texts?.header_size, byId.head1);
  check("outline: odkaz tlačítka", byId.btn1?.links?.link === "https://example.test/kontakt", byId.btn1);
  check("outline: obrázek", byId.img1?.images?.image?.url === "https://example.test/foto.jpg", byId.img1);
  check("outline: položky opakovače", byId.list1?.texts?.["icon_list.1.text"] === "Druhá položka seznamu", byId.list1);
  check("outline je menší než _elementor_data", JSON.stringify(out.json).length < insD.meta._elementor_data.length * 1.5);
  const full = await call("GET", `/drafts/${D}/outline&ids=btn1`, { token: T() });
  check("outline?ids= vrátí plné nastavení", full.json?.elements?.[0]?.settings?.link?.is_external === "", full.json);

  const bad = await call("PATCH", `/drafts/${D}/elements`, { token: T(), body: [{ id: "head1", settings: { title: "X" } }, { id: "neni", settings: { title: "Y" } }] });
  check("PATCH s neexistujícím prvkem 422", bad.status === 422 && bad.json?.message?.includes("neni"), bad.json);
  check("…a nic se nezměnilo", (await helper(`/inspect&post=${D}`)).meta._elementor_data === insD.meta._elementor_data);
  check("PATCH se zlým klíčem 400", (await call("PATCH", `/drafts/${D}/elements`, { token: T(), body: [{ id: "head1", settings: { "a b": 1 } }] })).status === 400);
  const patch = await call("PATCH", `/drafts/${D}/elements`, { token: T(), body: [
    { id: "head1", settings: { title: "Nový nadpis <script>alert(1)</script>od Clauda" } },
    { id: "btn1", settings: { link: { url: "javascript:alert(1)" }, text: "Napište nám" } },
    { id: "list1", settings: { icon_list: { 1: { text: "Změněná druhá položka" } } } },
  ] });
  check("PATCH 200", patch.status === 200, patch.json);
  const out2 = await call("GET", `/drafts/${D}/outline&ids=head1,btn1,list1,text1`, { token: T() });
  const e2 = Object.fromEntries((out2.json?.elements || []).map((e) => [e.id, e.settings]));
  check("nadpis změněn, <script> odstraněn", e2.head1?.title?.includes("Nový nadpis") && !e2.head1.title.includes("<script"), e2.head1);
  check("ostatní nastavení prvku zůstala", e2.head1?.title_color === "#111111" && e2.head1?.header_size === "h1", e2.head1);
  check("javascript: odkaz zahozen, is_external zůstal", e2.btn1?.link?.url === "" && e2.btn1?.link?.is_external === "" && e2.btn1?.text === "Napište nám", e2.btn1);
  check("opakovač: změna jedné položky, první a _id zůstaly", e2.list1?.icon_list?.[1]?.text === "Změněná druhá položka" && e2.list1.icon_list[1]._id === "a2" && e2.list1.icon_list[0].text === "První položka seznamu", e2.list1);
  check("zpětné lomítko a uvozovky v nezměněném prvku přežily", e2.text1?.editor === '<p>Původní odstavec s cestou C:\\data a "uvozovkami".</p>', e2.text1);
  check("PATCH přes POST + X-HTTP-Method-Override", (await fetch(api(`/drafts/${D}/elements`), { method: "POST", headers: { authorization: `Bearer ${T()}`, "x-http-method-override": "PATCH", "content-type": "application/json" }, body: JSON.stringify([{ id: "head1", settings: { title: "Nový nadpis od Clauda" } }]) })).status === 200);
  check("originál zatím beze změny", (await helper(`/inspect&post=${EL}`)).meta._elementor_data === insO.meta._elementor_data);

  // média
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const fd = (buf, name, type) => { const f = new FormData(); f.append("file", new Blob([buf], { type }), name); f.append("alt", "Testovací obrázek"); return f; };
  const up = await call("POST", `/drafts/${D}/media`, { token: T(), form: fd(png, "foto.png", "image/png") });
  check("upload PNG 200", up.status === 200 && up.json?.id > 0 && up.json.mime === "image/png", up.json);
  check("upload textu jako .png 415", (await call("POST", `/drafts/${D}/media`, { token: T(), form: fd(Buffer.from("<?php echo 1;"), "x.png", "image/png") })).status === 415);
  check("upload SVG 415", (await call("POST", `/drafts/${D}/media`, { token: T(), form: fd(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), "x.svg", "image/svg+xml") })).status === 415);
  check("upload nad limit 413", (await call("POST", `/drafts/${D}/media`, { token: T(), form: fd(Buffer.concat([png, Buffer.alloc(310000)]), "big.png", "image/png") })).status === 413);
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
  const upPdf = await call("POST", `/drafts/${D}/media`, { token: T(), form: fd(pdf, "cenik-2026.pdf", "application/pdf") });
  check("upload PDF 200", upPdf.status === 200 && upPdf.json?.id > 0 && upPdf.json.mime === "application/pdf" && /\.pdf$/.test(upPdf.json.url), upPdf.json);
  check("PDF nad obrázkový limit, pod PDF limitem 200", (await call("POST", `/drafts/${D}/media`, { token: T(), form: fd(Buffer.concat([pdf, Buffer.alloc(400000)]), "velky.pdf", "application/pdf") })).status === 200);
  check("PDF nad limit 413", (await call("POST", `/drafts/${D}/media`, { token: T(), form: fd(Buffer.concat([pdf, Buffer.alloc(700000)]), "obri.pdf", "application/pdf") })).status === 413);
  check("PHP jako .pdf 415", (await call("POST", `/drafts/${D}/media`, { token: T(), form: fd(Buffer.from("<?php echo 1;"), "x.pdf", "application/pdf") })).status === 415);
  check("PDF přejmenované na .png 415", (await call("POST", `/drafts/${D}/media`, { token: T(), form: fd(pdf, "x.png", "image/png") })).status === 415);
  check("upload ke konceptu jiného req 404", (await call("POST", `/drafts/${D}/media`, { token: T({ req: "r2" }), form: fd(png, "foto.png", "image/png") })).status === 404);
  await call("PATCH", `/drafts/${D}/elements`, { token: T(), body: [{ id: "img1", settings: { image: { id: up.json.id, url: up.json.url } } }] });

  // náhled
  const pv = await call("GET", `/drafts/${D}/preview-link`, { token: T() });
  check("preview-link 200, platnost ~23 h", pv.status === 200 && Math.abs(new Date(pv.json.expires) - Date.now() - 23 * 3600e3) < 120e3, pv.json);
  const pvUrl = pv.json.url.replace(/^https?:\/\/[^/]+/, WP);
  const pvRes = await fetch(pvUrl, { redirect: "manual" });
  const pvHtml = await pvRes.text();
  check("náhled konceptu ukazuje změnu", pvRes.status === 200 && (!withElementor || pvHtml.includes("Nový nadpis od Clauda")), `${pvRes.status} ${pvHtml.slice(0, 200)}`);
  if (withElementor) check("náhled renderuje Elementor", pvHtml.includes("elementor-widget-heading"), pvHtml.slice(0, 300));
  check("náhled má noindex a no-referrer", /noindex/.test(pvHtml) && pvRes.headers.get("referrer-policy") === "no-referrer", pvRes.headers.get("referrer-policy"));
  const tampered = pvUrl.replace(/.$/, (c) => (c === "a" ? "b" : "a"));
  const tRes = await fetch(tampered, { redirect: "manual" });
  check("podvržený podpis náhledu koncept neukáže", !(await tRes.text()).includes("Nový nadpis od Clauda"), tRes.status);
  const noSig = await fetch(`${WP}/?page_id=${D}`, { redirect: "manual" });
  check("koncept bez podpisu není veřejný", !(await noSig.text()).includes("Nový nadpis od Clauda"), noSig.status);

  // publikace
  check("drafts token na publish odmítnut", [401, 403].includes((await call("POST", `/drafts/${D}/publish`, { token: T() })).status));
  check("publish s tokenem scope drafts (60 s) 403", (await call("POST", `/drafts/${D}/publish`, { token: sign({ req: "r1", post: EL }, { ttl: 60 }) })).status === 403);
  check("publish token jiného req 404", (await call("POST", `/drafts/${D}/publish`, { token: T({ scope: "publish", req: "r2" }) })).status === 404);
  const loginTry = await fetch(`${WP}/wp-login.php?action=klicenka`, { method: "POST", body: new URLSearchParams({ token: T({ scope: "publish" }) }), redirect: "manual" });
  check("publish token nepřihlásí přes Klíčenku (wp-login)", loginTry.status !== 302, loginTry.status);
  const revBefore = (await helper(`/inspect&post=${EL}`)).revisions;
  const pubTok = T({ scope: "publish" });
  const pub = await call("POST", `/drafts/${D}/publish`, { token: pubTok });
  check("publish 200", pub.status === 200 && pub.json?.published === EL, pub.json);
  if (withElementor) check("Elementor CSS přegenerováno", pub.json?.elementor_css === true, pub.json);
  check("stejný publish token podruhé 401", (await call("POST", `/drafts/${D}/publish`, { token: pubTok })).status === 401);
  const insO2 = await helper(`/inspect&post=${EL}`);
  const insD2 = await helper(`/inspect&post=${D}`);
  check("originál má _elementor_data z konceptu", insO2.meta._elementor_data === insD2.meta._elementor_data && insO2.meta._elementor_data !== insO.meta._elementor_data, insO2.meta._elementor_data.slice(0, 200));
  check("originál si nechal název, autora a stav", insO2.post.title === "Test Elementor" && insO2.post.status === "publish" && insO2.author === "admin", insO2.post);
  check("koncept je v koši", insD2.post.status === "trash", insD2.post.status);
  check("záloha uložena v meta", JSON.parse(insO2.meta._klicenka_upravy_backups || "[]")[0]?.req === "r1");
  check("WP revize přibyla", insO2.revisions > revBefore, { before: revBefore, after: insO2.revisions });
  check("obrázek přesunut k originálu", insO2.attachments.includes(up.json.id), insO2.attachments);
  if (withElementor) check("_elementor_css originálu znovu vytvořeno", !!insO2.meta._elementor_css, Object.keys(insO2.meta));
  const live = await (await fetch(`${WP}/?page_id=${EL}`)).text();
  if (withElementor) check("živá stránka ukazuje změnu", live.includes("Nový nadpis od Clauda"), live.slice(0, 200));
  check("náhled po publikaci už nefunguje", !(await (await fetch(pvUrl)).text()).includes("[Úprava #r1]"));
  check("outline smazaného konceptu 404", (await call("GET", `/drafts/${D}/outline`, { token: T() })).status === 404);

  // návrat
  check("rollback s drafts tokenem odmítnut", [401, 403].includes((await call("POST", `/pages/${EL}/rollback`, { token: T() })).status));
  check("rollback jiného req 409", (await call("POST", `/pages/${EL}/rollback`, { token: T({ scope: "publish", req: "r9" }) })).status === 409);
  const rb = await call("POST", `/pages/${EL}/rollback`, { token: T({ scope: "publish" }) });
  check("rollback 200", rb.status === 200 && rb.json?.backups_left === 0, rb.json);
  const insO3 = await helper(`/inspect&post=${EL}`);
  check("originál obnoven bajt po bajtu (_elementor_data)", insO3.meta._elementor_data === insO.meta._elementor_data);
  check("obnovené _elementor_page_settings", insO3.meta._elementor_page_settings === insO.meta._elementor_page_settings);
  if (withElementor) check("živá stránka zase původní", (await (await fetch(`${WP}/?page_id=${EL}`)).text()).includes("Původní nadpis stránky"));
  check("druhý rollback 404 (žádná záloha)", (await call("POST", `/pages/${EL}/rollback`, { token: T({ scope: "publish" }) })).status === 404);

  // ---------- Gutenberg ----------
  console.log("\nGutenberg");
  const G = (claims = {}) => sign({ req: "r2", post: GB, ...claims });
  const gd = await call("POST", `/pages/${GB}/duplicate`, { token: G() });
  check("duplicate 200", gd.status === 200, gd.json);
  const GD = gd.json.id;
  const gOrig = await helper(`/inspect&post=${GB}`);
  const gDraft = await helper(`/inspect&post=${GD}`);
  check("obsah zkopírován beze změny (včetně iframe v HTML bloku)", gDraft.post.content === gOrig.post.content && gDraft.post.content.includes("<iframe"), gDraft.post.content.slice(-200));
  const go = await call("GET", `/drafts/${GD}/outline`, { token: G() });
  const gflat = [];
  const gw = (n) => n.forEach((x) => { gflat.push(x); gw(x.children || []); });
  gw(go.json?.outline || []);
  const gb = Object.fromEntries(gflat.map((x) => [x.id, x]));
  check("outline bloků", go.json?.editor === "gutenberg" && gb["0"]?.type === "core/heading" && gb["0"].text === "Původní nadpis bloku", go.json);
  check("outline: odkaz a vnořený blok", gb["2"]?.links?.[0] === "https://example.test/odkaz" && gb["4.0"]?.text === "Vnořený odstavec", gb);
  const gp = await call("PATCH", `/drafts/${GD}/elements`, { token: G(), body: [
    { id: "0", settings: { replace: [{ from: "Původní nadpis bloku", to: "Nový nadpis bloku" }] } },
    { id: "4.0", settings: { html: "<p>Nový vnořený <script>x()</script>text</p>" } },
    { id: "2", settings: { attrs: { className: "zvyrazneny" } } },
  ] });
  check("PATCH bloků 200", gp.status === 200, gp.json);
  check("html celé skupiny nejde nahradit 422", (await call("PATCH", `/drafts/${GD}/elements`, { token: G(), body: [{ id: "4", settings: { html: "<p>x</p>" } }] })).status === 422);
  check("neexistující blok 422", (await call("PATCH", `/drafts/${GD}/elements`, { token: G(), body: [{ id: "9.9", settings: { html: "x" } }] })).status === 422);
  check("replace nenalezeného textu 422", (await call("PATCH", `/drafts/${GD}/elements`, { token: G(), body: [{ id: "0", settings: { replace: [{ from: "neexistuje", to: "x" }] } }] })).status === 422);
  const gDraft2 = await helper(`/inspect&post=${GD}`);
  const c2 = gDraft2.post.content;
  check("koncept: nový nadpis, vnořený text bez scriptu, attrs, iframe zůstal", c2.includes("Nový nadpis bloku") && c2.includes("Nový vnořený") && !c2.includes("<script") && c2.includes('"className":"zvyrazneny"') && c2.includes("<iframe"), c2);
  // souběh: klient mezitím změnil originál
  await helper(`/touch&post=${GB}`, "POST");
  const gTouched = await helper(`/inspect&post=${GB}`);
  const conflict = await call("POST", `/drafts/${GD}/publish`, { token: G({ scope: "publish" }) });
  check("publish po změně originálu 409", conflict.status === 409, conflict.json);
  const gpub = await call("POST", `/drafts/${GD}/publish`, { token: G({ scope: "publish" }), body: { force: true } });
  check("publish s force 200", gpub.status === 200, gpub.json);
  const gOrig2 = await helper(`/inspect&post=${GB}`);
  check("originál má nový obsah", gOrig2.post.content === c2, gOrig2.post.content.slice(0, 200));
  const grb = await call("POST", `/pages/${GB}/rollback`, { token: G({ scope: "publish" }) });
  check("rollback 200 a obsah původní", grb.status === 200 && (await helper(`/inspect&post=${GB}`)).post.content === gTouched.post.content, grb.json);

  // ---------- Šablony Elementoru (patička) a kit ----------
  if (withElementor) {
    console.log("\nŠablony Elementoru");
    const stT = await helper("/state");
    const FOOT = stT.pages["Test Patička"], KIT = stT.kit;
    const lib = await call("GET", "/pages&type=elementor_library", { token: sign({ req: "r5" }) });
    const footInfo = lib.json?.pages?.find((x) => x.id === FOOT);
    check("seznam šablon: patička s typem a podmínkou", footInfo?.template_type === "footer" && footInfo.conditions?.[0] === "include/general", lib.json);
    check("nepovolený typ v seznamu 400", (await call("GET", "/pages&type=attachment", { token: sign({ req: "r5" }) })).status === 400);
    const TF = (c = {}) => sign({ req: "r5", post: FOOT, ...c });
    const fd1 = await call("POST", `/pages/${FOOT}/duplicate`, { token: TF() });
    const FD = fd1.json?.id;
    const fdMeta = (await helper(`/inspect&post=${FD}`)).meta;
    check("koncept patičky bez podmínek zobrazení, s typem", fd1.status === 200 && !("_elementor_conditions" in fdMeta) && fdMeta._elementor_template_type === "footer", fdMeta);
    const fOrig = await helper(`/inspect&post=${FOOT}`);
    const fp = await call("PATCH", `/drafts/${FD}/elements`, { token: TF(), body: [{ id: "ftext", settings: { editor: "<p>Ceník 2026/27</p>" } }, { id: "fbtn", settings: { link: { url: "https://example.test/cenik-2026-27.pdf" } } }] });
    check("úprava konceptu patičky 200", fp.status === 200, fp.json);
    check("originál patičky zatím beze změny", (await helper(`/inspect&post=${FOOT}`)).meta._elementor_data === fOrig.meta._elementor_data);
    const fpub = await call("POST", `/drafts/${FD}/publish`, { token: sign({ scope: "publish", req: "r5", post: FOOT }, { ttl: 60 }) });
    const fAfter = await helper(`/inspect&post=${FOOT}`);
    check("publikace patičky: nový text a odkaz", fpub.status === 200 && fAfter.meta._elementor_data.includes("2026\\/27") && fAfter.meta._elementor_data.includes("cenik-2026-27.pdf"), fAfter.meta._elementor_data);
    check("publikace nesáhla na podmínky zobrazení", fAfter.meta._elementor_conditions === fOrig.meta._elementor_conditions, fAfter.meta._elementor_conditions);
    const frb = await call("POST", `/pages/${FOOT}/rollback`, { token: sign({ scope: "publish", req: "r5", post: FOOT }, { ttl: 60 }) });
    const fBack = await helper(`/inspect&post=${FOOT}`);
    check("návrat patičky: původní obsah, podmínky zůstaly", frb.status === 200 && fBack.meta._elementor_data === fOrig.meta._elementor_data && fBack.meta._elementor_conditions === fOrig.meta._elementor_conditions, frb.json);

    if (KIT) {
      const TK = (c = {}) => sign({ req: "r6", post: KIT, ...c });
      const kd = await call("POST", `/pages/${KIT}/duplicate`, { token: TK() });
      const KD = kd.json?.id;
      check("koncept kitu 200", kd.status === 200 && KD > 0, kd.json);
      const kp = await call("PATCH", `/drafts/${KD}/elements`, { token: TK(), body: [{ id: "@page", settings: { kut_barva: "#ff0000" } }] });
      const ko = await call("GET", `/drafts/${KD}/outline&ids=@page`, { token: TK() });
      check("nastavení kitu (@page) se uloží do konceptu", kp.status === 200 && ko.json?.page_settings?.kut_barva === "#ff0000", ko.json);
      check("originální kit zatím beze změny", !String((await helper(`/inspect&post=${KIT}`)).meta._elementor_page_settings ?? "").includes("kut_barva"));
      const kl = await call("GET", `/drafts/${KD}/preview-link`, { token: TK() });
      const html = await (await fetch(kl.json.url)).text();
      check("náhled kitu: stránka s konceptem kitu a štítkem náhledu", /klicenka_sablona=/.test(kl.json.url) && html.includes(`elementor-kit-${KD}`) && html.includes("Náhled konceptu šablony"), { url: kl.json.url, banner: html.includes("Náhled konceptu šablony"), kits: html.match(/elementor-kit-\d+/g) });
      const plain = await (await fetch(`${WP}/`)).text();
      check("bez podpisu web normálně (původní kit, bez štítku)", plain.includes(`elementor-kit-${KIT}`) && !plain.includes("Náhled konceptu šablony"));
      const forged = await (await fetch(kl.json.url.replace(/klicenka_nahled=(\d+)\.[a-f0-9]{4}/, "klicenka_nahled=$1.0000"))).text();
      check("podvržený podpis náhledu se nepoužije", !forged.includes(`elementor-kit-${KD}`));
      const kpub = await call("POST", `/drafts/${KD}/publish`, { token: sign({ scope: "publish", req: "r6", post: KIT }, { ttl: 60 }) });
      check("publikace kitu: nastavení v originálu", kpub.status === 200 && String((await helper(`/inspect&post=${KIT}`)).meta._elementor_page_settings).includes("kut_barva"), { status: kpub.status, json: kpub.json, patch: kp.status });
      const krb = await call("POST", `/pages/${KIT}/rollback`, { token: sign({ scope: "publish", req: "r6", post: KIT }, { ttl: 60 }) });
      check("návrat kitu: nastavení zpět", krb.status === 200 && !String((await helper(`/inspect&post=${KIT}`)).meta._elementor_page_settings ?? "").includes("kut_barva"), krb.json);
    } else {
      check("Elementor má aktivní kit", false, stT);
    }
  }

  // ---------- Vícejazyčný web (Polylang) ----------
  if (withPolylang && !noLangs) {
    console.log("\nPolylang");
    await fetch(`${WP}/`); // init založí jazyky a překlad
    const stP = await helper("/state");
    const DE = stP.pages["Test Elementor DE"];
    const all = await call("GET", "/pages&type=page", { token: sign({ req: "r7" }) });
    const cs = all.json?.pages?.find((x) => x.id === EL), de = all.json?.pages?.find((x) => x.id === DE);
    check("seznam obsahuje oba jazyky", !!cs && !!de, all.json?.pages?.map((x) => [x.id, x.title, x.lang]));
    check("jazyk a překlady u stránky", cs?.lang === "cs" && cs?.translations?.de === DE && de?.translations?.cs === EL, { cs, de });
  }

  // ---------- Podmínky zobrazení (Elementor Pro) ----------
  if (withElementor && !withPro) {
    console.log("\nPodmínky zobrazení bez Elementoru Pro");
    const FOOT3 = (await helper("/state")).pages["Test Patička"];
    const tok = (c = {}) => sign({ req: "r20", post: FOOT3, ...c });
    const d = await call("POST", `/pages/${FOOT3}/duplicate`, { token: tok() });
    const pc = await call("PATCH", `/drafts/${d.json?.id}/elements`, { token: tok(), body: [{ id: "@conditions", settings: { conditions: ["include/general"] } }] });
    check("@conditions bez Pro 422", pc.status === 422 && pc.json?.code === "no_conditions", pc.json);
    check("status bez funkce podmínek", !(await call("GET", "/status")).json?.features?.includes("template-conditions"));
  }
  if (withPro) {
    console.log("\nPodmínky zobrazení (Elementor Pro)");
    await helper("/regen", "POST");
    const stC = await helper("/state");
    const FOOT3 = stC.pages["Test Patička"], PAGE = stC.pages["Test Elementor"], OTHER = stC.pages["Cizí stránka"];
    const html = async (q) => (await fetch(`${WP}/?${q}`)).text();
    const shows = (h, id) => new RegExp(`data-elementor-id="${id}"[^>]*elementor-location-footer|elementor-${id} elementor-location-footer`).test(h);
    const opt = async () => JSON.stringify((await helper("/regen")).conditions);
    const TN = (post) => sign({ req: "r20", ...(post ? { post } : {}) });
    const PUB = (post) => sign({ scope: "publish", req: "r20", post }, { ttl: 60 });
    check("status hlásí podmínky", (await call("GET", "/status")).json?.features?.includes("template-conditions"));
    check("společná patička se ukazuje", shows(await html(`page_id=${PAGE}`), FOOT3));

    // Nová stránka a její vlastní patička jako kopie společné.
    const np = await call("POST", "/pages/new", { token: TN(), body: { title: "English page", slug: "english-page", from: PAGE } });
    const NP = np.json?.id;
    const nf = await call("POST", "/pages/new", { token: TN(), body: { title: "Patička EN", from: FOOT3 } });
    const NF = nf.json?.id;
    check("kopie šablony bez jazyka 200", nf.status === 200 && NF > 0, nf.json);
    const nfM = (await helper(`/inspect&post=${NF}`)).meta;
    check("kopie má typ, podmínky ne", nfM._elementor_template_type === "footer" && !("_elementor_conditions" in nfM), nfM);
    const kit = stC.kit && (await call("POST", "/pages/new", { token: TN(), body: { title: "x", from: stC.kit } }));
    if (kit) check("kit jako nová šablona 400", kit.status === 400, kit.json);
    const before = await opt();
    const bad = async (conditions) => (await call("PATCH", `/drafts/${NF}/elements`, { token: TN(NF), body: [{ id: "@conditions", settings: { conditions } }] })).status;
    check("nesmyslná podmínka 400", (await bad(["include/../../x"])) === 400);
    check("neznámá podmínka 400", (await bad(["include/neexistuje"])) === 400);
    check("podmínky bez seznamu 400", (await bad("include/general")) === 400);
    check("@conditions u stránky 422", (await call("PATCH", `/drafts/${NP}/elements`, { token: TN(NP), body: [{ id: "@conditions", settings: { conditions: ["include/general"] } }] })).status === 422);
    const noCond = await call("POST", `/drafts/${NF}/publish`, { token: PUB(NF) });
    check("nová šablona bez podmínek se nezveřejní", noCond.status === 422, noCond.json);
    const ok1 = await call("PATCH", `/drafts/${NF}/elements`, { token: TN(NF), body: [{ id: "@conditions", settings: { conditions: [`include/singular/page/${NP}`] } }, { id: "ftext", settings: { editor: "<p>English footer</p>" } }] });
    check("podmínka a text v konceptu 200", ok1.status === 200, ok1.json);
    const out = await call("GET", `/drafts/${NF}/outline`, { token: TN(NF) });
    check("outline ukáže čekající podmínky", out.json?.conditions?.[0] === `include/singular/page/${NP}` && out.json.conditions_changed === true, out.json);
    check("koncept nezměnil podmínky na webu", (await opt()) === before);
    check("živá stránka dál se společnou patičkou", shows(await html(`page_id=${PAGE}`), FOOT3));

    const prev = await call("GET", `/drafts/${NP}/preview-link`, { token: TN(NP) });
    const ph = await (await fetch(prev.json.url)).text();
    check("náhled stránky ukáže její patičku", ph.includes("English footer") && !shows(ph, FOOT3), ph.slice(-1500));
    const prevT = await call("GET", `/drafts/${NF}/preview-link`, { token: TN(NF) });
    check("náhled šablony vede na její stránku", prevT.json?.url?.includes(`page_id=${NP}`), prevT.json);

    // Pop-up jako kopie, otevírá ho odkaz v patičce: bez podmínek, dynamický odkaz musí přežít beze změny.
    const npop = await call("POST", "/pages/new", { token: TN(), body: { title: "Popup EN", from: stC.pages["Test Popup"] } });
    const NPOP = npop.json?.id;
    check("kopie pop-upu 200", npop.status === 200 && NPOP > 0, npop.json);
    await call("PATCH", `/drafts/${NPOP}/elements`, { token: TN(NPOP), body: [{ id: "ptext", settings: { editor: "<p>English popup</p>" } }] });
    const tag = `[elementor-tag id="68842e0" name="popup" settings="%7B%22popup%22%3A%22${NPOP}%22%7D"]`;
    const pd = await call("PATCH", `/drafts/${NF}/elements`, { token: TN(NF), body: [{ id: "fbtn", settings: { __dynamic__: { link: tag } } }] });
    const nfData = (await helper(`/inspect&post=${NF}`)).meta._elementor_data;
    check("dynamický odkaz na pop-up zůstane beze změny", pd.status === 200 && nfData.includes('name=\\"popup\\"') && !nfData.includes("http:\\/\\/[elementor-tag"), nfData.slice(0, 900));
    const evil = await call("PATCH", `/drafts/${NF}/elements`, { token: TN(NF), body: [{ id: "ftext", settings: { __dynamic__: { editor: '[elementor-tag id="a1" name="shortcode" settings="x"]' } } }] });
    check("dynamický tag shortcode 400", evil.status === 400, evil.json);
    const ph2 = await (await fetch(prev.json.url + `&x=${Date.now()}`)).text();
    check("náhled vytiskne koncept pop-upu", ph2.includes("English popup") && ph2.includes(`data-elementor-id="${NPOP}"`), ph2.slice(-800));

    const pub1 = await call("POST", `/drafts/${NP}/publish`, { token: PUB(NP) });
    const pub2 = await call("POST", `/drafts/${NF}/publish`, { token: PUB(NF) });
    check("zveřejnění stránky i šablony 200", pub1.status === 200 && pub2.status === 200, [pub1.json, pub2.json]);
    const pub4 = await call("POST", `/drafts/${NPOP}/publish`, { token: PUB(NPOP) });
    check("pop-up bez podmínek se zveřejní", pub4.status === 200, pub4.json);
    const live = await html(`page_id=${NP}`);
    check("živá stránka vytiskne pop-up z odkazu", live.includes("English popup"), live.slice(-800));
    check("nová stránka má vlastní patičku", live.includes("English footer") && !shows(live, FOOT3), live.slice(-1500));
    check("ostatní stránky mají společnou", shows(await html(`page_id=${PAGE}`), FOOT3) && !(await html(`page_id=${OTHER}`)).includes("English footer"));
    // Koncept existující stránky je jiné id: šablona s podmínkou na originál se v jeho náhledu ukázat musí.
    const dupNP = await call("POST", `/pages/${NP}/duplicate`, { token: TN(NP) });
    const DNP = dupNP.json?.draftId ?? dupNP.json?.id ?? dupNP.json?.draft?.id;
    const pvNP = await call("GET", `/drafts/${DNP}/preview-link`, { token: TN(NP) });
    const hNP = await (await fetch(pvNP.json.url)).text();
    check("náhled konceptu ukáže šablonu s podmínkou na originál", hNP.includes("English footer") && !shows(hNP, FOOT3), hNP.slice(-1500));
    const dupP = await call("POST", `/pages/${PAGE}/duplicate`, { token: TN(PAGE) });
    const DP = dupP.json?.draftId ?? dupP.json?.id ?? dupP.json?.draft?.id;
    const pvP = await call("GET", `/drafts/${DP}/preview-link`, { token: TN(PAGE) });
    check("koncept stránky bez vlastní šablony má společnou", shows(await (await fetch(pvP.json.url)).text(), FOOT3));
    await call("POST", `/drafts/${DNP}/discard`, { token: PUB(NP) });
    await call("POST", `/drafts/${DP}/discard`, { token: PUB(PAGE) });
    // Kopie kopie míří na stránku se společnou patičkou: náhled ji musí ukázat, i když na té stránce není její základ.
    const t2 = await call("POST", "/pages/new", { token: TN(), body: { title: "Patička 2", from: NF } });
    const NF2 = t2.json?.id;
    const pop2 = (await call("POST", "/pages/new", { token: TN(), body: { title: "Popup 2", from: NPOP } })).json?.id;
    await call("PATCH", `/drafts/${pop2}/elements`, { token: TN(pop2), body: [{ id: "ptext", settings: { editor: "<p>Second popup</p>" } }] });
    await call("PATCH", `/drafts/${NF2}/elements`, { token: TN(NF2), body: [{ id: "@conditions", settings: { conditions: [`include/singular/page/${PAGE}`] } }, { id: "ftext", settings: { editor: "<p>Second footer</p>" } }, { id: "fbtn", settings: { __dynamic__: { link: `[elementor-tag id="68842e0" name="popup" settings="%7B%22popup%22%3A%22${pop2}%22%7D"]` } } }] });
    const pv2 = await call("GET", `/drafts/${NF2}/preview-link`, { token: TN(NF2) });
    const h2 = await (await fetch(pv2.json.url)).text();
    check("náhled kopie kopie ukáže koncept i jeho pop-up", h2.includes("Second footer") && h2.includes("Second popup") && !shows(h2, FOOT3), pv2.json?.url);
    for (const id of [NF2, pop2]) await call("POST", `/drafts/${id}/discard`, { token: PUB(id) });
    const rb = await call("POST", `/pages/${NF}/rollback`, { token: PUB(NF) });
    check("návrat šablony: podmínky pryč, koncept je drží", rb.status === 200 && (await opt()) === before && (await helper(`/inspect&post=${NF}`)).post.status === "draft", [rb.json, await opt()]);
    check("po návratu zas společná patička", shows(await html(`page_id=${NP}`), FOOT3));
    check("znovu zveřejněná šablona se vrátí", (await call("POST", `/drafts/${NF}/publish`, { token: PUB(NF) })).status === 200 && (await html(`page_id=${NP}`)).includes("English footer"));
    await call("POST", `/pages/${NF}/rollback`, { token: PUB(NF) });

    // Změna podmínek existující šablony: záloha a návrat.
    const orig = (await helper(`/inspect&post=${FOOT3}`)).meta._elementor_conditions;
    const T3 = (c = {}) => sign({ req: "r21", post: FOOT3, ...c });
    const P3 = () => sign({ scope: "publish", req: "r21", post: FOOT3 }, { ttl: 60 });
    const d3 = await call("POST", `/pages/${FOOT3}/duplicate`, { token: T3() });
    const D3 = d3.json?.id;
    check("outline kopie ukáže podmínky originálu", (await call("GET", `/drafts/${D3}/outline`, { token: T3() })).json?.conditions?.[0] === "include/general");
    await call("PATCH", `/drafts/${D3}/elements`, { token: T3(), body: [{ id: "@conditions", settings: { conditions: ["include/general", `exclude/singular/page/${OTHER}`] } }] });
    const pub3 = await call("POST", `/drafts/${D3}/publish`, { token: P3() });
    check("výjimka platí po zveřejnění", pub3.status === 200 && !shows(await html(`page_id=${OTHER}`), FOOT3) && shows(await html(`page_id=${PAGE}`), FOOT3), pub3.json);
    const rb3 = await call("POST", `/pages/${FOOT3}/rollback`, { token: P3() });
    check("návrat vrátí původní podmínky", rb3.status === 200 && (await helper(`/inspect&post=${FOOT3}`)).meta._elementor_conditions === orig && shows(await html(`page_id=${OTHER}`), FOOT3), rb3.json);
  }

  // ---------- Nová stránka ----------
  console.log("\nNová stránka");
  {
    const TN = (post) => sign({ req: "r9", ...(post ? { post } : {}) });
    const PUB = (post, req = "r9") => sign({ scope: "publish", req, post }, { ttl: 60 });
    const newPage = (body, tok = TN()) => call("POST", "/pages/new", { token: tok, body });
    check("bez tokenu 401", (await call("POST", "/pages/new", { body: { title: "x" } })).status === 401);
    check("bez názvu 400", (await newPage({})).status === 400);
    check("neexistující základ 404", (await newPage({ title: "x", from: 99999 })).status === 404);
    if (!withPolylang) check("jazyk bez Polylangu 422", (await newPage({ title: "x", lang: "en" })).status === 422);
    const before = await helper(`/inspect&post=${CIZI}`);
    const n1 = await newPage({ title: "Nová kopie", slug: "nova-kopie", from: CIZI });
    const N = n1.json?.id;
    check("koncept z kopie 200", n1.status === 200 && n1.json.created === true && N > 0, n1.json);
    check("opakované založení vrátí stejný koncept", (await newPage({ title: "Nová kopie", slug: "nova-kopie", from: CIZI })).json?.id === N);
    const nIns = await helper(`/inspect&post=${N}`);
    check("koncept je kopie, autor claude-upravy, základ beze změny", nIns.post.status === "draft" && nIns.post.content === "<p>Nesahat</p>" && nIns.author === "claude-upravy" && (await helper(`/inspect&post=${CIZI}`)).post.modified === before.post.modified, nIns.post);
    check("koncept s tokenem jiné stránky 404", (await call("GET", `/drafts/${N}/outline`, { token: TN(CIZI) })).status === 404);
    const pp = await call("PATCH", `/drafts/${N}/elements`, { token: TN(N), body: [{ id: "@post", settings: { title: "New copy", slug: "new-copy", content: "<p>Translated</p><script>alert(1)</script>" } }] });
    const nOut = await call("GET", `/drafts/${N}/outline`, { token: TN(N) });
    check("@post změní název, adresu a obsah, skript ne", pp.status === 200 && nOut.json?.new_page?.title === "New copy" && nOut.json.new_page.slug === "new-copy" && nOut.json.new_page.content.includes("Translated") && !nOut.json.new_page.content.includes("script"), nOut.json);
    check("@post u kopie existující stránky 422", (await call("POST", `/pages/${CIZI}/duplicate`, { token: TN(CIZI) }).then((d) => call("PATCH", `/drafts/${d.json.id}/elements`, { token: TN(CIZI), body: [{ id: "@post", settings: { title: "x" } }] }))).status === 422);
    const nl = await call("GET", `/drafts/${N}/preview-link`, { token: TN(N) });
    check("náhled nového konceptu", (await (await fetch(nl.json.url)).text()).includes("Translated"), nl.json);
    check("před zveřejněním web stránku nemá", (await fetch(`${WP}/?page_id=${N}`)).status === 404);
    check("drafts token nezveřejní", [401, 403].includes((await call("POST", `/drafts/${N}/publish`, { token: TN(N) })).status) && (await helper(`/inspect&post=${N}`)).post.status === "draft");
    const np = await call("POST", `/drafts/${N}/publish`, { token: PUB(N) });
    const nP = await helper(`/inspect&post=${N}`);
    check("zveřejnění: nová stránka, autor není claude-upravy", np.status === 200 && np.json.new === true && np.json.published === N && nP.post.status === "publish" && nP.author !== "claude-upravy", { np: np.json, a: nP.author });
    check("web stránku ukazuje", (await (await fetch(`${WP}/?page_id=${N}`, { redirect: "follow" })).text()).includes("Translated"));
    check("základ se nezměnil", (await helper(`/inspect&post=${CIZI}`)).post.content === "<p>Nesahat</p>" && (await helper(`/inspect&post=${CIZI}`)).post.modified === before.post.modified);
    check("návrat cizím požadavkem nestáhne", (await call("POST", `/pages/${N}/rollback`, { token: PUB(N, "jiny") })).status !== 200 && (await helper(`/inspect&post=${N}`)).post.status === "publish");
    const nr = await call("POST", `/pages/${N}/rollback`, { token: PUB(N) });
    const nR = await helper(`/inspect&post=${N}`);
    check("návrat: zpět koncept, nic smazáno", nr.status === 200 && nr.json.new === true && nR.post.status === "draft" && nR.post.content.includes("Translated") && nR.author === "claude-upravy", nr.json);
    check("po návratu jde koncept upravit i založit znovu", (await call("GET", `/drafts/${N}/outline`, { token: TN(N) })).status === 200 && (await newPage({ title: "Nová kopie", slug: "nova-kopie", from: CIZI })).json?.id === N);
    const nd = await call("POST", `/drafts/${N}/discard`, { token: PUB(N) });
    check("zahození nového konceptu", nd.status === 200 && (await helper(`/inspect&post=${N}`)).post.status === "trash", nd.json);
    const blank = await newPage({ title: "Prázdná" });
    const B = blank.json?.id;
    check("prázdná stránka bez základu", blank.status === 200 && (await helper(`/inspect&post=${B}`)).post.content === "");
    await call("POST", `/drafts/${B}/discard`, { token: PUB(B) });

    // Odkazy v náhledu mezi stránkami téže úpravy.
    {
      const TL = (post) => sign({ req: "r22", ...(post ? { post } : {}) });
      const mk = async (title, slug) => (await call("POST", "/pages/new", { token: TL(), body: { title, slug } })).json.id;
      const LA = await mk("Odkazy A", "odkazy-a"), LB = await mk("Odkazy B", "odkazy-b");
      const LC = (await call("POST", `/pages/${CIZI}/duplicate`, { token: TL(CIZI) })).json?.id;
      const cizi = (await helper("/state")).pages["Cizí stránka"] === CIZI ? `/?page_id=${CIZI}` : "";
      await call("PATCH", `/drafts/${LA}/elements`, { token: TL(LA), body: [{ id: "@post", settings: { content: `<p><a href="${WP}/odkazy-b/#kotva">nova</a> <a href="/odkazy-b">relativni</a> <a href="${WP}${cizi}">kopie</a> <a href="${WP}/?p=${CIZI}">podle-id</a> <a href="${WP}/jina-stranka/">jina</a></p>` } }] });
      await call("PATCH", `/drafts/${LB}/elements`, { token: TL(LB), body: [{ id: "@post", settings: { content: "<p>Obsah stránky B</p>" } }] });
      const pl = await call("GET", `/drafts/${LA}/preview-link`, { token: TL(LA) });
      const plRes = await fetch(pl.json.url);
      const h = await plRes.text();
      check("náhled stránky se necachuje", plRes.headers.get("x-litespeed-cache-control") === "no-cache", plRes.headers.get("x-litespeed-cache-control"));
      const hrefOf = (t) => new RegExp(`<a[^>]*href="([^"]*)"[^>]*>${t}<`).exec(h)?.[1]?.replace(/&#0?38;|&amp;/g, "&");
      const nova = hrefOf("nova");
      check("odkaz na novou stránku vede na její náhled i s kotvou", nova?.includes(`page_id=${LB}`) && nova.includes("klicenka_nahled=") && nova.endsWith("#kotva"), nova);
      check("relativní odkaz taky", hrefOf("relativni")?.includes(`page_id=${LB}`), hrefOf("relativni"));
      check("odkaz na originál vede na náhled jeho konceptu", hrefOf("kopie")?.includes(`page_id=${LC}`) && hrefOf("podle-id")?.includes(`page_id=${LC}`), [hrefOf("kopie"), hrefOf("podle-id")]);
      check("cizí odkaz zůstává", hrefOf("jina") === `${WP}/jina-stranka/`, hrefOf("jina"));
      const exp = (u) => new URL(u, WP).searchParams.get("klicenka_nahled")?.split(".")[0];
      check("platnost nepřesáhne výchozí náhled", exp(nova) === exp(pl.json.url), [exp(nova), exp(pl.json.url)]);
      check("otevřený odkaz ukáže stránku B", (await (await fetch(nova)).text()).includes("Obsah stránky B"));
      check("živá stránka bez náhledu se nepřepisuje", !(await (await fetch(`${WP}/?page_id=${CIZI}`)).text()).includes("klicenka_nahled"));
      const before = (await call("POST", "/pages/new", { token: sign({ req: "r23" }), body: { title: "Cizí úprava", slug: "cizi-uprava" } })).json.id;
      await call("PATCH", `/drafts/${LA}/elements`, { token: TL(LA), body: [{ id: "@post", settings: { content: `<p><a href="${WP}/cizi-uprava/">cizi</a></p>` } }] });
      check("stránka jiné úpravy se nepřepíše", !(await (await fetch(pl.json.url)).text()).includes(`page_id=${before}`));
      for (const [id, tok] of [[LA, LA], [LB, LB], [LC, CIZI]]) await call("POST", `/drafts/${id}/discard`, { token: sign({ scope: "publish", req: "r22", post: tok }, { ttl: 60 }) });
      await call("POST", `/drafts/${before}/discard`, { token: sign({ scope: "publish", req: "r23", post: before }, { ttl: 60 }) });
    }
    if (withElementor) {
      const ne = await newPage({ title: "Elementor kopie", from: EL });
      const NE = ne.json?.id;
      const neI = await helper(`/inspect&post=${NE}`), elI = await helper(`/inspect&post=${EL}`);
      check("kopie Elementoru: stejná data, editor elementor", ne.json?.editor === "elementor" && neI.meta._elementor_data === elI.meta._elementor_data, ne.json);
      const up = await call("PATCH", `/drafts/${NE}/elements`, { token: TN(NE), body: [{ id: "head1", settings: { title: "English heading" } }] });
      check("překlad prvku jen v kopii", up.status === 200 && (await helper(`/inspect&post=${NE}`)).meta._elementor_data.includes("English heading") && !(await helper(`/inspect&post=${EL}`)).meta._elementor_data.includes("English heading"), up.json);
      await call("POST", `/drafts/${NE}/discard`, { token: PUB(NE) });
    }
    if (withPolylang && !noLangs) {
      await fetch(`${WP}/`);
      const stL = await call("GET", "/status");
      check("status: jazyky webu", stL.json?.languages?.includes("de") && stL.json?.features?.includes("new-pages"), stL.json);
      check("neznámý jazyk 422", (await newPage({ title: "x", from: GB, lang: "xx" })).status === 422);
      const stP2 = await helper("/state");
      check("existující překlad 409", (await newPage({ title: "x", from: EL, lang: "de" })).status === 409, stP2.pages["Test Elementor DE"]);
      const tl = await newPage({ title: "Test Gutenberg DE", slug: "test-gutenberg-de", from: GB, lang: "de" });
      const TL = tl.json?.id;
      check("koncept překladu 200", tl.status === 200 && TL > 0, tl.json);
      const tlOut = await call("GET", `/drafts/${TL}/outline`, { token: TN(TL) });
      check("koncept má jazyk, propojený ještě není", tlOut.json?.new_page?.lang === "de" && !tlOut.json.new_page.translations?.cs, tlOut.json?.new_page);
      const tp = await call("POST", `/drafts/${TL}/publish`, { token: PUB(TL) });
      const list1 = (await call("GET", "/pages&type=page", { token: sign({ req: "r9" }) })).json.pages;
      const gbI = list1.find((x) => x.id === GB), tlI = list1.find((x) => x.id === TL);
      check("zveřejnění propojí překlad, základ dostane výchozí jazyk", tp.status === 200 && gbI?.translations?.de === TL && tlI?.lang === "de" && !!gbI?.lang, { gbI, tlI });
      if (withElementor) {
        const FOOT2 = stP2.pages["Test Patička"];
        if (!withPro) check("kopie šablony bez Elementoru Pro 422", (await newPage({ title: "x", from: FOOT2 })).status === 422);
        const ft = await newPage({ title: "Fußzeile", from: FOOT2, lang: "de" });
        const FT = ft.json?.id;
        const ftM = (await helper(`/inspect&post=${FT}`)).meta;
        check("jazyková verze šablony: typ ano, podmínky ne", ft.status === 200 && ftM._elementor_template_type === "footer" && !("_elementor_conditions" in ftM), ft.json);
        const fCond = (await helper(`/inspect&post=${FOOT2}`)).meta._elementor_conditions;
        const fp2 = await call("POST", `/drafts/${FT}/publish`, { token: PUB(FT) });
        const libs = (await call("GET", "/pages&type=elementor_library", { token: sign({ req: "r9" }) })).json.pages;
        check("šablona propojená jako překlad, podmínky originálu beze změny", fp2.status === 200 && libs.find((x) => x.id === FOOT2)?.translations?.de === FT && (await helper(`/inspect&post=${FOOT2}`)).meta._elementor_conditions === fCond, libs.map((x) => [x.id, x.lang, x.translations]));
        const fr2 = await call("POST", `/pages/${FT}/rollback`, { token: PUB(FT) });
        check("návrat šablony do konceptu", fr2.status === 200 && (await helper(`/inspect&post=${FT}`)).post.status === "draft", fr2.json);
      }
      const tr = await call("POST", `/pages/${TL}/rollback`, { token: PUB(TL) });
      const list2 = (await call("GET", "/pages&type=page", { token: sign({ req: "r9" }) })).json.pages;
      check("návrat odpojí překlad", tr.status === 200 && !list2.find((x) => x.id === GB)?.translations?.de && (await helper(`/inspect&post=${TL}`)).post.status === "draft", list2.find((x) => x.id === GB));
    }
  }

  // ---------- Polylang právě nainstalovaný, bez jazyků: vše nastaví zveřejnění ----------
  if (noLangs) {
    console.log("\nPolylang bez jazyků");
    const TN = (post) => sign({ req: "r10", ...(post ? { post } : {}) });
    const PUB = (post) => sign({ scope: "publish", req: "r10", post }, { ttl: 60 });
    const menu = async () => (await (await fetch(`${WP}/?kut_menu=1`)).text()).includes("Domů");
    const s0 = await call("GET", "/status");
    check("web bez jazyků", Array.isArray(s0.json?.languages) && s0.json.languages.length === 0, s0.json);
    check("menu v pozici motivu před nastavením", await menu());
    check("překlad do jazyka webu 422", (await call("POST", "/pages/new", { token: TN(), body: { title: "x", from: GB, lang: "cs" } })).status === 422);
    const a = await call("POST", "/pages/new", { token: TN(), body: { title: "Test Gutenberg EN", slug: "test-gutenberg-en", from: GB, lang: "en" } });
    const A = a.json?.id;
    const b = await call("POST", "/pages/new", { token: TN(), body: { title: "Test Elementor EN", slug: "test-elementor-en", from: EL, lang: "en" } });
    const B = b.json?.id;
    check("koncepty 200, jazyk zatím web nemá", a.status === 200 && b.status === 200 && (await call("GET", "/status")).json.languages.length === 0, [a.json, b.json]);
    const pl = await call("GET", `/drafts/${A}/preview-link`, { token: TN(A) });
    check("náhled konceptu před nastavením jazyků", (await fetch(pl.json.url)).status === 200, pl.json);
    const homeBefore = await (await fetch(`${WP}/?page_id=${GB}`, { redirect: "follow" })).text();
    const p1 = await call("POST", `/drafts/${A}/publish`, { token: PUB(A) });
    const s1 = await call("GET", "/status");
    check("zveřejnění založí výchozí jazyk a angličtinu", p1.status === 200 && s1.json.languages.includes("en") && s1.json.languages.length === 2, { p: p1.json, s: s1.json });
    const p2 = await call("POST", `/drafts/${B}/publish`, { token: PUB(B) });
    check("další stránka stejného jazyka", p2.status === 200 && (await call("GET", "/status")).json.languages.length === 2, p2.json);
    const l1 = (await call("GET", "/pages&type=page", { token: sign({ req: "r10" }) })).json.pages;
    const gb = l1.find((x) => x.id === GB), en = l1.find((x) => x.id === A), cizi2 = l1.find((x) => x.id === CIZI);
    check("stávající obsah má výchozí jazyk, překlad propojený", !!cizi2?.lang && gb?.translations?.en === A && en?.lang === "en", { gb, en, cizi2 });
    check("menu zůstalo v pozici motivu", await menu());
    const live = await fetch(`${WP}/test-gutenberg/`, { redirect: "manual" });
    check("česká adresa beze změny", live.status === 200, live.status);
    check("anglická stránka žije pod /en/", (await fetch(`${WP}/en/test-gutenberg-en/`)).status === 200);
    await fetch(`${WP}/`);
    const r1 = await call("POST", `/pages/${A}/rollback`, { token: PUB(A) });
    check("návrat první stránky: jazyky zůstávají, druhá je používá", r1.status === 200 && (await call("GET", "/status")).json.languages.length === 2, r1.json);
    const r2 = await call("POST", `/pages/${B}/rollback`, { token: PUB(B) });
    const s2 = await call("GET", "/status");
    check("návrat poslední: web zase bez jazyků", r2.status === 200 && s2.json.languages.length === 0, { r: r2.json, s: s2.json });
    check("po návratu menu a obsah jako dřív", (await menu()) && (await (await fetch(`${WP}/?page_id=${GB}`, { redirect: "follow" })).text()).length > 0 && homeBefore.length > 0);
    check("koncept jde zveřejnit znovu", (await call("POST", `/drafts/${A}/publish`, { token: PUB(A) })).status === 200 && (await call("GET", "/status")).json.languages.length === 2);
    await call("POST", `/pages/${A}/rollback`, { token: PUB(A) });
  }

  // ---------- Prvky v konceptu ----------
  if (withElementor) {
    console.log("\nVkládání prvků");
    const TI = (c = {}) => sign({ req: "r11", post: EL, ...c });
    const d = await call("POST", `/pages/${EL}/duplicate`, { token: TI() });
    const ID = d.json.id;
    const orig = (await helper(`/inspect&post=${EL}`)).meta._elementor_data;
    const ins = await call("PATCH", `/drafts/${ID}/elements`, { token: TI(), body: [{ id: "head1", insert: { position: "after", element: { elType: "widget", widgetType: "polylang-language-switcher", settings: { layout: "horizontal" } } } }] });
    const data = (await helper(`/inspect&post=${ID}`)).meta._elementor_data;
    check("vložení widgetu za prvek", ins.status === 200 && data.indexOf("polylang-language-switcher") > data.indexOf("head1") && data.indexOf("polylang-language-switcher") < data.indexOf("text1"), ins.json);
    check("originál beze změny", (await helper(`/inspect&post=${EL}`)).meta._elementor_data === orig);
    check("vložení k neexistujícímu 422", (await call("PATCH", `/drafts/${ID}/elements`, { token: TI(), body: [{ id: "nic", insert: { element: { elType: "widget", widgetType: "heading" } } }] })).status === 422);
    check("neplatný prvek 400", (await call("PATCH", `/drafts/${ID}/elements`, { token: TI(), body: [{ id: "head1", insert: { element: { elType: "skript" } } }] })).status === 400);
    const rm = await call("PATCH", `/drafts/${ID}/elements`, { token: TI(), body: [{ id: "text1", remove: true }] });
    check("smazání prvku v konceptu", rm.status === 200 && !(await helper(`/inspect&post=${ID}`)).meta._elementor_data.includes("text1"), rm.json);
    await call("POST", `/drafts/${ID}/discard`, { token: sign({ scope: "publish", req: "r11", post: EL }, { ttl: 60 }) });
  }

  // ---------- Klíčenka 1.3.0: přihlášení beze změny ----------
  console.log("\nKlíčenka přihlášení (zpětná kompatibilita)");
  const login = (tok) => fetch(`${WP}/wp-login.php?action=klicenka`, { method: "POST", body: new URLSearchParams({ token: tok }), redirect: "manual" });
  const lt = sign({ sub: "admin", scope: undefined }, { typ: "klicenka+jwt", ttl: 60 });
  const l1 = await login(lt);
  check("přihlašovací token 60 s přihlásí admina", l1.status === 302 && /wp-admin/.test(l1.headers.get("location") || ""), l1.status);
  check("stejný přihlašovací token podruhé ne", (await login(lt)).status !== 302);
  check("přihlašovací token s platností 15 min ne", (await login(sign({ sub: "admin", scope: undefined }, { typ: "klicenka+jwt", ttl: 900 }))).status !== 302);

  // ---------- zvýšení práv a log ----------
  console.log("\nOstatní");
  await helper("/elevate", "POST");
  await call("GET", "/pages", { token: sign({ req: "r3" }) });
  const st2 = await helper("/state");
  check("přidaná práva účtu se při dalším volání odeberou", st2.user.roles.length === 1 && st2.user.roles[0] === "claude_upravy" && !st2.user.allcaps.includes("manage_options"), st2.user);
  const cizi = await helper(`/inspect&post=${CIZI}`);
  check("cizí stránka nedotčena", cizi.post.content === "<p>Nesahat</p>" && cizi.revisions === 0);
  const logText = JSON.stringify(st2.log);
  check("log obsahuje akce s req a kdo", ["duplicate", "elements", "media", "publish", "rollback", "refused"].every((a) => st2.log.some((e) => e.action === a)) && st2.log.some((e) => e.action === "publish" && e.req === "r1" && e.who === "ondrej@example.test"), st2.log.slice(0, 3));
  check("log neobsahuje tokeny", !/eyJ[A-Za-z0-9_-]{10,}/.test(logText));
} catch (e) {
  fail++;
  console.error("\nCHYBA:", e);
} finally {
  console.log(`\n${ok} prošlo, ${fail} selhalo`);
  stop();
  process.exitCode = fail ? 1 : 0;
}
