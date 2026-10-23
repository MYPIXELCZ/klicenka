#!/usr/bin/env node
// Test klicenka-stav na WP Playground vedle klicenka.php (verze z větve = ta, co běží na webech).
// Použití:  [PHP_VERSION=7.4] node wordpress/klicenka-stav/test/run.mjs [--keep]
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
const WP_PORT = Number(process.env.WP_PORT || 3106);
const JWKS_PORT = Number(process.env.JWKS_PORT || 3398);
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
function sign(claims = {}, { typ = "klicenka-stav+jwt", key = privateKey, ttl = 60 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const iat = claims.iat ?? now;
  const payload = { iss: ISSUER, aud: AUD, sub: "tracker", jti: crypto.randomUUID(), iat, exp: iat + ttl, act: { sub: "tracker", name: "Kontrola", email: "t@example.test" }, scope: "stav", ...claims };
  const h = b64({ alg: "EdDSA", typ, kid: "test1" });
  const p = b64(payload);
  return `${h}.${p}.${crypto.sign(null, Buffer.from(`${h}.${p}`), key).toString("base64url")}`;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "klicenka-stav-test-"));
const mu = path.join(tmp, "mu-plugins");
fs.mkdirSync(mu);
fs.copyFileSync(klicenkaPhp, path.join(mu, "klicenka.php"));
fs.copyFileSync(path.join(pluginDir, "klicenka-stav.php"), path.join(mu, "klicenka-stav.php"));
const steps = [{ step: "defineWpConfigConsts", consts: { KLICENKA_AUDIENCE: "example-wordpress", KLICENKA_ENVIRONMENT: "local", KLICENKA_ISSUER: ISSUER } }];
fs.writeFileSync(path.join(tmp, "blueprint.json"), JSON.stringify({ steps, features: { networking: true } }));
const wpLog = fs.openSync(path.join(tmp, "playground.log"), "a");
const child = spawn("npx", ["-y", "@wp-playground/cli@3.1.60", "server", `--port=${WP_PORT}`, `--mount=${mu}:/wordpress/wp-content/mu-plugins`, `--blueprint=${path.join(tmp, "blueprint.json")}`, "--workers=1", `--php=${process.env.PHP_VERSION || "8.3"}`], { stdio: ["ignore", wpLog, wpLog], detached: true });
let stopped = false;
function stop() { if (stopped) return; stopped = true; try { process.kill(-child.pid, "SIGTERM"); } catch {} jwks.close(); if (!keep) fs.rmSync(tmp, { recursive: true, force: true }); }
process.on("SIGINT", () => { stop(); process.exit(130); });

const url = `${WP}/?rest_route=/klicenka-stav/v1/stav`;
const call = async (token, extra = "") => { const r = await fetch(url + extra, { headers: token ? { authorization: `Bearer ${token}` } : {} }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, json: j, text: t }; };
let ok = 0, fail = 0;
const check = (n, c, d) => { if (c) { ok++; console.log(`  ✔ ${n}`); } else { fail++; console.log(`  ✘ ${n}  → ${JSON.stringify(d)?.slice(0, 400)}`); } };

try {
  process.stdout.write(`Playground (PHP ${process.env.PHP_VERSION || "8.3"}) startuje…`);
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > 600_000) throw new Error("Playground nenaběhl");
    try { const r = await fetch(`${WP}/`); if (r.status === 200) break; } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(` ${Math.round((Date.now() - t0) / 1000)} s`);
  const home = await fetch(`${WP}/`);
  check("web běží (200, bez PHP chyby)", home.status === 200 && !/Fatal error|critical error/i.test(await home.text()));
  check("bez tokenu 401", (await call()).status === 401);
  check("přihlašovací token (klicenka+jwt) 401", (await call(sign({}, { typ: "klicenka+jwt" }))).status === 401);
  check("token úprav (klicenka-upravy+jwt) 401", (await call(sign({}, { typ: "klicenka-upravy+jwt" }))).status === 401);
  check("cizí klíč 401", (await call(sign({}, { key: otherKey }))).status === 401);
  check("jiný web 401", (await call(sign({ aud: "jiny@local" }))).status === 401);
  check("jiný vydavatel 401", (await call(sign({ iss: "https://evil.example" }))).status === 401);
  check("vypršelý 401", (await call(sign({ iat: Math.floor(Date.now() / 1000) - 600 }))).status === 401);
  check("platnost 5 min 401", (await call(sign({}, { ttl: 300 }))).status === 401);
  check("špatný scope 403", (await call(sign({ scope: "publish" }))).status === 403);
  check("token v URL se nečte", (await call(null, `&token=${sign()}`)).status === 401);
  const t = sign();
  const r = await call(t);
  check("platný token 200", r.status === 200, r.text);
  check("vrací WordPress, PHP, pluginy, šablony", !!r.json?.wordpress?.version && !!r.json?.php?.version && Array.isArray(r.json?.plugins) && Array.isArray(r.json?.themes) && r.json.themes.length > 0, r.json);
  check("aktivní šablona označená", r.json?.themes?.some((x) => x.active), r.json?.themes);
  check("nevrací e-maily ani uživatele", !/@|user_email|user_login/i.test(r.text.replace(/"plugin":"[^"]*"/, "")), r.text.slice(0, 300));
  check("stejný token podruhé 401", (await call(t)).status === 401);
  console.log(`  verze: WP ${r.json?.wordpress?.version}, PHP ${r.json?.php?.version}, pluginů ${r.json?.plugins?.length}, šablon ${r.json?.themes?.length}`);
} catch (e) {
  fail++; console.log(`\n✘ ${e.message}`);
} finally {
  console.log(`\n${ok} ok, ${fail} chyb`);
  stop();
  process.exit(fail ? 1 : 0);
}
