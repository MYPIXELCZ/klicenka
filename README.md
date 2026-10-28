# @mypixel/klicenka

Přijímací strana **Klíčenky**: přihlášení na klik z Project Trackeru do administrace webů, které MYPIXEL spravuje. Tracker po ověření passkey vydá krátký token EdDSA (Ed25519). Web ho ověří přes veřejné klíče trackeru a přihlásí přesně určený účet. Běžné přihlášení heslem zůstává.

- **Bezpečnost:** podpis přes JWKS, vydavatel, adresát včetně prostředí, platnost nejvýš 60 s, jednorázové `jti`, žádný token v URL a žádné „přihlas prvního admina“.
- **Adaptéry:** vlastní cookie session, Supabase Auth, NextAuth v4 i v5, App i Pages Router a WordPress mu-plugin v PHP.
- **Stav webu:** `/klicenka/status` hlásí verzi a adaptér, nic citlivého. Tracker podle něj ukazuje, zda web odpovídá.

```bash
npm install https://github.com/MYPIXELCZ/klicenka/archive/refs/tags/v1.2.0.tar.gz
```

Celý návod k zapojení je v [docs/ZAPOJENI.md](docs/ZAPOJENI.md).

## Samoaktualizace WordPressu (od 1.4.0)

`klicenka.php` si jednou denně (a hned po kliknutí v trackeru, `/upravy` → Klíčenka na WordPressech) stáhne z trackeru
seznam souborů podepsaný klíčem Klíčenky, ověří podpis, otisky SHA-256 i syntaxi PHP a vymění soubory v mu-plugins
(předchozí verze zůstane jako `.prev`). Novou verzi vydáš tak, že v trackeru spustíš `node scripts/klicenka-wp-sync.mjs`
a nasadíš ho. Vypnutí na webu: `define('KLICENKA_AUTO_UPDATE', false);`.

Nové soubory se na web přidávají jen na pokyn z trackeru (claim `install`), s výjimkou neškodných doplňků, které jen
vypisují veřejné údaje:

- od 1.6.0 `klicenka-overeni.php` – značka `google-site-verification` z trackeru (`/api/gsc-overeni?host=…`), aby šel
  web ověřit a přidat do Search Console. Vypnutí: `define('KLICENKA_GSC_VERIFY', false);`.
- od 1.7.0 `klicenka-mereni.php` – měřicí skript trackeru `<script defer src="<issuer>/n.js" data-site="<KLICENKA_AUDIENCE>">`
  (bez cookies, bez lišty se souhlasem; sběr na `<issuer>/api/n`). Nevypisuje se přihlášeným s právem upravovat obsah,
  v administraci, kanálech, REST, AMP, náhledech, přizpůsobení vzhledu a embedech; na stránce jen jednou (konstanta
  `KLICENKA_TRAFFIC_TAG`, n.js zařazený přes `wp_enqueue_script`). Tag jde přes `wp_print_script_tag`, takže pluginy
  s CSP mu přidají nonce; přísná CSP bez nich musí povolit `script-src` a `connect-src` pro tracker.
  Vypnutí: `define('KLICENKA_TRAFFIC', false);`.

Nový soubor přidá až samoaktualizace, která už běží s jeho verzí `klicenka.php` (web na 1.6.0 tedy dostane
`klicenka-mereni.php` druhým během po aktualizaci na 1.7.0). V balíčku pluginu (`inc/`) je načte `klicenka.php`.

## Verze

Balíček npm a pluginy pro WordPress mají **vlastní, nezávislá čísla verzí**:

- **npm balíček** (`@mypixel/klicenka`, JS adaptéry v `src/` → `dist/`) – verze v `package.json`,
  tagy `vX.Y.Z` (např. `v1.2.0`). Zvyšuje se jen při změně kódu balíčku.
- **WordPress mu-plugin** (`wordpress/klicenka/klicenka.php`) – verze v hlavičce `Version:`
  a v `KLICENKA_PLUGIN_VERSION`, tagy `wp-X.Y.Z` (např. `wp-1.4.1`).
- **Doplňky pro WordPress** (`klicenka-stav`, `klicenka-upravy`, `klicenka-udrzba`, `klicenka-overeni`,
  `klicenka-mereni`) – každý má verzi
  ve své hlavičce, zatím bez tagů.

## Údržba WordPressu a záloha mimo hosting (`klicenka-udrzba` 0.3.0)

Pasivní doplněk: dělá jen to, co nese podepsaný token z trackeru (typ `klicenka-udrzba+jwt`, scope `udrzba`, 60 s,
jednorázový, akce = endpoint). Zálohy na hostingu (`wp-content/klicenka-zalohy/<náhodná složka>/<id>/`: `db.sql.gz`,
`soubory.zip` a u velkých záloh další části `soubory-002.zip`, …), aktualizace s návratem při chybě, obnova.

- **Záloha po krocích** (`zaloha` s `req.krok`): každé volání pracuje nejvýš `req.budget` s (výchozí 25) a uloží stav
  do `<id>/job.json`; další volání pokračuje. Databáze se píše po dávkách (každý krok = další gzip člen), soubory
  se nejdřív sepíší a pak balí do částí zipu, které se po zavření už neotvírají — gigabajty médií tak projdou i na
  hostingu s limitem PHP 30–60 s. Fotky a jiné zkomprimované soubory se do zipu jen ukládají. Mezipaměti a zálohy
  jiných pluginů v uploads se vynechávají (filtr `klicenka_udrzba_vynechat_uploads`).
- **Celý web (0.3.0):** databáze = všechny tabulky webu, i bez prefixu (kromě tabulek jiné instalace WordPressu
  ve stejné databázi), pohledy bez DEFINER; soubory = `plugins/`, `themes/`, `uploads/` + `wp-content/` (zbytek
  wp-content: mu-plugins, languages, fonts, drop-iny…, bez mezipamětí a záloh, filtr `klicenka_udrzba_vynechat_ostatni`)
  + `koren/` (kořen webu bez `wp-admin`/`wp-includes`: `wp-config.php`, `.htaccess`, ověřovací soubory, další složky;
  podsložka s vlastním `wp-config.php` = jiný web, vynechá se) + `nad-korenem/wp-config.php`, když leží o složku výš.
  Obnova z trackeru vrací dál jen plugins/themes/uploads a databázi; zbytek je pro obnovu od nuly (README Záloh).
  Manifest navíc: `roots`, `wpConfig`, `db.perTable` (řádky po tabulkách), `db.otherInstalls`, `filesInfo.unreadable`.
- **Stažení** (`stahnout`, GET): jeden soubor hotové zálohy podle `req.backup` + `req.file`, s HTTP Range (206).
- **Uvolnění** (`uvolnit`): záloha je mimo hosting → označí se a smažou se starší místní zálohy s médii, které už
  mimo hosting jsou. Nejnovější záloha zůstává vždy.
- Test: `node wordpress/klicenka-udrzba/test/run.mjs` (WP Playground, i `PHP_VERSION=7.4`).

Číslo WordPress pluginu (1.4.x) tedy neznamená, že existuje npm verze 1.4.

## Rychlý start (Next.js, vlastní session)

```ts
// app/klicenka/login/route.ts
import { createJtiStore, redirectWithCookie } from "@mypixel/klicenka";
import { klicenkaLogin } from "@mypixel/klicenka/next";

export const POST = klicenkaLogin({
  issuer: process.env.KLICENKA_ISSUER!,          // https://tracker.mypixel.cz
  audience: process.env.KLICENKA_AUDIENCE!,      // identifikátor webu z trackeru
  environment: process.env.KLICENKA_ENVIRONMENT as "production",
  jtiStore: createJtiStore({ insert: (jti, exp) => db.klicenkaJti.create({ data: { jti, expiresAt: exp } }).then(() => true) }),
  findAccount: (sub) => db.admin.findUnique({ where: { email: sub } }),
  startSession: async ({ user, maxAgeSeconds }) =>
    redirectWithCookie("/admin", { name: "session", value: await createSession(user, maxAgeSeconds), maxAgeSeconds }),
});
```

## Vývoj

```bash
npm install
npm test          # jednotkové testy
npm run build     # dist/ (je v repozitáři, aby šel balíček instalovat přímo z GitHubu)
```

### Průchod v prohlížeči

Potřebuje lokální Project Tracker s testovací databází a testovací weby z `examples/`:

1. Tracker (`~/projekty/project-tracker`) s vlastní databází a seedem spusťte na :3300 s `NEXTAUTH_URL`, `KLICENKA_ISSUER` a `WEBAUTHN_ORIGINS` = `http://localhost:3300`.
2. Weby spusťte s `KLICENKA_ISSUER=http://localhost:3300`:
   - `examples/cookie-site` na :3101,
   - `examples/nextauth4-site` na :3102 s `NEXTAUTH_URL=http://127.0.0.1:3102`,
   - `examples/nextauth5-site` na :3103,
   - `examples/supabase-site` na :3104. Potřebuje `supabase start` v jeho složce, má vlastní porty 554xx, a uživatele `admin@example.test`.
3. WordPress spusťte příkazem `npx @wp-playground/cli server --port=3105 --mount=$PWD/mu-plugins:/wordpress/wp-content/mu-plugins --blueprint=blueprint.json` ve složce `examples/wordpress`. Do `mu-plugins` předtím zkopírujte `wordpress/klicenka/klicenka.php`.
4. Spusťte průchod. Údaje jsou testovací účet ze seedu lokálního trackeru:
   ```bash
   E2E_EMAIL=… E2E_PASSWORD=… node e2e/run.mjs cookie nextauth4 nextauth5 supabase wordpress
   ```

Skript přidá virtuální passkey přes CDP a přihlásí se do trackeru. Pak založí web s jedním použitelným a jedním skrytým účtem, klikne na „Přihlásit se“ a ověří přistání v administraci. Nakonec zkusí stejný token poslat znovu.

V Chromiu to jde automaticky. Safari virtuální passkey nemá, tam se průchod dělá ručně s Touch ID.

## Licence

MIT
