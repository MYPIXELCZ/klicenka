# Zapojení Klíčenky do webu

Klíčenka přihlašuje z Project Trackeru do administrace webu jedním klikem. Tracker po ověření passkey vydá token a prohlížeč ho pošle metodou POST na web. Tento balíček je přijímací strana. Běžné přihlášení heslem zůstává beze změny.

## Jak to funguje

1. V trackeru je web s **identifikátorem** (např. `kozi-pelisek`) a **prostředím** (production / preview / local). Token má adresáta `kozi-pelisek@production`, takže token pro produkci na náhledu neprojde.
2. Kliknutí na „Přihlásit se“ vyžádá passkey (Touch ID). Podpis ověří **server** trackeru.
3. Tracker podepíše token Ed25519 (EdDSA) platný nejvýš 60 s, s jednorázovým `jti` a `kid` v hlavičce:
   - `iss` = adresa trackeru, `aud` = `<identifikátor>@<prostředí>`
   - `sub` = účet na webu (e-mail nebo uživatelské jméno, jak je zadané v trackeru)
   - `act` = skutečný člověk (`sub`, `name`, `email` z trackeru)
   - `sh` = kolik hodin má platit session na webu (výchozí 8)
4. Prohlížeč token odešle skrytým formulářem na `POST <web>/klicenka/login` (WordPress: `wp-login.php?action=klicenka`). Nikdy v URL. Weby s verzí ≥ 1.2 dostanou místo formuláře obyčejný odkaz `GET <web>/klicenka/otevrit?k=…` (WordPress: `wp-admin/admin-ajax.php?action=klicenka_otevrit&k=…`; tvar `…/login?code=…` Safari kvůli heuristice OAuth drží v aplikaci) s jednorázovým kódem na 60 s (jen tak se web z nainstalované aplikace trackeru otevře v Safari); web si za kód vyzvedne token z trackeru (`POST /api/klicenka/handoff`) a dál ověřuje stejně. Web proto potřebuje i route `/klicenka/otevrit` s `GET`.
5. Web ověří podpis přes `https://tracker.mypixel.cz/.well-known/jwks.json`, vydavatele, adresáta, platnost a nepoužité `jti`. Pak přihlásí **přesně** účet ze `sub`, zapíše `act` do logu a přesměruje do administrace. Když účet neexistuje, přihlášení odmítne. Nikdy nepřihlásí „prvního admina“.

Rotace klíče v trackeru (nový `kid`) zneplatní všechny dříve vydané tokeny najednou. Weby si JWKS samy obnoví.

## Instalace balíčku

```bash
npm install https://github.com/MYPIXELCZ/klicenka/archive/refs/tags/v1.2.0.tar.gz
```

Balíček je veřejný a neobsahuje nic tajného. Instaluje se jako tarball konkrétní verze, takže lockfile má https adresu s kontrolním součtem. Na Vercelu nepotřebuje token ani git. Zápis `github:…` nepoužívejte, npm by do lockfilu uložil `git+ssh` a build bez SSH klíče by selhal.

Proměnné prostředí webu (Vercel → Settings → Environment Variables):

| Proměnná | Production | Preview |
|---|---|---|
| `KLICENKA_ISSUER` | `https://tracker.mypixel.cz` | `https://tracker.mypixel.cz` |
| `KLICENKA_AUDIENCE` | identifikátor z trackeru | stejný |
| `KLICENKA_ENVIRONMENT` | `production` | `preview` |

V trackeru pak pro náhled založte druhý záznam se stejným identifikátorem a prostředím „Náhled“.

## Tabulka pro použitá jti

Produkce musí mít jti ve sdílené databázi. `MemoryJtiStore` je jen pro testy, na serverless by token šel použít v jiné instanci znovu.

**Prisma:**

```prisma
model KlicenkaJti {
  jti       String   @id
  expiresAt DateTime
  @@index([expiresAt])
}
```

```ts
import { createJtiStore } from "@mypixel/klicenka";
export const jtiStore = createJtiStore({
  insert: (jti, expiresAt) => prisma.klicenkaJti.create({ data: { jti, expiresAt } }).then(() => true),
  cleanup: (now) => prisma.klicenkaJti.deleteMany({ where: { expiresAt: { lt: now } } }),
});
```

**Supabase / Postgres:**

```sql
create table if not exists public.klicenka_jti (jti text primary key, expires_at timestamptz not null);
alter table public.klicenka_jti enable row level security; -- bez policy: jen service role
create index if not exists klicenka_jti_expires_at on public.klicenka_jti (expires_at);
```

Duplicitní klíč znamená opakovaný token, web pak hlásí „už byl použit“. Jiná chyba databáze, třeba chybějící tabulka nebo grant, se hlásí zvlášť: „Web nemůže ověřit jednorázovost přihlášení“. Podrobnosti jsou v logu jako `[klicenka] jti store failed`. Když databáze hlásí duplicitu jinak než Prisma (`P2002`) nebo Postgres (`23505`), předejte `isDuplicate`.

## Adaptér 1: vlastní cookie session (jose / bcrypt)

Weby: 88real, kozi-pelisek, barvypp, faktury-portal a další s vlastním přihlášením.

```ts
// app/klicenka/login/route.ts
import { redirectWithCookie } from "@mypixel/klicenka";
import { klicenkaLogin } from "@mypixel/klicenka/next";
import { jtiStore } from "@/lib/klicenka-jti";
import { createSessionToken, SESSION_COOKIE } from "@/lib/auth"; // existující funkce webu

export const POST = klicenkaLogin({
  issuer: process.env.KLICENKA_ISSUER!,
  audience: process.env.KLICENKA_AUDIENCE!,
  environment: process.env.KLICENKA_ENVIRONMENT as "production" | "preview",
  jtiStore,
  findAccount: (sub) => prisma.admin.findUnique({ where: { email: sub } }),
  startSession: async ({ user, maxAgeSeconds }) =>
    redirectWithCookie("/admin", { name: SESSION_COOKIE, value: await createSessionToken(user, maxAgeSeconds), maxAgeSeconds }),
  log: (e) => console.info("[klicenka]", JSON.stringify(e)), // nebo zápis do audit tabulky webu
});
// app/klicenka/otevrit/route.ts — odkaz s jednorázovým kódem (z nainstalované aplikace trackeru do Safari)
// export { POST as GET } from "../login/route";

// app/klicenka/status/route.ts
import { klicenkaStatus } from "@mypixel/klicenka/next";
export const GET = klicenkaStatus("cookie");
```

Pokud middleware webu chrání všechno, pusťte `/klicenka/*` bez přihlášení.

**Pages Router:** handler patří pod `pages/api/klicenka/login.ts` jako `export default toPagesHandler(klicenkaLogin({...}))` a do `next.config` přijde přesměrování:

```ts
async rewrites() { return [{ source: "/klicenka/:path*", destination: "/api/klicenka/:path*" }]; }
```

## Adaptér 2: Supabase Auth

Weby, které opravdu používají Supabase Auth (`signInWithPassword`, `@supabase/ssr`), třeba kinktelier, reviewboost a revitest-system. Pozor: některé weby ze seznamu mají Supabase jen jako databázi a přihlášení vlastní. Ty patří k adaptéru 1.

```ts
// app/klicenka/login/route.ts
import { supabaseKlicenka } from "@mypixel/klicenka/supabase";
export const POST = supabaseKlicenka({
  issuer: process.env.KLICENKA_ISSUER!,
  audience: process.env.KLICENKA_AUDIENCE!,
  environment: process.env.KLICENKA_ENVIRONMENT as "production" | "preview",
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL!,
  anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  redirectTo: "/admin",
  allow: (user) => user.app_metadata?.role === "admin", // volitelně
});
```

`sub` je e-mail nebo id uživatele v Supabase. Služební klíč vytvoří jednorázový odkaz pro přesně tohoto uživatele a uplatní ho na serveru. Prohlížeč dostane běžnou session, nic se neposílá e-mailem.

Supabase řídí délku své session sám. Kratší limit Klíčenky nese cookie `klicenka_until`. Ta schválně žije 30 dní a o konci rozhoduje hodnota uvnitř. Hlídejte ji v middleware:

```ts
import { klicenkaSessionExpired, UNTIL_COOKIE } from "@mypixel/klicenka/supabase";
if (klicenkaSessionExpired(req.cookies.get(UNTIL_COOKIE)?.value)) { /* supabase.auth.signOut() a přesměrovat na login */ }
```

Po běžném přihlášení heslem a po odhlášení limit smažte: `response.headers.append("Set-Cookie", clearUntilCookie())`. Jinak by limit ukončil i session přihlášenou heslem.

## Adaptér 3: NextAuth v4 (i Pages Router) a v5

Weby: damsito (v4, Pages Router), zvladneme (v5).

```ts
import Credentials from "next-auth/providers/credentials";
import { klicenkaJwt, klicenkaProvider, klicenkaSessionValid } from "@mypixel/klicenka/next-auth";

providers: [
  klicenkaProvider(Credentials, {
    issuer: process.env.KLICENKA_ISSUER!, audience: process.env.KLICENKA_AUDIENCE!,
    environment: process.env.KLICENKA_ENVIRONMENT as "production" | "preview",
    jtiStore,
    findUser: (sub) => prisma.user.findUnique({ where: { email: sub } }),
  }),
  // …stávající poskytovatelé
],
session: { strategy: "jwt" },
callbacks: {
  jwt: ({ token, user }) => klicenkaJwt(token, user),
  session: ({ session, token }) => klicenkaSessionValid(token) ? session : { ...session, user: undefined },
},
```

Přijímací stránka předá token callbacku NextAuth formulářem POST s jeho CSRF tokenem:

```ts
// App Router: app/klicenka/login/route.ts
import { nextAuthReceiver } from "@mypixel/klicenka/next-auth";
export const POST = nextAuthReceiver({ redirectTo: "/admin", issuer: process.env.KLICENKA_ISSUER });
export const GET = POST;

// Pages Router: pages/api/klicenka/login.ts + rewrite /klicenka → /api/klicenka (viz výše)
export default toPagesHandler(nextAuthReceiver({ redirectTo: "/admin" }));
```

Přijímací stránka používá krátký inline skript. Když má web přísné CSP, předejte `nonce`.

## Adaptér 4: WordPress

1. Soubor `wordpress/klicenka/klicenka.php` z tohoto repozitáře nahrajte do `wp-content/mu-plugins/`.
2. Do `wp-config.php` přidejte:
   ```php
   define('KLICENKA_AUDIENCE', 'identifikator-webu');
   define('KLICENKA_ENVIRONMENT', 'production');
   ```
3. V trackeru zvolte typ „WordPress“. `sub` je uživatelské jméno nebo e-mail ve WordPressu.

Plugin potřebuje PHP s rozšířením sodium, standardně od PHP 7.2. Musí mít také odchozí HTTP na tracker kvůli JWKS. Pokud bezpečnostní plugin přejmenoval `wp-login.php`, je potřeba ho pro `action=klicenka` povolit. Skutečný člověk se zapisuje do PHP logu a do volby `klicenka_log`. Ostatní pluginy můžou použít akci `klicenka_login`.

## Přidání webu v trackeru

1. Klíčenka → Přidat web. Zadejte adresu, komu web patří, volitelně klienta nebo projekt a účet na webu (`sub`, předvyplněný vaším e-mailem).
2. Tracker se při uložení zeptá webu na stav a převezme z něj typ, identifikátor a prostředí. Web bez Klíčenky se uloží jako externí služba (odkaz a údaje z trezoru).
3. V detailu webu jde stav kdykoli ověřit znovu („Ověřit“) a doplnit další účty, délku přihlášení nebo poznámku. Když web hlásí jiný identifikátor nebo prostředí, než má tracker uložené, ukáže to.
4. Klikněte na „Přihlásit se“.

## Kontrola po nasazení

- [ ] `curl https://web/klicenka/status` vrátí `{"name":"klicenka","version":"1.x",…}`.
- [ ] Přihlášení z trackeru skončí v administraci za správný účet.
- [ ] Druhé odeslání stejného tokenu web odmítne s hláškou „už byl použit“.
- [ ] Token z produkce na náhledu neprojde.
- [ ] Log webu obsahuje skutečného člověka (`act`).
- [ ] Běžné přihlášení heslem funguje dál.

## Šablony v ~/projekty/templates

Samostatný krok po zapojení skutečných webů. Do každé šablony s administrací se přidá:

1. závislost `github:MYPIXELCZ/klicenka#v1.x`,
2. `app/klicenka/login/route.ts` a `app/klicenka/status/route.ts` podle adaptéru šablony,
3. tabulka pro jti v migracích šablony,
4. tři proměnné `KLICENKA_*` do `.env.example` a do předávacího dokumentu šablony (`HANDOFF-SABLONY.md`),
5. řádek do kontrolního seznamu nasazení: založit web v Klíčence a ověřit stav.

Nový web ze šablony tak bude mít Klíčenku hned od prvního nasazení.

## Testy

- Jednotkové: `npm test`. Pokrývají vypršelý, použitý, cizí adresát, cizí prostředí, špatný podpis, neznámý kid, cizí vydavatel, příliš dlouhá platnost, jiný algoritmus a chybějící účet.
- V prohlížeči: `e2e/run.mjs` proti lokálnímu trackeru s virtuálním passkey a testovacím webům v `examples/` (vlastní cookie, NextAuth v4/v5, Supabase, WordPress přes `@wp-playground/cli`). Postup je v README.
