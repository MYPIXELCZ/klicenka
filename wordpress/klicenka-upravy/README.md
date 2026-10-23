# Klíčenka – úpravy Claudem (`klicenka-upravy.php`)

Mu-plugin pro WordPress, přes který spouštěč úprav (Claude Code na Macu) mění **jen kopii stránky (koncept)**.
Na živou stránku se změna dostane jen tokenem `publish`. Ten vydá tracker, až člověk klikne na *Schválit a nasadit*.
Funguje s Elementorem i s Gutenbergem (případně s klasickým editorem jako jedním blokem).

## Zapojení

1. Do `wp-content/mu-plugins/` nahrajte `klicenka.php` (**verze 1.3.0 a novější**) a vedle něj `klicenka-upravy.php`.
2. Konfigurace je stejná jako u Klíčenky (`KLICENKA_AUDIENCE`, `KLICENKA_ENVIRONMENT`, případně `KLICENKA_ISSUER`) ve `wp-config.php`.
   Volitelně:
   ```php
   define('KLICENKA_UPRAVY_MAX_UPLOAD', 5 * 1024 * 1024); // největší obrázek v bajtech (výchozí 5 MB)
   define('KLICENKA_UPRAVY_POST_TYPES', 'page');          // typy obsahu, čárkou (výchozí jen stránky)
   ```
3. Kontrola: `GET /wp-json/klicenka-upravy/v1/status` vrátí verzi pluginu, verzi Klíčenky a to, zda běží Elementor.

Uživatel `claude-upravy` a role `claude_upravy` vzniknou samy při prvním volání s platným tokenem.

## Token

Hlavička JWT: `alg: EdDSA`, `typ: klicenka-upravy+jwt`, `kid`. Podepisuje se stejným klíčem trackeru jako přihlašovací token (JWKS).
Claimy: `iss`, `aud` (`<web>@<prostředí>`), `sub`, `jti`, `iat`, `exp`, `act` (`sub`, `email`, `name`, tedy kdo požadavek spustil) a navíc:

| claim | význam |
|---|---|
| `scope` | `drafts` (spouštěč, nejvýš 15 min, jde použít opakovaně) nebo `publish` (tracker po kliknutí, nejvýš 60 s, jednorázový) |
| `req` | id požadavku (`[A-Za-z0-9_-]`, nejvýš 64 znaků) |
| `post` | id originální stránky (u `GET pages` může chybět) |

Token se posílá v hlavičce `Authorization: Bearer …`. Když ji hosting zahazuje (Hostinger), jde i `X-Klicenka-Token: …`.
V URL se nikdy nečte. Díky jinému `typ` přihlašovací token nefunguje tady a token pro úpravy nepřihlásí přes `wp-login.php`.

## Endpointy (`/wp-json/klicenka-upravy/v1/`)

| Metoda a cesta | scope | Co dělá |
|---|---|---|
| `GET status` | bez tokenu | verze, nic citlivého |
| `GET pages?search=&page=` | drafts | zveřejněné stránky (id, název, odkaz, editor, šablona), bez obsahu |
| `POST pages/{id}/duplicate` | drafts | koncept „[Úprava #req] Název“ se všemi meta (`_elementor_data`, `_elementor_page_settings`, `_elementor_edit_mode`, `_wp_page_template`, SEO…) bajt po bajtu. Opakované volání vrátí stejný koncept |
| `GET drafts/{id}/outline` | drafts | zhuštěný strom: id, typ, zkrácené texty (s cestou ke klíči, např. `icon_list.1.text`), odkazy, obrázky. `?ids=a,b` vrátí plné nastavení vybraných prvků |
| `PATCH drafts/{id}/elements` | drafts | `[{id, settings}]`, viz níže. Atomicky: neznámé id = 422 a nic se nezmění |
| `POST drafts/{id}/media` | drafts | multipart `file` (+ volitelně `alt`), jen JPEG/PNG/GIF/WebP (kontroluje se obsah souboru, ne přípona), limit velikosti, bez SVG |
| `GET drafts/{id}/preview-link` | drafts | veřejný náhled konceptu na 23 h (`?page_id=…&klicenka_nahled=<exp>.<hmac>`), `noindex`, bez cache, `no-referrer` |
| `POST drafts/{id}/publish` | publish | záloha originálu (vlastní meta, poslední 3) + revize WP, přepis obsahu, výtahu a meta z konceptu, přegenerování CSS Elementoru, obrázky konceptu se přesunou k originálu, koncept do koše. Když se originál mezitím změnil: 409, přepsat jde s `{"force": true}` |
| `POST pages/{id}/rollback` | publish | obnoví poslední zálohu, jen když patří stejnému `req` (jinak 409) |

Název, adresa, autor, stav a šablona originálu zůstávají. Když hosting blokuje `PATCH`, jde `POST` s hlavičkou `X-HTTP-Method-Override: PATCH`.

**Elementor `settings`:** sloučí se do nastavení prvku. Vnořená pole se slučují po klíčích, opakovače po indexech
(`{"icon_list": {"1": {"text": "…"}}}` změní jen druhou položku). `null` klíč odebere.
**Gutenberg `settings`:** `attrs` (sloučí se do atributů bloku), `html` (nahradí HTML listového bloku),
`replace: [{from, to}]` (nahradí text v bloku, nenalezený text = 422). Id bloku je cesta indexů z `outline`, např. `4.0`.

Hodnoty od Clauda projdou `wp_kses_post` a odkazy (`url`, `href`, `link`) projdou `esc_url_raw`, takže `<script>` ani `javascript:` neprojdou.
Kopie a publikace samy obsah nefiltrují, aby se nerozbilo to, co na stránku dal administrátor (iframe, vlastní HTML).

## Bezpečnost

- Každé volání ověřuje podpis přes JWKS trackeru, vydavatele, adresáta i prostředí, platnost a `scope` (to všechno dělá `klicenka_verify`).
- Koncept smí měnit jen token se shodným `req` a `post`. Koncept musí být ve stavu draft a jeho autorem musí být `claude-upravy`. Originál musí být id z tokenu.
  Žádný endpoint nesáhne na jinou stránku. Jiné id vrátí 403 nebo 404.
- Role `claude_upravy` má jen `read`, `edit_pages`, `edit_posts` a `upload_files`. Nemá `publish_*`, `edit_others_*`, `edit_published_*`,
  `manage_options`, `install_plugins`, `edit_users`, `edit_theme_options` ani `unfiltered_html`.
  Při každém volání se účtu vrátí právě tato role. Oprávnění, která mu někdo přidal ručně, se odeberou.
  Heslem ani aplikačním heslem se účet nepřihlásí.
- Publikaci a návrat dělá plugin sám pod tokenem `publish`, ne pod právy role.
- Log: option `klicenka_upravy_log` (posledních 500 záznamů) a řádek `[klicenka-upravy]` v PHP logu. Obsahuje čas, akci, `req`, stránku, koncept, kdo (`act.email`) a IP. Tokeny se nelogují.
- Odpovědi API mají `Cache-Control: no-store`.

## Test

```bash
node wordpress/klicenka-upravy/test/run.mjs                 # Playground + Elementor z wordpress.org
node wordpress/klicenka-upravy/test/run.mjs --no-elementor  # jen WordPress
```

Skript vytvoří testovací klíč Ed25519 jen v paměti a JWKS servíruje na `127.0.0.1:3399`. Pak spustí WP Playground na `:3105`
s `klicenka.php`, tímto pluginem a `test/test-helper.php`, projde celý postup a nakonec všechno zastaví a smaže.
`test-helper.php` vystavuje nechráněný ladicí endpoint, proto **nikdy nesmí na skutečný web**.
