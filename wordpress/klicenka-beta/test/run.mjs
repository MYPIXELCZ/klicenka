#!/usr/bin/env node
// Test klicenka-beta (zkušební režim pro zkoušky formulářů z trackeru) na WP Playground s WPForms Lite
// a volitelně Elementorem Pro. Ověřuje, že bez platného tokenu se nestane nic a s ním žádný e-mail neodejde,
// nic nejde ven, nic se neodloží na později a napojení po odeslání se nespustí.
// Použití:  WPFORMS_DIR=…/wpforms-lite [ELEMENTOR_DIR=…/elementor ELEMENTOR_PRO_DIR=…/elementor-pro] \
//           [PHP_VERSION=7.4] node wordpress/klicenka-beta/test/run.mjs [--keep]
// Nic neposílá ven: „tracker“ (JWKS, manifest) běží lokálně, ostatní odchozí požadavky blokuje spy.php.
import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const wpDir = path.resolve(here, "../..");
const repo = path.resolve(wpDir, "..");
const BETA = fs.readFileSync(path.join(wpDir, "klicenka-beta/klicenka-beta.php"), "utf8");
const NEW = fs.readFileSync(path.join(wpDir, "klicenka/klicenka.php"), "utf8");
// Skutečná 1.7.0 z gitu: web na ní dostane klicenka-beta.php až druhou aktualizací.
const OLD = execFileSync("git", ["-C", repo, "show", "0a9ca9a:wordpress/klicenka/klicenka.php"], { encoding: "utf8" });
const WPFORMS = process.env.WPFORMS_DIR;
const ELEMENTOR = process.env.ELEMENTOR_DIR;
const ELEMENTOR_PRO = process.env.ELEMENTOR_PRO_DIR;
if (!WPFORMS || !fs.existsSync(path.join(WPFORMS, "wpforms.php"))) {
  console.error("Chybí WPFORMS_DIR (rozbalený wpforms-lite).");
  process.exit(2);
}
const withElementor = !!(ELEMENTOR && ELEMENTOR_PRO);
const WP_PORT = Number(process.env.WP_PORT || 3109);
const T_PORT = Number(process.env.T_PORT || 3398);
const ISSUER = `http://127.0.0.1:${T_PORT}`;
const AUD = "example-wordpress@local";
const WP = `http://127.0.0.1:${WP_PORT}`;
const keep = process.argv.includes("--keep");

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const otherKey = crypto.generateKeyPairSync("ed25519").privateKey;
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test1", alg: "EdDSA", use: "sig" };
const files = { "klicenka.php": NEW, "klicenka-beta.php": BETA };
const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const tracker = http.createServer((req, res) => {
  if (req.url === "/.well-known/jwks.json") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [jwk] }));
  if (req.url === "/api/klicenka/wordpress/manifest") {
    const p = Buffer.from(JSON.stringify({ iss: ISSUER, iat: Math.floor(Date.now() / 1000), version: "1.8.0", files: Object.entries(files).map(([name, c]) => ({ name, sha256: sha(c), size: Buffer.byteLength(c) })) })).toString("base64url");
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ payload: p, kid: "test1", sig: crypto.sign(null, Buffer.from(p), privateKey).toString("base64url") }));
  }
  const m = req.url.match(/^\/api\/klicenka\/wordpress\/file\/(.+)$/);
  if (m && files[decodeURIComponent(m[1])]) return res.writeHead(200).end(files[decodeURIComponent(m[1])]);
  res.writeHead(404).end();
});
await new Promise((r) => tracker.listen(T_PORT, "127.0.0.1", r));

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function sign(claims = {}, { typ = "klicenka-beta+jwt", key = privateKey, ttl = 120 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const iat = claims.iat ?? now;
  const p = { iss: ISSUER, aud: AUD, sub: "klicenka-beta", jti: crypto.randomUUID(), iat, exp: iat + ttl, act: { sub: "u1", name: "Ondřej (test)", email: "o@example.test" }, scope: "test", ...claims };
  const h = b64({ alg: "EdDSA", typ, kid: "test1" });
  const pl = b64(p);
  return `${h}.${pl}.${crypto.sign(null, Buffer.from(`${h}.${pl}`), key).toString("base64url")}`;
}

// ---------- web ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "klicenka-beta-test-"));
const mu = path.join(tmp, "mu-plugins");
fs.mkdirSync(mu);
fs.writeFileSync(path.join(mu, "klicenka.php"), OLD);
fs.copyFileSync(path.join(here, "spy.php"), path.join(mu, "zz-spy.php"));

// Formuláře WPForms: A s veškerou ochranou proti robotům, B bez ní (skutečné odeslání pro srovnání), C platební.
const setup = `<?php require '/wordpress/wp-load.php';
function kbt_form($title, $fields, $extra) {
  $id = wp_insert_post(array('post_type' => 'wpforms', 'post_status' => 'publish', 'post_title' => $title, 'post_content' => '{}'));
  $data = array('id' => (string) $id, 'field_id' => 9, 'fields' => $fields, 'meta' => array('template' => 'blank'),
    'settings' => array_merge(array('form_title' => $title, 'submit_text' => 'Odeslat', 'ajax_submit' => '1', 'notification_enable' => '1',
      'notifications' => array(1 => array('email' => '{admin_email}', 'subject' => 'Nová poptávka z webu', 'sender_name' => 'Web', 'sender_address' => '{admin_email}', 'replyto' => '{field_id="2"}', 'message' => '{all_fields}')),
      'confirmations' => array(1 => array('type' => 'message', 'message' => 'Děkujeme, ozveme se.', 'message_scroll' => '1'))), $extra));
  wp_update_post(array('ID' => $id, 'post_content' => wpforms_encode($data)));
  return $id;
}
$f = array(
  1 => array('id' => '1', 'type' => 'name', 'label' => 'Jméno', 'format' => 'simple', 'required' => '1', 'size' => 'medium'),
  2 => array('id' => '2', 'type' => 'email', 'label' => 'E-mail', 'required' => '1', 'size' => 'medium'),
  3 => array('id' => '3', 'type' => 'textarea', 'label' => 'Zpráva', 'size' => 'medium'),
);
$a = kbt_form('Kontakt', $f, array('antispam' => '1', 'antispam_v3' => '1', 'honeypot' => '1', 'anti_spam' => array('time_limit' => array('enable' => '1', 'duration' => '30'))));
$b = kbt_form('Bez ochrany', $f, array('antispam' => '0', 'antispam_v3' => '0'));
$c = kbt_form('Platba', $f + array(4 => array('id' => '4', 'type' => 'payment-single', 'label' => 'Cena', 'price' => '100', 'format' => 'single')), array('antispam' => '0'));
$page = wp_insert_post(array('post_type' => 'page', 'post_status' => 'publish', 'post_title' => 'Kontakt', 'post_content' => '[wpforms id="' . $a . '"]'));
// „Optimize Email Sending“: e-mail by šel přes frontu (Action Scheduler) a odešel by až v dalším požadavku.
update_option('wpforms_settings', array_merge((array) get_option('wpforms_settings', array()), array('email-async' => true)));
update_option('admin_email', 'majitel@example.test');
$el = 0;
if (defined('ELEMENTOR_PRO_VERSION')) {
  // Stránka s formulářem Elementoru Pro: ukládání, e-mail a webhook.
  $el = wp_insert_post(array('post_type' => 'page', 'post_status' => 'publish', 'post_title' => 'Poptávka', 'post_content' => ''));
  $widget = array('id' => 'f1a2b3c', 'elType' => 'widget', 'widgetType' => 'form', 'settings' => array(
    'form_name' => 'Poptávka',
    'form_fields' => array(
      array('_id' => 'n1', 'custom_id' => 'name', 'field_type' => 'text', 'field_label' => 'Jméno', 'required' => 'true'),
      array('_id' => 'e1', 'custom_id' => 'email', 'field_type' => 'email', 'field_label' => 'E-mail', 'required' => 'true'),
      array('_id' => 'm1', 'custom_id' => 'message', 'field_type' => 'textarea', 'field_label' => 'Zpráva'),
    ),
    'submit_actions' => array('save-to-database', 'email', 'webhook'),
    'email_to' => 'majitel@example.test', 'email_subject' => 'Nová zpráva z Elementoru', 'email_content' => '[all-fields]',
    'email_from' => 'web@example.test', 'email_from_name' => 'Web', 'webhooks' => 'https://hook.example.test/el',
  ));
  $data = array(array('id' => 's1', 'elType' => 'section', 'settings' => array(), 'elements' => array(array('id' => 'c1', 'elType' => 'column', 'settings' => array('_column_size' => 100), 'elements' => array($widget)))));
  update_post_meta($el, '_elementor_edit_mode', 'builder');
  update_post_meta($el, '_elementor_template_type', 'wp-page');
  update_post_meta($el, '_elementor_data', wp_slash(wp_json_encode($data)));
}
update_option('kbt_forms', array('a' => $a, 'b' => $b, 'c' => $c, 'page' => $page, 'el' => $el));
`;
const steps = [
  { step: "defineWpConfigConsts", consts: { KLICENKA_AUDIENCE: "example-wordpress", KLICENKA_ENVIRONMENT: "local", KLICENKA_ISSUER: ISSUER, ...(process.env.WPDEBUG ? { WP_DEBUG: true, WP_DEBUG_DISPLAY: true } : {}) } },
  { step: "activatePlugin", pluginPath: "wpforms-lite/wpforms.php" },
  ...(withElementor ? [{ step: "activatePlugin", pluginPath: "elementor/elementor.php" }, { step: "activatePlugin", pluginPath: "elementor-pro/elementor-pro.php" }] : []),
  { step: "runPHP", code: setup },
];
fs.writeFileSync(path.join(tmp, "blueprint.json"), JSON.stringify({ steps, features: { networking: true } }));
const wpLog = fs.openSync(path.join(tmp, "playground.log"), "a");
const mounts = [`--mount=${mu}:/wordpress/wp-content/mu-plugins`, `--mount=${WPFORMS}:/wordpress/wp-content/plugins/wpforms-lite`];
if (withElementor) mounts.push(`--mount=${ELEMENTOR}:/wordpress/wp-content/plugins/elementor`, `--mount=${ELEMENTOR_PRO}:/wordpress/wp-content/plugins/elementor-pro`);
const child = spawn("npx", ["-y", "@wp-playground/cli@3.1.60", "server", `--port=${WP_PORT}`, ...mounts,
  `--blueprint=${path.join(tmp, "blueprint.json")}`, "--workers=1", `--php=${process.env.PHP_VERSION || "8.3"}`], { stdio: ["ignore", wpLog, wpLog], detached: true });
let stopped = false;
function stop() { if (stopped) return; stopped = true; try { process.kill(-child.pid, "SIGTERM"); } catch {} tracker.close(); if (!keep) fs.rmSync(tmp, { recursive: true, force: true }); else console.log(`  ponecháno: ${tmp}`); }
process.on("SIGINT", () => { stop(); process.exit(130); });

const ajax = `${WP}/wp-admin/admin-ajax.php`;
// Požadavky na místní „tracker“ (JWKS) k věci nepatří.
const state = async () => { const s = await (await fetch(`${WP}/?rest_route=/kbt/v1/state&_=${Date.now()}`)).json(); s.log = (s.log ?? []).filter((l) => !(l.what === "http" && l.data === "127.0.0.1")); return s; };
const set = (o) => fetch(`${WP}/?rest_route=/kbt/v1/set`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(o) });
const reset = () => set({ reset: true });
const decode = (h) => { try { return h ? JSON.parse(Buffer.from(h, "base64url").toString("utf8")) : null; } catch { return null; } };
async function post(url, fields, token) {
  const r = await fetch(url, { method: "POST", headers: token ? { "x-klicenka-test": token } : {}, body: new URLSearchParams(fields) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json, beta: decode(r.headers.get("x-klicenka-beta")) };
}
const what = (s) => s.log.map((l) => l.what);
const mailTouched = (s) => what(s).some((w) => w === "phpmailer" || w === "mail_sent" || w === "mail_failed");
let ok = 0, fail = 0;
const check = (n, c, d) => { if (c) { ok++; console.log(`  ✔ ${n}`); } else { fail++; console.log(`  ✘ ${n}  → ${JSON.stringify(d)?.slice(0, 700)}`); } };

try {
  process.stdout.write(`Playground (PHP ${process.env.PHP_VERSION || "8.3"}${withElementor ? ", Elementor Pro" : ""}) startuje…`);
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > 600_000) throw new Error("Playground nenaběhl");
    try { const r = await fetch(`${WP}/`); if (r.status === 200) break; } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(` ${Math.round((Date.now() - t0) / 1000)} s`);

  console.log("Instalace (web na 1.7.0)");
  const upd = async (install) => { const r = await fetch(`${ajax}?action=klicenka_update`, { method: "POST", body: new URLSearchParams({ token: sign({ sub: "klicenka-update", install }, { typ: "klicenka-update+jwt", ttl: 60 }) }) }); return r.json().catch(() => null); };
  let u = await upd(["klicenka-beta.php"]);
  check("1. aktualizace: klicenka.php → 1.8.0, klicenka-beta.php ještě ne (1.7.0 ho nezná)", u?.ok && u.updated.includes("klicenka.php") && !fs.existsSync(path.join(mu, "klicenka-beta.php")), u);
  u = await upd(["klicenka-beta.php"]);
  check("2. aktualizace: klicenka-beta.php přibyl", u?.ok && u.updated.includes("klicenka-beta.php") && fs.readFileSync(path.join(mu, "klicenka-beta.php"), "utf8") === BETA, u);
  const st0 = await fetch(`${ajax}?action=klicenka_status`).then((x) => x.text()).then((t) => { try { return JSON.parse(t); } catch { return { error: t.replace(/<[^>]+>/g, " ").slice(0, 800) }; } });
  check("stav Klíčenky: 1.8.0, beta: true", st0.version === "1.8.0" && st0.beta === true, st0);
  check("web běží", (await fetch(`${WP}/`)).status === 200);

  const s0 = await state();
  const F = s0.forms;
  check("formuláře založené, e-mail majitele", F?.a && F?.b && F?.c && s0.adminEmail === "majitel@example.test", s0);
  const mark = `zk${crypto.randomBytes(4).toString("hex")}`;
  const form = (id, extra = {}) => ({
    "wpforms[id]": String(id), "wpforms[fields][1]": `Zkouška trackeru ${mark}`, "wpforms[fields][2]": "zkouska@example.com",
    "wpforms[fields][3]": `Zkušební zpráva ${mark}`, "wpforms[post_id]": String(F.page), page_url: `${WP}/?page_id=${F.page}`, ...extra,
  });
  const testSubmit = (id, extra) => ({ action: "klicenka_beta_submit", klicenka_beta_action: "wpforms_submit", ...form(id, extra) });

  console.log("Srovnání: skutečné odeslání bez zkušebního režimu (formulář bez ochrany)");
  await reset();
  let r = await post(ajax, { action: "wpforms_submit", ...form(F.b) });
  let s = await state();
  check("skutečné odeslání projde", r.json?.success === true, r.text.slice(0, 300));
  // „Optimize Email Sending“ je zapnuté: e-mail se nesestaví hned, jde do fronty a odejde až dalším požadavkem.
  // (Úloha e-mailu se ve svěžím Playgroundu do fronty nezapíše – chybí tabulka WPForms pro úlohy –, na webu ano.)
  check("…e-mail se v tom požadavku nesestaví (jde přes frontu), napojení si úlohy na později založí", !what(s).includes("wp_mail") && s.as >= 1 && s.cron === 1, { log: what(s), as: s.as, cron: s.cron });
  check("…napojení po odeslání běží", what(s).includes("wpf_complete_hook"), what(s));
  check("…bez hlavičky X-Klicenka-Beta", r.beta === null);

  console.log("Bez platného tokenu se nestane nic");
  const none = [
    ["bez tokenu", undefined],
    ["cizí klíč", sign({}, { key: otherKey })],
    ["jiný web", sign({ aud: "jiny@local" })],
    ["jiný vydavatel", sign({ iss: "https://evil.example" })],
    ["typ aktualizace", sign({}, { typ: "klicenka-update+jwt" })],
    ["přihlašovací typ", sign({}, { typ: "klicenka+jwt" })],
    ["jiný scope", sign({ scope: "udrzba" })],
    ["vypršelý", sign({ iat: Math.floor(Date.now() / 1000) - 600 })],
    ["platnost 5 min", sign({}, { ttl: 300 })],
  ];
  for (const [name, t] of none) {
    await reset();
    r = await post(ajax, testSubmit(F.a), t);
    s = await state();
    check(`${name}: zkušební akce neznámá (400 „0“), nic se nestalo`, r.status === 400 && r.text.trim() === "0" && r.beta === null && s.log.length === 0, { status: r.status, text: r.text.slice(0, 100), log: what(s) });
  }
  await reset();
  r = await post(`${ajax}?action=klicenka_beta_status`, {}, undefined);
  check("stav zkušebního režimu bez tokenu: 400 „0“", r.status === 400 && r.text.trim() === "0");

  console.log("Stav s tokenem");
  r = await post(`${ajax}?action=klicenka_beta_status`, {}, sign());
  check("stav: ok, pošta jde zadržet, WPForms", r.json?.ok && r.json.mailSafe === true && r.json.wpforms === "2.0.4" && r.json.version === "0.1.0", r.json ?? r.text);

  console.log("Zkušební odeslání (formulář s ochranou proti robotům, e-mail přes frontu)");
  await reset();
  const before = await state();
  const tok = sign({ marks: [mark] });
  r = await post(ajax, testSubmit(F.a), tok);
  s = await state();
  const b = r.beta;
  check("odeslání projde (ochrana proti robotům přeskočena)", r.status === 200 && r.json?.success === true, r.json ?? r.text.slice(0, 400));
  check("hlavička: zkušební režim, WPForms", b?.test === true && b.submit === true && b.plugin === "wpforms", b);
  check("e-mail sestaven pro majitele, s předmětem a zkušební hodnotou", b?.mails?.length === 1 && b.mails[0].to.includes("majitel@example.test") && b.mails[0].subject === "Nová poptávka z webu" && b.mails[0].marked === true, b?.mails);
  check("e-mail se nedostal k PHPMaileru ani neodešel", !mailTouched(s) && what(s).includes("wp_mail"), what(s));
  check("napojení po odeslání (wpforms_process_complete) se nespustilo", !what(s).includes("wpf_complete_hook") && b?.skipped?.some((x) => x.startsWith("wpforms_process_complete:")), { log: what(s), skipped: b?.skipped });
  check("odchozí požadavek během zpracování zablokovaný", b?.http?.includes("kept.example.test") && !s.log.some((l) => l.what === "http"), { http: b?.http, log: s.log });
  check("nic se neodložilo na později (Action Scheduler, WP-Cron), e-mail se sestavil hned", b?.deferred >= 2 && s.cron === before.cron && s.as === before.as, { deferred: b?.deferred, cron: [before.cron, s.cron], as: [before.as, s.as] });
  check("zpracování formuláře proběhlo (háček wpforms_process)", what(s).includes("wpf_process_hook"));
  check("stejný token podruhé: nic", (await post(ajax, testSubmit(F.a), tok)).text.trim() === "0");

  console.log("Pojistky");
  await reset();
  r = await post(ajax, { action: "wpforms_submit", ...form(F.a) }, sign({ marks: [mark] }));
  s = await state();
  check("s tokenem a skutečnou akcí: stejně chráněné", r.json?.success === true && r.beta?.submit === true && !mailTouched(s) && !what(s).includes("wpf_complete_hook"), { beta: r.beta, log: what(s) });
  await reset();
  r = await post(`${WP}/?page_id=${F.page}`, form(F.a), sign({ marks: [mark] }));
  s = await state();
  check("s tokenem mimo admin-ajax (odeslání na stránku): 409, nic", r.status === 409 && s.log.length === 0 && r.beta?.notes?.includes("refused:not-ajax"), { status: r.status, log: what(s), beta: r.beta });
  await reset();
  r = await post(ajax, testSubmit(F.c), sign({ marks: [mark] }));
  s = await state();
  check("platební formulář: 409, nic", r.status === 409 && r.json?.reason === "payment-form" && s.log.length === 0, { status: r.status, json: r.json, log: what(s) });
  await set({ shared: true, reset: true });
  r = await post(ajax, testSubmit(F.a), sign({ marks: [mark] }));
  s = await state();
  check("cizí zkratka pre_wp_mail: 409, e-mail ani nesestaven", r.status === 409 && r.json?.reason === "pre-wp-mail-shared" && !what(s).includes("wp_mail"), { status: r.status, json: r.json, log: what(s) });
  r = await post(`${ajax}?action=klicenka_beta_status`, {}, sign());
  check("stav to hlásí (mailSafe: false)", r.json?.mailSafe === false && r.json.mailReason === "pre-wp-mail-shared", r.json);
  await set({ shared: false, reset: true });

  if (withElementor) {
    console.log("Elementor Pro");
    const el = (extra = {}) => ({ post_id: String(F.el), queried_id: String(F.el), form_id: "f1a2b3c", referer_title: "Poptávka",
      "form_fields[name]": `Zkouška trackeru ${mark}`, "form_fields[email]": "zkouska@example.com", "form_fields[message]": `Zkušební zpráva ${mark}`, ...extra });
    check("stránka s formulářem Elementoru", F.el > 0, F);
    await reset();
    let s1 = await state();
    r = await post(ajax, { action: "elementor_pro_forms_send_form", ...el() });
    s = await state();
    check("srovnání: skutečné odeslání projde, uloží se, e-mail k PHPMaileru, napojení běží", r.json?.success === true && s.submissions === s1.submissions + 1 && mailTouched(s) && what(s).includes("el_new_record_hook"), { json: r.json ?? r.text.slice(0, 300), sub: [s1.submissions, s.submissions], log: what(s) });
    await reset();
    s1 = await state();
    r = await post(ajax, { action: "klicenka_beta_submit", klicenka_beta_action: "elementor_pro_forms_send_form", ...el() }, sign({ marks: [`Zkouška trackeru ${mark}`, `Zkušební zpráva ${mark}`] }));
    s = await state();
    const e = r.beta;
    check("zkušební odeslání projde", r.json?.success === true && e?.plugin === "elementor" && e.submit === true, { json: r.json ?? r.text.slice(0, 300), beta: e });
    check("akce formuláře zapsané, ukládání a webhook vynechané", JSON.stringify(e?.actions) === JSON.stringify(["save-to-database", "email", "webhook"]) && e.skipped.includes("save-to-database") && e.skipped.includes("webhook"), e);
    check("e-mail sestaven pro majitele, k PHPMaileru se nedostal", e?.mails?.length === 1 && e.mails[0].to.includes("majitel@example.test") && e.mails[0].marked === true && !mailTouched(s), { mails: e?.mails, log: what(s) });
    check("záznam v přehledu odeslaných nevznikl", s.submissions === s1.submissions, [s1.submissions, s.submissions]);
    check("napojení po odeslání (new_record) se nespustilo", !what(s).includes("el_new_record_hook") && e.skipped.some((x) => x.startsWith("elementor_pro/forms/new_record:")), { log: what(s), skipped: e?.skipped });
    check("webhook ani jiný požadavek ven", !s.log.some((l) => l.what === "http_blocked_by_spy" && l.data === "hook.example.test"), s.log);
    await reset();
    s1 = await state();
    // Kdyby ořezání akcí selhalo (filtr klicenka_beta_prune), smaže se záznam se zkušební hodnotou až po odeslání.
    await set({ noprune: true });
    r = await post(ajax, { action: "klicenka_beta_submit", klicenka_beta_action: "elementor_pro_forms_send_form", ...el() }, sign({ marks: [`Zkouška trackeru ${mark}`] }));
    s = await state();
    await set({ noprune: false });
    check("bez ořezání: záznam vznikne a hned se smaže, e-mail dál zadržený", r.json?.success === true && r.beta?.cleaned === 1 && s.submissions === s1.submissions && !mailTouched(s), { json: r.json, beta: r.beta, sub: [s1.submissions, s.submissions], log: what(s) });
  }

  check("web na konci běží", (await fetch(`${WP}/`)).status === 200);
} catch (e) {
  fail++; console.log(`\n✘ ${e.stack ?? e.message}`);
} finally {
  console.log(`\n${ok} ok, ${fail} chyb`);
  stop();
  process.exit(fail ? 1 : 0);
}
