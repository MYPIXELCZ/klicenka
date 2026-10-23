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
