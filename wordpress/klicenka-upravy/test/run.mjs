#!/usr/bin/env node
// Test klicenka-upravy na WP Playground (Elementor z wordpress.org + Gutenberg).
// Použití:  [PHP_VERSION=7.4] node wordpress/klicenka-upravy/test/run.mjs [--no-elementor] [--keep]
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
  { step: "defineWpConfigConsts", consts: { KLICENKA_AUDIENCE: "example-wordpress", KLICENKA_ENVIRONMENT: "local", KLICENKA_ISSUER: ISSUER, KLICENKA_UPRAVY_MAX_UPLOAD: 300000, KLICENKA_UPRAVY_MAX_PDF: 600000 } },
  { step: "setSiteOptions", options: { permalink_structure: "/%postname%/" } },
];
if (withElementor) steps.push({ step: "installPlugin", pluginData: { resource: "wordpress.org/plugins", slug: "elementor" }, options: { activate: true } });
const withPolylang = !!process.env.WITH_POLYLANG;
if (withPolylang) steps.push({ step: "installPlugin", pluginData: { resource: "wordpress.org/plugins", slug: "polylang" }, options: { activate: true } });
fs.writeFileSync(path.join(tmp, "blueprint.json"), JSON.stringify({ steps, features: { networking: true } }, null, 2));

const wpLog = fs.openSync(path.join(tmp, "playground.log"), "a");
const child = spawn("npx", ["-y", "@wp-playground/cli@3.1.60", "server", `--port=${WP_PORT}`, `--mount=${mu}:/wordpress/wp-content/mu-plugins`, `--blueprint=${path.join(tmp, "blueprint.json")}`, "--workers=1", `--php=${process.env.PHP_VERSION || "8.3"}`], {
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
  if (withPolylang) {
    console.log("\nPolylang");
    await fetch(`${WP}/`); // init založí jazyky a překlad
    const stP = await helper("/state");
    const DE = stP.pages["Test Elementor DE"];
    const all = await call("GET", "/pages&type=page", { token: sign({ req: "r7" }) });
    const cs = all.json?.pages?.find((x) => x.id === EL), de = all.json?.pages?.find((x) => x.id === DE);
    check("seznam obsahuje oba jazyky", !!cs && !!de, all.json?.pages?.map((x) => [x.id, x.title, x.lang]));
    check("jazyk a překlady u stránky", cs?.lang === "cs" && cs?.translations?.de === DE && de?.translations?.cs === EL, { cs, de });
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
