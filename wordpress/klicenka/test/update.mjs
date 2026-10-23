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
let files = { "klicenka.php": NEW, "klicenka-upravy.php": UPRAVY, "klicenka-stav.php": STAV };
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
  const t = token();
  await update(t);
  check("stejný token podruhé 401", (await update(t)).status === 401);
} catch (e) {
  fail++; console.log(`\n✘ ${e.message}`);
} finally {
  console.log(`\n${ok} ok, ${fail} chyb`);
  stop();
  process.exit(fail ? 1 : 0);
}
