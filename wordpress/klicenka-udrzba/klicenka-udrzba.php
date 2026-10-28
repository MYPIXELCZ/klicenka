<?php
/**
 * Plugin Name: Klíčenka – údržba webu
 * Description: Zálohy a bezpečné aktualizace WordPressu, pluginů a šablon na pokyn z Project Trackeru (MYPIXEL). Bez platného podepsaného tokenu nedělá nic.
 * Version: 0.3.0
 * Requires PHP: 7.4
 * License: MIT
 *
 * Patří do wp-content/mu-plugins/ vedle klicenka.php (1.3+), jehož konfiguraci a klíče (JWKS trackeru) používá.
 * Je PASIVNÍ: žádný cron, žádné háčky při běžném zobrazení webu. Pracuje jen na podepsaný pokyn:
 *   token typ "klicenka-udrzba+jwt", scope "udrzba", nejvýš 60 s, jednorázové jti, claim "akce" = endpoint,
 *   parametry v podepsaném claimu "req" (tělo požadavku se nečte). Posílá se v "Authorization: Bearer …".
 *
 * Endpointy (?rest_route=/klicenka-udrzba/v1/…):
 *   POST zaloha       – záloha DB (.sql.gz: tabulky webu i bez prefixu, pohledy) a souborů (soubory.zip): plugins, themes,
 *                       uploads (jen na přání), ostatní wp-content (mu-plugins, languages, …), soubory v kořeni webu
 *                       (wp-config.php, .htaccess, …; od 0.3.0, kvůli obnově od nuly — obnova z trackeru je nevrací);
 *                       s req.krok po krocích (každé volání pracuje nejvýš req.budget s, stav v <id>/job.json, další volání
 *                       pokračuje) — tak projdou i gigabajty médií na hostingu s limitem PHP 30–60 s
 *   POST aktualizace  – pro každou položku: čerstvá záloha (≤ 1 h), kopie položky, aktualizace, kontrola webu, při chybě návrat
 *   POST obnova       – obnova DB a/nebo souborů ze zálohy (token musí nést confirm "obnovit:<id>")
 *   GET  zalohy       – seznam záloh, rozpracované zálohy po krocích a posledních akcí
 *   GET  stahnout     – jeden soubor hotové zálohy (req.backup, req.file), s HTTP Range pro navázání přerušeného stahování
 *   POST uvolnit      – záloha req.backup je uložená mimo hosting: označí ji a smaže místní zálohy s médii, které už
 *                       mimo hosting jsou, kromě nejnovější zálohy (ta zůstává pro rychlý návrat)
 *
 * Zálohy leží v wp-content/klicenka-zalohy/<náhodný název>/ (+ .htaccess, index.php), drží se poslední 3. Soubory jsou
 * v soubory.zip a u velkých záloh v dalších částech soubory-002.zip, soubory-003.zip, …
 * Vypnout úplně: define('KLICENKA_UDRZBA', false);
 */

if (!defined('ABSPATH')) {
    exit;
}
if (defined('KLICENKA_UDRZBA_VERSION')) {
    return; // načteno podruhé (mu-plugins i plugin)
}

define('KLICENKA_UDRZBA_VERSION', '0.3.0');
define('KLICENKA_UDRZBA_TYP', 'klicenka-udrzba+jwt');
/** Kolik hotových záloh nechat. */
define('KLICENKA_UDRZBA_KEEP', 3);
/** Jak stará smí být záloha, aby se před aktualizací nedělala nová (s). */
define('KLICENKA_UDRZBA_FRESH', 3600);
/** Nejvyšší velikost (B) a počet souborů jedné části zálohy souborů (zipu). */
define('KLICENKA_UDRZBA_PART_MAX', 512 * 1048576);
define('KLICENKA_UDRZBA_PART_FILES', 10000);
/** Záloha po krocích, na kterou nikdo nesáhl déle (s), je opuštěná (nedokončené složky smaže prune po dni). */
define('KLICENKA_UDRZBA_JOB_STALE', 1200);

// ---------------------------------------------------------------------------
// Pomocné
// ---------------------------------------------------------------------------

function klicenka_udrzba_error($code, $message, $status = 500)
{
    return new WP_Error($code, $message, array('status' => $status));
}

function klicenka_udrzba_respond($data, $status = 200)
{
    $r = new WP_REST_Response($data, $status);
    $r->header('Cache-Control', 'no-store');
    return $r;
}

function klicenka_udrzba_fail(WP_Error $e)
{
    $data = $e->get_error_data();
    $status = (is_array($data) && isset($data['status'])) ? (int) $data['status'] : 500;
    return klicenka_udrzba_respond(array('ok' => false, 'error' => $e->get_error_code(), 'message' => $e->get_error_message()), $status);
}

/** Delší běh: bez limitu tam, kde to hosting dovolí; přerušené spojení z trackeru běh nezastaví (dokončí se i návrat). */
function klicenka_udrzba_long_run()
{
    if (function_exists('ignore_user_abort')) {
        @ignore_user_abort(true);
    }
    $disabled = array_map('trim', explode(',', (string) ini_get('disable_functions')));
    if (function_exists('set_time_limit') && !in_array('set_time_limit', $disabled, true)) {
        @set_time_limit(0);
    }
    if (function_exists('wp_raise_memory_limit')) {
        wp_raise_memory_limit('admin');
    }
}

/** Zbývající čas běhu v sekundách (null = bez limitu). */
function klicenka_udrzba_time_left()
{
    static $start = null;
    if ($start === null) {
        $start = isset($_SERVER['REQUEST_TIME_FLOAT']) ? (float) $_SERVER['REQUEST_TIME_FLOAT'] : microtime(true);
    }
    $max = (int) ini_get('max_execution_time');
    if ($max <= 0) {
        return null;
    }
    return $max - (microtime(true) - $start);
}

/** Bezpečná rezerva: když dochází čas, raději skončit chybou (a uklidit), než nechat napůl hotovou práci. */
function klicenka_udrzba_check_time($reserve = 20)
{
    $left = klicenka_udrzba_time_left();
    if ($left !== null && $left < $reserve) {
        return klicenka_udrzba_error('timeout', 'Hostingu dochází čas na běh PHP, akce přerušena a uklizena.', 504);
    }
    return true;
}

function klicenka_udrzba_rmdir($path)
{
    if (is_link($path) || is_file($path)) {
        return @unlink($path);
    }
    if (!is_dir($path)) {
        return true;
    }
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($path, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
    foreach ($it as $f) {
        if ($f->isLink() || !$f->isDir()) {
            @unlink($f->getPathname());
        } else {
            @rmdir($f->getPathname());
        }
    }
    return @rmdir($path);
}

/** Kopie souboru nebo složky (odkazy jako odkazy). @return true|WP_Error */
function klicenka_udrzba_copy($src, $dst)
{
    if (is_link($src)) {
        return @symlink(readlink($src), $dst) ? true : klicenka_udrzba_error('copy', 'Kopie se nepodařila.');
    }
    if (is_file($src)) {
        if (!is_dir(dirname($dst)) && !wp_mkdir_p(dirname($dst))) {
            return klicenka_udrzba_error('copy', 'Kopie se nepodařila (složka).');
        }
        return @copy($src, $dst) ? true : klicenka_udrzba_error('copy', 'Kopie souboru se nepodařila.');
    }
    if (!is_dir($src)) {
        return klicenka_udrzba_error('copy', 'Zdroj kopie neexistuje.');
    }
    if (!is_dir($dst) && !@mkdir($dst, 0755, true)) {
        return klicenka_udrzba_error('copy', 'Kopie se nepodařila (složka).');
    }
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($src, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::SELF_FIRST);
    $len = strlen(rtrim($src, '/')) + 1;
    foreach ($it as $f) {
        $rel = substr($f->getPathname(), $len);
        $to = $dst . '/' . $rel;
        if ($f->isLink()) {
            if (!@symlink(readlink($f->getPathname()), $to)) {
                return klicenka_udrzba_error('copy', 'Kopie odkazu se nepodařila: ' . $rel);
            }
        } elseif ($f->isDir()) {
            if (!is_dir($to) && !@mkdir($to, 0755)) {
                return klicenka_udrzba_error('copy', 'Kopie složky se nepodařila: ' . $rel);
            }
        } elseif (!@copy($f->getPathname(), $to)) {
            return klicenka_udrzba_error('copy', 'Kopie souboru se nepodařila: ' . $rel);
        }
    }
    return true;
}

/** Velikost složky v bajtech (odkazy se nepočítají). */
function klicenka_udrzba_dir_size($dir)
{
    if (is_file($dir)) {
        return (int) filesize($dir);
    }
    if (!is_dir($dir)) {
        return 0;
    }
    $size = 0;
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS));
    foreach ($it as $f) {
        if (!$f->isLink() && $f->isFile()) {
            $size += (int) $f->getSize();
        }
    }
    return $size;
}

/** Na disku musí zbýt místo (odhad + 50 MB rezervy), jinak záloha nezačne. */
function klicenka_udrzba_check_space($dir, $need)
{
    if (!function_exists('disk_free_space')) {
        return true;
    }
    $free = @disk_free_space($dir);
    if ($free === false) {
        return true;
    }
    if ($free < $need + 50 * 1024 * 1024) {
        return klicenka_udrzba_error('disk', sprintf('Na hostingu je málo místa (volno %s MB, potřeba asi %s MB).', round($free / 1048576), round(($need + 50 * 1048576) / 1048576)), 507);
    }
    return true;
}

// ---------------------------------------------------------------------------
// Úložiště: wp-content/klicenka-zalohy/<32 hex>/
// ---------------------------------------------------------------------------

function klicenka_udrzba_base()
{
    return WP_CONTENT_DIR . '/klicenka-zalohy';
}

function klicenka_udrzba_protect($dir)
{
    $files = array(
        '.htaccess'  => "# Klíčenka: zálohy nejsou ke stažení z webu.\n<IfModule mod_authz_core.c>\nRequire all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\nOrder allow,deny\nDeny from all\n</IfModule>\nOptions -Indexes\n",
        'index.php'  => "<?php\n// Tiché ticho.\nhttp_response_code(404);\n",
        'index.html' => '',
        'web.config' => "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<configuration><system.webServer><authorization><deny users=\"*\" /></authorization></system.webServer></configuration>\n",
    );
    foreach ($files as $name => $content) {
        if (!file_exists($dir . '/' . $name) && @file_put_contents($dir . '/' . $name, $content) === false) {
            return false;
        }
    }
    return true;
}

/** Kořen záloh s náhodným, neuhodnutelným názvem. @return string|WP_Error */
function klicenka_udrzba_root()
{
    static $root = null;
    if ($root !== null) {
        return $root;
    }
    $base = klicenka_udrzba_base();
    if (!is_dir($base) && !wp_mkdir_p($base)) {
        return klicenka_udrzba_error('write', 'Do wp-content nejde zapisovat (složka klicenka-zalohy).');
    }
    if (!klicenka_udrzba_protect($base)) {
        return klicenka_udrzba_error('write', 'Do složky klicenka-zalohy nejde zapisovat.');
    }
    $found = array();
    foreach ((array) scandir($base) as $name) {
        if (preg_match('/^[a-f0-9]{32}$/', (string) $name) && is_dir($base . '/' . $name)) {
            $found[] = $name;
        }
    }
    sort($found);
    if ($found) {
        $dir = $base . '/' . $found[0];
    } else {
        $dir = $base . '/' . bin2hex(random_bytes(16));
        if (!@mkdir($dir, 0755)) {
            return klicenka_udrzba_error('write', 'Složku pro zálohy nejde vytvořit.');
        }
    }
    klicenka_udrzba_protect($dir);
    foreach (array('tmp') as $sub) {
        if (!is_dir($dir . '/' . $sub)) {
            @mkdir($dir . '/' . $sub, 0755);
        }
    }
    $root = $dir;
    return $root;
}

/** Jediný běh naráz (zámek souborem, přežije i obnovu databáze). @return resource|WP_Error */
function klicenka_udrzba_lock($root)
{
    $h = @fopen($root . '/.lock', 'c');
    if (!$h) {
        return klicenka_udrzba_error('write', 'Zámek nejde vytvořit.');
    }
    if (!flock($h, LOCK_EX | LOCK_NB)) {
        fclose($h);
        return klicenka_udrzba_error('busy', 'Na webu už běží jiná údržba. Zkuste to za chvíli.', 409);
    }
    return $h;
}

/** Stav v souboru (použitá jti, poslední akce) — ne v databázi, aby ho obnova DB nevrátila. */
function klicenka_udrzba_state($root, $mutate = null)
{
    $path = $root . '/stav.json';
    $h = @fopen($path, 'c+');
    if (!$h) {
        return klicenka_udrzba_error('write', 'Stav údržby nejde uložit.');
    }
    flock($h, LOCK_EX);
    $raw = stream_get_contents($h);
    $state = json_decode((string) $raw, true);
    if (!is_array($state)) {
        $state = array();
    }
    $state += array('jti' => array(), 'runs' => array());
    $result = $state;
    if (is_callable($mutate)) {
        $result = call_user_func_array($mutate, array(&$state));
        ftruncate($h, 0);
        rewind($h);
        fwrite($h, wp_json_encode($state));
        fflush($h);
    }
    flock($h, LOCK_UN);
    fclose($h);
    return $result;
}

function klicenka_udrzba_log_run($root, $entry)
{
    klicenka_udrzba_state($root, function (&$s) use ($entry) {
        array_unshift($s['runs'], $entry);
        $s['runs'] = array_slice($s['runs'], 0, 20);
        return true;
    });
    error_log('[klicenka-udrzba] ' . wp_json_encode(array('akce' => $entry['akce'], 'ok' => $entry['ok'], 'by' => $entry['by'])));
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

function klicenka_udrzba_bearer(WP_REST_Request $request)
{
    $auth = (string) $request->get_header('authorization');
    if ($auth === '' && isset($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) {
        $auth = (string) $_SERVER['REDIRECT_HTTP_AUTHORIZATION'];
    }
    return preg_match('/^\s*Bearer\s+(\S+)\s*$/i', $auth, $m) ? $m[1] : '';
}

/** Ověřené claimy aktuálního požadavku (nastaví je kontrola oprávnění). */
function klicenka_udrzba_claims($set = null)
{
    static $claims = null;
    if ($set !== null) {
        $claims = $set;
    }
    return $claims;
}

/**
 * EdDSA podpis klíčem z JWKS trackeru (přes klicenka.php), typ klicenka-udrzba+jwt, náš issuer a audience,
 * nejvýš 60 s, scope "udrzba", akce = endpoint, jednorázové jti (soubor i transient). Přihlašovací ani jiný
 * token Klíčenky sem neprojde a tento token nic jiného neotevře.
 * @return true|WP_Error
 */
function klicenka_udrzba_authorize(WP_REST_Request $request, $akce)
{
    klicenka_udrzba_claims(false);
    if (!function_exists('klicenka_config') || !function_exists('klicenka_keys') || !function_exists('klicenka_b64url_decode') || !function_exists('sodium_crypto_sign_verify_detached')) {
        return klicenka_udrzba_error('config', 'Chybí klicenka.php v mu-plugins.', 500);
    }
    $deny = function ($why) {
        return klicenka_udrzba_error('unauthorized', $why, 401);
    };
    $token = klicenka_udrzba_bearer($request);
    if (!preg_match('/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/', $token)) {
        return $deny('Chybí token.');
    }
    list($h64, $p64, $s64) = explode('.', $token);
    $header = json_decode((string) klicenka_b64url_decode($h64), true);
    $payload = json_decode((string) klicenka_b64url_decode($p64), true);
    $sig = klicenka_b64url_decode($s64);
    if (!is_array($header) || !is_array($payload) || $sig === false || strlen($sig) !== SODIUM_CRYPTO_SIGN_BYTES) {
        return $deny('Token je poškozený.');
    }
    if (($header['alg'] ?? '') !== 'EdDSA' || ($header['typ'] ?? '') !== KLICENKA_UDRZBA_TYP || empty($header['kid'])) {
        return $deny('Token má neznámý formát.');
    }
    $kid = (string) $header['kid'];
    $keys = klicenka_keys();
    if (!isset($keys[$kid])) {
        $keys = klicenka_keys(true);
    }
    $pk = isset($keys[$kid]) ? klicenka_b64url_decode($keys[$kid]) : false;
    if ($pk === false || strlen($pk) !== SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES || !sodium_crypto_sign_verify_detached($sig, $h64 . '.' . $p64, $pk)) {
        return $deny('Podpis tokenu nesedí.');
    }
    $cfg = klicenka_config();
    $now = time();
    $tol = (int) $cfg['tolerance'];
    $aud = isset($payload['aud']) ? (array) $payload['aud'] : array();
    $exp = $payload['exp'] ?? null;
    $iat = $payload['iat'] ?? null;
    if (($payload['iss'] ?? '') !== $cfg['issuer'] || $cfg['audience'] === '' || !in_array($cfg['audience'] . '@' . $cfg['environment'], $aud, true)) {
        return $deny('Token není pro tento web.');
    }
    if (!is_int($exp) || !is_int($iat) || $exp + $tol < $now || $iat - $tol > $now || $exp - $iat > 60 || $exp <= $iat) {
        return $deny('Token vypršel.');
    }
    $act = $payload['act'] ?? null;
    if (empty($payload['jti']) || !is_string($payload['jti']) || !is_array($act) || empty($act['sub']) || empty($act['email'])) {
        return $deny('Token nemá potřebné údaje.');
    }
    if (($payload['scope'] ?? '') !== 'udrzba' || ($payload['akce'] ?? '') !== $akce) {
        return klicenka_udrzba_error('forbidden', 'Token nemá oprávnění pro tuto akci.', 403);
    }
    $req = isset($payload['req']) && is_array($payload['req']) ? $payload['req'] : array();
    if ($akce === 'obnova') {
        $id = isset($req['backup']) ? (string) $req['backup'] : '';
        if ($id === '' || ($payload['confirm'] ?? '') !== 'obnovit:' . $id) {
            return klicenka_udrzba_error('forbidden', 'Obnova potřebuje výslovné potvrzení v tokenu.', 403);
        }
    }

    // Jednorázovost: soubor (přežije obnovu DB) + transient (kdyby soubor nešel zapsat).
    $root = klicenka_udrzba_root();
    if (is_wp_error($root)) {
        return $root;
    }
    $hash = hash('sha256', (string) $payload['jti']);
    $tkey = 'klicenka_udrzba_jti_' . substr($hash, 0, 40);
    if (get_transient($tkey) !== false) {
        return $deny('Token už byl použit.');
    }
    $fresh = klicenka_udrzba_state($root, function (&$s) use ($hash, $now) {
        foreach ($s['jti'] as $k => $until) {
            if ($until < $now) {
                unset($s['jti'][$k]);
            }
        }
        if (isset($s['jti'][$hash])) {
            return false;
        }
        $s['jti'][$hash] = $now + 600;
        return true;
    });
    if ($fresh !== true) {
        return is_wp_error($fresh) ? $fresh : $deny('Token už byl použit.');
    }
    set_transient($tkey, 1, 600);
    $payload['req'] = $req;
    klicenka_udrzba_claims($payload);
    return true;
}

function klicenka_udrzba_actor()
{
    $c = klicenka_udrzba_claims();
    $act = is_array($c) && isset($c['act']) && is_array($c['act']) ? $c['act'] : array();
    return array('sub' => (string) ($act['sub'] ?? ''), 'email' => (string) ($act['email'] ?? ''), 'name' => isset($act['name']) ? (string) $act['name'] : null);
}

// ---------------------------------------------------------------------------
// Zálohy
// ---------------------------------------------------------------------------

function klicenka_udrzba_backup_id_ok($id)
{
    return is_string($id) && preg_match('/^\d{8}-\d{6}-[a-f0-9]{12}$/', $id);
}

/** Hotové zálohy, nejnovější první. */
function klicenka_udrzba_backups($root)
{
    $out = array();
    foreach ((array) scandir($root) as $name) {
        if (!klicenka_udrzba_backup_id_ok($name)) {
            continue;
        }
        $m = json_decode((string) @file_get_contents($root . '/' . $name . '/manifest.json'), true);
        if (is_array($m) && !empty($m['complete']) && ($m['id'] ?? '') === $name) {
            $out[] = $m;
        }
    }
    usort($out, function ($a, $b) {
        $d = (float) ($b['createdTs'] ?? 0) <=> (float) ($a['createdTs'] ?? 0);
        return $d !== 0 ? $d : strcmp($b['id'], $a['id']);
    });
    return $out;
}

/** Nechá posledních KLICENKA_UDRZBA_KEEP hotových záloh (+ $keep), smaže nedokončené starší než den. */
function klicenka_udrzba_prune($root, $keep = '')
{
    $list = klicenka_udrzba_backups($root);
    $n = 0;
    foreach ($list as $b) {
        if ($b['id'] === $keep) {
            continue;
        }
        $n++;
        if ($n > KLICENKA_UDRZBA_KEEP) {
            klicenka_udrzba_rmdir($root . '/' . $b['id']);
        }
    }
    $complete = wp_list_pluck($list, 'id');
    foreach ((array) scandir($root) as $name) {
        if (klicenka_udrzba_backup_id_ok($name) && !in_array($name, $complete, true) && @filemtime($root . '/' . $name) < time() - DAY_IN_SECONDS) {
            klicenka_udrzba_rmdir($root . '/' . $name);
        }
    }
    foreach ((array) scandir($root . '/tmp') as $name) {
        if ($name !== '.' && $name !== '..' && @filemtime($root . '/tmp/' . $name) < time() - DAY_IN_SECONDS) {
            klicenka_udrzba_rmdir($root . '/tmp/' . $name);
        }
    }
    // Zbytky přerušené výměny složek (.klicenka-new-* po dni, původní .klicenka-old-* po týdnu).
    foreach (array_unique(array(WP_CONTENT_DIR, WP_PLUGIN_DIR, get_theme_root(), rtrim(ABSPATH, '/'))) as $parent) {
        foreach ((array) @scandir($parent) as $name) {
            if (preg_match('/^\.klicenka-(new|old)-[a-f0-9]{8}$/', (string) $name, $mm)) {
                $age = $mm[1] === 'new' ? DAY_IN_SECONDS : WEEK_IN_SECONDS;
                if (@filemtime($parent . '/' . $name) < time() - $age) {
                    klicenka_udrzba_rmdir($parent . '/' . $name);
                }
            }
        }
    }
}

function klicenka_udrzba_sql_value($v)
{
    if ($v === null) {
        return 'NULL';
    }
    return "'" . strtr((string) $v, array("\\" => "\\\\", "\0" => "\\0", "\n" => "\\n", "\r" => "\\r", "'" => "\\'", '"' => '\\"', "\x1a" => "\\Z")) . "'";
}

function klicenka_udrzba_ident($name)
{
    return '`' . str_replace('`', '``', (string) $name) . '`';
}

/**
 * Tabulky a pohledy tohoto WordPressu: všechny s jeho prefixem i ty bez prefixu (pluginy, které prefix
 * nepoužívají, vlastní tabulky), kromě tabulek JINÉ instalace WordPressu ve stejné databázi (jiný prefix
 * s vlastními options a posts) — ty patří k jinému webu a obnova téhle zálohy na ně nesmí sáhnout.
 * @return array{tables: string[], views: string[], other: string[]}
 */
function klicenka_udrzba_db_objects()
{
    global $wpdb;
    $rows = $wpdb->get_results('SHOW FULL TABLES', ARRAY_N);
    if (!$rows) {
        $rows = $wpdb->get_results('SHOW TABLES', ARRAY_N); // databáze bez FULL (např. SQLite ve WP Playground)
    }
    $all = array();
    foreach ((array) $rows as $r) {
        if (isset($r[0]) && is_string($r[0])) {
            $all[$r[0]] = strtoupper((string) ($r[1] ?? 'BASE TABLE'));
        }
    }
    $prefix = (string) $wpdb->base_prefix;
    $other = array();
    foreach (array_keys($all) as $t) {
        if (substr($t, -7) !== 'options') {
            continue;
        }
        $p = substr($t, 0, -7);
        if ($p !== '' && strpos($p, $prefix) !== 0 && isset($all[$p . 'posts'])) {
            $other[] = $p;
        }
    }
    $tables = array();
    $views = array();
    foreach ($all as $t => $type) {
        if (strpos($t, $prefix) !== 0) {
            foreach ($other as $p) {
                if (strpos($t, $p) === 0) {
                    continue 2;
                }
            }
        }
        if ($type === 'VIEW') {
            $views[] = $t;
        } else {
            $tables[] = $t;
        }
    }
    return array('tables' => $tables, 'views' => $views, 'other' => $other);
}

/** Tabulky tohoto WordPressu (bez pohledů). */
function klicenka_udrzba_tables()
{
    $o = klicenka_udrzba_db_objects();
    return $o['tables'];
}

function klicenka_udrzba_db_size()
{
    global $wpdb;
    $mine = array_flip(klicenka_udrzba_tables());
    $rows = $wpdb->get_results('SHOW TABLE STATUS', ARRAY_A);
    $size = 0;
    foreach ((array) $rows as $r) {
        if (isset($mine[(string) ($r['Name'] ?? '')])) {
            $size += (int) ($r['Data_length'] ?? 0) + (int) ($r['Index_length'] ?? 0);
        }
    }
    return $size;
}

/**
 * Export databáze do .sql.gz po krocích: jeden příkaz na řádek (konce řádků v datech jsou escapované),
 * DROP + CREATE + INSERTy po max. ~1 MB, na konci řádek "-- konec zálohy". Každý krok připíše nový gzip
 * člen (gzip i PHP je čtou za sebou jako jeden soubor). $c = kurzor (ukládá se v úloze),
 * $deadline = microtime, kdy krok ukončit (null = jet do konce; vždy se udělá aspoň jedna dávka).
 * @return bool|WP_Error true = hotovo, false = pokračovat dalším krokem
 */
function klicenka_udrzba_db_export_step($path, &$c, $deadline = null)
{
    global $wpdb;
    if (empty($c['tables'])) {
        $o = klicenka_udrzba_db_objects();
        if (!$o['tables']) {
            return klicenka_udrzba_error('db', 'V databázi nejsou žádné tabulky WordPressu.');
        }
        $c = array(
            'tables' => $o['tables'], 'views' => $o['views'], 'other' => $o['other'], 'perTable' => array(), 'viewsDone' => false,
            't' => 0, 'begun' => false, 'pk' => null, 'pkIndex' => null, 'last' => null, 'offset' => 0, 'rows' => 0, 'started' => false,
        );
    }
    $gz = @gzopen($path, $c['started'] ? 'ab6' : 'wb6');
    if (!$gz) {
        return klicenka_udrzba_error('write', 'Soubor zálohy databáze nejde vytvořit.');
    }
    $w = function ($s) use ($gz) {
        return gzwrite($gz, $s) !== false;
    };
    if (!$c['started']) {
        $w('-- Klíčenka záloha databáze ' . gmdate('c') . ' (' . home_url() . ")\n");
        // Stejná znaková sada spojení jako při exportu (u starých webů i latin1), jinak by se texty při obnově převedly.
        if (!empty($wpdb->charset) && preg_match('/^[a-z0-9_]+$/i', (string) $wpdb->charset)) {
            $w('SET NAMES ' . $wpdb->charset . ";\n");
        }
        $w("SET FOREIGN_KEY_CHECKS=0;\n");
        $c['started'] = true;
    }
    $batch = 1000;
    $did = false;
    while ($c['t'] < count($c['tables'])) {
        $t = (string) $c['tables'][$c['t']];
        $q = klicenka_udrzba_ident($t);
        if (!$c['begun']) {
            $create = $wpdb->get_row('SHOW CREATE TABLE ' . $q, ARRAY_N);
            if (!is_array($create) || empty($create[1])) {
                gzclose($gz);
                return klicenka_udrzba_error('db', 'Nejde přečíst strukturu tabulky ' . $t . '.');
            }
            $w('DROP TABLE IF EXISTS ' . $q . ";\n");
            $w(str_replace(array("\r\n", "\r", "\n"), ' ', $create[1]) . ";\n");
            // Klíč pro stránkování: jeden celočíselný primární klíč → WHERE pk > poslední, jinak OFFSET.
            $cols = $wpdb->get_results('SHOW COLUMNS FROM ' . $q, ARRAY_A);
            $pk = null;
            $pk_index = null;
            $pri = 0;
            foreach ((array) $cols as $i => $col) {
                if (($col['Key'] ?? '') === 'PRI') {
                    $pri++;
                    if (preg_match('/int/i', (string) ($col['Type'] ?? ''))) {
                        $pk = (string) $col['Field'];
                        $pk_index = $i;
                    }
                }
            }
            $c['pk'] = $pri === 1 ? $pk : null;
            $c['pkIndex'] = $pri === 1 ? $pk_index : null;
            $c['last'] = null;
            $c['offset'] = 0;
            $c['begun'] = true;
        }
        for (;;) {
            if ($did && $deadline !== null && microtime(true) >= $deadline) {
                return gzclose($gz) ? false : klicenka_udrzba_error('write', 'Zápis zálohy databáze selhal.');
            }
            $ok = klicenka_udrzba_check_time();
            if (is_wp_error($ok)) {
                gzclose($gz);
                return $ok;
            }
            $did = true;
            if ($c['pk'] !== null) {
                $sql = 'SELECT * FROM ' . $q . ($c['last'] !== null ? ' WHERE ' . klicenka_udrzba_ident($c['pk']) . ' > ' . (int) $c['last'] : '') . ' ORDER BY ' . klicenka_udrzba_ident($c['pk']) . ' ASC LIMIT ' . $batch;
            } else {
                $sql = 'SELECT * FROM ' . $q . ' LIMIT ' . $batch . ' OFFSET ' . (int) $c['offset'];
            }
            $rows = $wpdb->get_results($sql, ARRAY_N);
            if ($wpdb->last_error !== '') {
                gzclose($gz);
                return klicenka_udrzba_error('db', 'Čtení tabulky ' . $t . ' selhalo: ' . $wpdb->last_error);
            }
            if (!$rows) {
                break;
            }
            $chunk = '';
            foreach ($rows as $r) {
                $vals = '(' . implode(',', array_map('klicenka_udrzba_sql_value', $r)) . ')';
                if ($chunk !== '' && strlen($chunk) + strlen($vals) > 1000000) {
                    $w($chunk . ";\n");
                    $chunk = '';
                }
                $chunk .= ($chunk === '' ? 'INSERT INTO ' . $q . ' VALUES ' : ',') . $vals;
                $c['rows']++;
            }
            $c['perTable'][$t] = (int) ($c['perTable'][$t] ?? 0) + count($rows);
            if ($chunk !== '' && !$w($chunk . ";\n")) {
                gzclose($gz);
                return klicenka_udrzba_error('write', 'Zápis zálohy databáze selhal (místo na disku?).');
            }
            if ($c['pk'] !== null) {
                $end = end($rows);
                $c['last'] = $end[$c['pkIndex']];
            } else {
                $c['offset'] += $batch;
            }
            if (count($rows) < $batch) {
                break;
            }
        }
        $c['t']++;
        $c['begun'] = false;
    }
    // Pohledy až po všech tabulkách (odkazují na ně), bez DEFINER (na jiném hostingu by uživatel neexistoval).
    if (empty($c['viewsDone'])) {
        foreach ((array) ($c['views'] ?? array()) as $v) {
            $create = $wpdb->get_row('SHOW CREATE VIEW ' . klicenka_udrzba_ident($v), ARRAY_N);
            if (!is_array($create) || empty($create[1])) {
                gzclose($gz);
                return klicenka_udrzba_error('db', 'Nejde přečíst pohled ' . $v . '.');
            }
            $sql = preg_replace('/\sDEFINER=`[^`]*`@`[^`]*`/', '', str_replace(array("\r\n", "\r", "\n"), ' ', (string) $create[1]));
            $w('DROP VIEW IF EXISTS ' . klicenka_udrzba_ident($v) . ";\n" . $sql . ";\n");
        }
        $c['viewsDone'] = true;
    }
    $w("-- konec zálohy\n");
    if (!gzclose($gz)) {
        return klicenka_udrzba_error('write', 'Zápis zálohy databáze selhal.');
    }
    return true;
}

/** Celý .gz se dá přečíst a končí značkou konce. */
function klicenka_udrzba_db_verify($path)
{
    $gz = @gzopen($path, 'rb');
    if (!$gz) {
        return false;
    }
    $tail = '';
    while (!gzeof($gz)) {
        $data = gzread($gz, 1048576);
        if ($data === false) {
            gzclose($gz);
            return false;
        }
        $tail = substr($tail . $data, -64);
    }
    gzclose($gz);
    return substr($tail, -strlen("-- konec zálohy\n")) === "-- konec zálohy\n";
}

/** Co obnova z trackeru vrací na místo: klíč v zipu => složka na disku. */
function klicenka_udrzba_restore_roots($uploads)
{
    $roots = array('plugins' => WP_PLUGIN_DIR, 'themes' => get_theme_root());
    if ($uploads) {
        $u = wp_upload_dir(null, false);
        if (!empty($u['basedir'])) {
            $roots['uploads'] = $u['basedir'];
        }
    }
    return $roots;
}

/** Kde je wp-config.php: v kořeni webu, nebo (WordPress to dovoluje) o složku výš. null = nenalezen. */
function klicenka_udrzba_wp_config()
{
    $root = rtrim(ABSPATH, '/\\');
    if (@is_file($root . '/wp-config.php')) {
        return $root . '/wp-config.php';
    }
    $up = dirname($root);
    return @is_file($up . '/wp-config.php') && !@is_file($up . '/wp-settings.php') ? $up . '/wp-config.php' : null;
}

/**
 * Co se zálohuje ze souborů: klíč v zipu => složka na disku. Kromě toho, co obnova vrací (plugins,
 * themes, uploads), i všechno ostatní, co web potřebuje k obnově od nuly na novém hostingu:
 *   wp-content/  — zbytek wp-content (mu-plugins, languages, fonts, drop-iny, vlastní složky pluginů),
 *   koren/       — kořen webu kromě jádra WordPressu (wp-config.php, .htaccess, .user.ini, robots.txt, ověřovací
 *                  soubory, další složky webu),
 *   nad-korenem/ — jen wp-config.php, když leží o složku výš.
 * Co je v jiném kořeni (plugins v wp-content apod.), se nezálohuje dvakrát (viz list_files).
 */
function klicenka_udrzba_file_roots($uploads)
{
    $roots = klicenka_udrzba_restore_roots($uploads);
    $roots['wp-content'] = WP_CONTENT_DIR;
    $roots['koren'] = rtrim(ABSPATH, '/\\');
    $cfg = klicenka_udrzba_wp_config();
    if ($cfg && dirname($cfg) !== $roots['koren']) {
        $roots['nad-korenem'] = dirname($cfg);
    }
    return $roots;
}

/**
 * Složky přímo ve wp-content a v kořeni webu, které se nezálohují: mezipaměti, dočasné složky aktualizací
 * a zálohy jiných pluginů. Upravit jde filtrem klicenka_udrzba_vynechat_ostatni (regulární výraz).
 */
function klicenka_udrzba_other_skip()
{
    return (string) apply_filters('klicenka_udrzba_vynechat_ostatni', '/^(cache|upgrade|upgrade-temp-backup|updraft|ai1wm-backups|wpvivid.*|backups-dup-.*|backup-guard|backwpup-.*|wp-staging.*|et-cache|litespeed|w3tc-cache)$/i');
}

/**
 * Složky přímo v uploads, které se nezálohují: zálohy a mezipaměti jiných pluginů (zálohovat zálohy
 * by jen zdvojovalo místo). Upravit jde filtrem klicenka_udrzba_vynechat_uploads (regulární výraz).
 */
function klicenka_udrzba_uploads_skip()
{
    return (string) apply_filters('klicenka_udrzba_vynechat_uploads', '/^(backwpup-.*|backup-guard|wpvivid.*|updraft.*|ai1wm-backups|wp-staging.*|cache)$/i');
}

/**
 * Seznam souborů k záloze do souboru, řádek na položku: "d <cesta>" nebo "f <cesta> <velikost>",
 * cesta (s klíčem kořene, např. uploads/2024/01/a.jpg) je rawurlencode. Odkazy, zálohy Klíčenky
 * a nečitelné složky se přeskočí. @return array|WP_Error {files, bytes}
 */
function klicenka_udrzba_list_files($list_path, $uploads)
{
    $h = @fopen($list_path, 'wb');
    if (!$h) {
        return klicenka_udrzba_error('write', 'Seznam souborů zálohy nejde vytvořit.');
    }
    $skip = realpath(klicenka_udrzba_base());
    $skip_uploads = klicenka_udrzba_uploads_skip();
    $skip_other = klicenka_udrzba_other_skip();
    $roots = klicenka_udrzba_file_roots($uploads);
    // Složky, které má na starosti jiný kořen (nebo se úmyslně nezálohují): uploads vždy, i když jsou média
    // vypnutá — ta se pak nezálohují vůbec, ne přes wp-content.
    $owned = array();
    $u = wp_upload_dir(null, false);
    foreach (array(WP_PLUGIN_DIR, get_theme_root(), $u['basedir'] ?? '', WP_CONTENT_DIR) as $d) {
        $rp = $d ? realpath($d) : false;
        if ($rp) {
            $owned[$rp] = true;
        }
    }
    $cfg = klicenka_udrzba_wp_config();
    $files = 0;
    $bytes = 0;
    $unreadable = 0;
    foreach ($roots as $key => $dir) {
        if (!is_dir($dir)) {
            continue;
        }
        fwrite($h, 'd ' . rawurlencode($key) . "\n");
        $base = rtrim($dir, '/');
        $len = strlen($base) + 1;
        $base_real = realpath($base);
        $filter = new RecursiveCallbackFilterIterator(
            new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS),
            function ($f) use ($skip, $key, $base, $base_real, $skip_uploads, $skip_other, $owned, $cfg) {
                if ($f->isLink()) {
                    return false;
                }
                $p = $f->getPathname();
                if ($skip && strpos($p, $skip) === 0) {
                    return false;
                }
                if ($key === 'uploads' && $f->isDir() && dirname($p) === $base && preg_match($skip_uploads, $f->getFilename())) {
                    return false;
                }
                if ($key === 'nad-korenem') {
                    return $f->isFile() && $cfg && $p === $cfg;
                }
                if ($key === 'wp-content' || $key === 'koren') {
                    if ($f->isDir()) {
                        $rp = realpath($p);
                        if ($rp && $rp !== $base_real && isset($owned[$rp])) {
                            return false; // plugins, themes, uploads, wp-content: svůj kořen
                        }
                        if (dirname($p) === $base && preg_match($skip_other, $f->getFilename())) {
                            return false;
                        }
                        if ($key === 'koren') {
                            if (dirname($p) === $base && preg_match('/^(wp-admin|wp-includes)$/', $f->getFilename())) {
                                return false; // jádro WordPressu: při obnově se nainstaluje stejná verze (manifest)
                            }
                            if (@is_file($p . '/wp-config.php')) {
                                return false; // jiná instalace WordPressu v podsložce — zálohuje se sama
                            }
                        }
                    }
                }
                return true;
            }
        );
        $it = new RecursiveIteratorIterator($filter, RecursiveIteratorIterator::SELF_FIRST, RecursiveIteratorIterator::CATCH_GET_CHILD);
        foreach ($it as $f) {
            $rel = $key . '/' . substr($f->getPathname(), $len);
            if ($f->isDir()) {
                $line = 'd ' . rawurlencode($rel) . "\n";
            } elseif ($f->isFile() && $f->isReadable()) {
                $size = (int) $f->getSize();
                $line = 'f ' . rawurlencode($rel) . ' ' . $size . "\n";
                $files++;
                $bytes += $size;
            } else {
                if ($f->isFile()) {
                    $unreadable++;
                }
                continue;
            }
            if (fwrite($h, $line) === false) {
                fclose($h);
                return klicenka_udrzba_error('write', 'Seznam souborů zálohy nejde zapsat (místo na disku?).');
            }
        }
    }
    if (!fclose($h)) {
        return klicenka_udrzba_error('write', 'Seznam souborů zálohy nejde zapsat.');
    }
    return array('files' => $files, 'bytes' => $bytes, 'unreadable' => $unreadable);
}

/** Přípony, které už jsou zkomprimované: do zipu se jen uloží (rychlé, žádné zbytečné CPU). */
define('KLICENKA_UDRZBA_STORE_EXT', '/\.(jpe?g|png|gif|webp|avif|heic|heif|mp4|m4v|mov|webm|mkv|avi|mp3|m4a|aac|ogg|oga|opus|flac|zip|gz|tgz|bz2|xz|7z|rar|woff2?|pdf|docx|xlsx|pptx|odt|ods)$/i');

/**
 * Další část zálohy souborů: položky ze seznamu od $job['listPos'] do nového zipu (soubory.zip,
 * soubory-002.zip, …), dokud nedojde limit velikosti nebo počtu souborů. Zip se po zavření už nikdy
 * neotvírá znovu, takže každý krok je stejně rychlý i u gigabajtů médií.
 * @return bool|WP_Error true = seznam došel (všechny části hotové)
 */
function klicenka_udrzba_zip_part($dir, &$job, $max_bytes, $max_files)
{
    if (!class_exists('ZipArchive')) {
        return klicenka_udrzba_error('zip', 'Hosting nemá PHP rozšíření zip.');
    }
    $roots = klicenka_udrzba_file_roots(!empty($job['uploads']));
    $h = @fopen($dir . '/seznam.txt', 'rb');
    if (!$h || fseek($h, (int) $job['listPos']) !== 0) {
        return klicenka_udrzba_error('zip', 'Seznam souborů zálohy nejde přečíst.');
    }
    $n = count($job['parts']) + 1;
    $name = $n === 1 ? 'soubory.zip' : sprintf('soubory-%03d.zip', $n);
    $path = $dir . '/' . $name;
    $zip = new ZipArchive();
    if ($zip->open($path, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
        fclose($h);
        return klicenka_udrzba_error('write', 'Soubor zálohy souborů nejde vytvořit.');
    }
    $store = method_exists($zip, 'setCompressionName');
    $entries = 0;
    $files = 0;
    $bytes = 0;
    $eof = true;
    for (;;) {
        $pos = ftell($h);
        $line = fgets($h);
        if ($line === false) {
            break;
        }
        $parts = explode(' ', rtrim($line, "\r\n"));
        $type = $parts[0];
        $rel = isset($parts[1]) ? rawurldecode($parts[1]) : '';
        $size = isset($parts[2]) ? (int) $parts[2] : 0;
        if ($type === 'f' && $files > 0 && ($bytes + $size > $max_bytes || $files >= $max_files)) {
            fseek($h, $pos);
            $eof = false;
            break;
        }
        $job['listPos'] = ftell($h);
        $key = strtok($rel, '/');
        if ($rel === '' || !isset($roots[$key]) || strpos($rel, '..') !== false) {
            continue;
        }
        $abs = $roots[$key] . substr($rel, strlen($key));
        if ($type === 'd') {
            $zip->addEmptyDir($rel);
            $entries++;
            continue;
        }
        if ($type !== 'f') {
            continue;
        }
        if (!is_file($abs) || !is_readable($abs)) {
            $job['skipped'] = (int) ($job['skipped'] ?? 0) + 1; // mezitím smazaný soubor
            continue;
        }
        if (!$zip->addFile($abs, $rel)) {
            $zip->close();
            fclose($h);
            @unlink($path);
            return klicenka_udrzba_error('zip', 'Soubor nejde přidat do zálohy: ' . $rel);
        }
        if ($store && preg_match(KLICENKA_UDRZBA_STORE_EXT, $rel)) {
            $zip->setCompressionName($rel, ZipArchive::CM_STORE);
        }
        $entries++;
        $files++;
        $bytes += (int) @filesize($abs);
    }
    fclose($h);
    if ($entries === 0) {
        $zip->close(); // prázdný zip libzip ani nezapíše
        @unlink($path);
        return $eof;
    }
    $t = microtime(true);
    if (!$zip->close()) {
        @unlink($path);
        return klicenka_udrzba_error('write', 'Zápis zálohy souborů selhal (místo na disku?).');
    }
    if (!klicenka_udrzba_zip_verify($path, $files)) {
        @unlink($path);
        return klicenka_udrzba_error('verify', 'Záloha souborů se nedá přečíst zpět, zrušeno.');
    }
    $job['parts'][] = array('name' => $name, 'size' => (int) filesize($path), 'sha256' => hash_file('sha256', $path), 'files' => $files);
    $secs = microtime(true) - $t;
    // Rychlost hostingu (zápis + kontrola + otisk), podle ní se velikost další části vejde do kroku.
    if ($bytes > 4 * 1048576 && $secs > 0.05) {
        $job['rate'] = (int) ($bytes / $secs);
    }
    $job['files'] += $files;
    $job['bytes'] += $bytes;
    return $eof;
}

function klicenka_udrzba_zip_verify($path, $expected_files)
{
    if (!class_exists('ZipArchive')) {
        return false;
    }
    $zip = new ZipArchive();
    if ($zip->open($path, ZipArchive::CHECKCONS) !== true) {
        return false;
    }
    $files = 0;
    for ($i = 0; $i < $zip->numFiles; $i++) {
        $name = (string) $zip->getNameIndex($i);
        if (substr($name, -1) !== '/') {
            $files++;
        }
    }
    $zip->close();
    return $files === (int) $expected_files;
}

/** Části zálohy souborů v popisu zálohy (starší zálohy mají jen soubory.zip). */
function klicenka_udrzba_zip_parts($m)
{
    $out = array();
    foreach ((array) ($m['files'] ?? array()) as $f) {
        if (isset($f['name']) && preg_match('/^soubory(-\d{3})?\.zip$/', (string) $f['name'])) {
            $out[] = (string) $f['name'];
        }
    }
    return $out;
}

// ---------------------------------------------------------------------------
// Záloha jako úloha po krocích (stav v <id>/job.json): jeden běh u synchronní zálohy,
// nebo opakované krátké kroky (krok = jeden požadavek) u velkých záloh s médii.
// ---------------------------------------------------------------------------

function klicenka_udrzba_job_save($root, $job)
{
    $p = $root . '/' . $job['id'] . '/job.json';
    return @file_put_contents($p . '.new', wp_json_encode($job)) !== false && @rename($p . '.new', $p);
}

/** Rozpracovaná záloha po krocích, na kterou se sáhlo v posledních 20 minutách (jinak je opuštěná). */
function klicenka_udrzba_job_active($root)
{
    $names = (array) scandir($root);
    rsort($names);
    foreach ($names as $name) {
        if (!klicenka_udrzba_backup_id_ok($name)) {
            continue;
        }
        $p = $root . '/' . $name . '/job.json';
        if (!is_file($p) || is_file($root . '/' . $name . '/manifest.json') || (int) @filemtime($p) < time() - KLICENKA_UDRZBA_JOB_STALE) {
            continue;
        }
        $job = json_decode((string) @file_get_contents($p), true);
        if (is_array($job) && ($job['id'] ?? '') === $name && !empty($job['chunked'])) {
            return $job;
        }
    }
    return null;
}

function klicenka_udrzba_job_public($job)
{
    return array(
        'id' => $job['id'], 'created' => $job['created'], 'kind' => $job['kind'], 'uploads' => !empty($job['uploads']),
        'phase' => $job['phase'], 'steps' => (int) $job['steps'], 'seconds' => round((float) $job['seconds'], 1),
        'total' => $job['total'], 'done' => array('files' => (int) $job['files'], 'bytes' => (int) $job['bytes'], 'parts' => count($job['parts'])),
        'db' => isset($job['db']['tables']) ? array('table' => (int) $job['db']['t'], 'tables' => count($job['db']['tables']), 'rows' => (int) $job['db']['rows']) : null,
    );
}

/**
 * Nová úloha zálohy. $opts: uploads (bool), kind (rucni | pred-aktualizaci | pred-obnovou | mimo-hosting),
 * keep (id, které prune nesmaže), chunked (po krocích), partMax / partFiles (limity jedné části zipu).
 * @return array|WP_Error
 */
function klicenka_udrzba_job_new($root, $opts = array())
{
    $opts = array_merge(array('uploads' => false, 'kind' => 'rucni', 'keep' => '', 'chunked' => false, 'partMax' => KLICENKA_UDRZBA_PART_MAX, 'partFiles' => KLICENKA_UDRZBA_PART_FILES), $opts);
    $space = klicenka_udrzba_check_space($root, klicenka_udrzba_db_size());
    if (is_wp_error($space)) {
        return $space;
    }
    $id = gmdate('Ymd-His') . '-' . bin2hex(random_bytes(6));
    if (!@mkdir($root . '/' . $id, 0755)) {
        return klicenka_udrzba_error('write', 'Složku zálohy nejde vytvořit.');
    }
    $job = array(
        'id' => $id, 'kind' => (string) $opts['kind'], 'uploads' => (bool) $opts['uploads'], 'keep' => (string) $opts['keep'],
        'chunked' => (bool) $opts['chunked'], 'partMax' => (int) $opts['partMax'], 'partFiles' => (int) $opts['partFiles'],
        'by' => klicenka_udrzba_actor()['email'], 'created' => gmdate('c'), 'createdTs' => microtime(true),
        'phase' => 'db', 'steps' => 0, 'seconds' => 0.0, 'db' => array(), 'listPos' => 0, 'total' => null,
        'parts' => array(), 'files' => 0, 'bytes' => 0, 'skipped' => 0, 'rate' => null,
    );
    if (!klicenka_udrzba_job_save($root, $job)) {
        klicenka_udrzba_rmdir($root . '/' . $id);
        return klicenka_udrzba_error('write', 'Stav zálohy nejde uložit.');
    }
    return $job;
}

/**
 * Smaže místní zálohy s médii, které už jsou uložené mimo hosting (příznak offsite), kromě nejnovější
 * hotové zálohy (ta zůstává pro rychlý návrat) a $keep. @return string[] smazaná id
 */
function klicenka_udrzba_free_offsite($root, $keep = '')
{
    $list = klicenka_udrzba_backups($root);
    $deleted = array();
    foreach ($list as $i => $b) {
        if ($i === 0 || $b['id'] === $keep || empty($b['offsite']) || empty($b['uploads'])) {
            continue;
        }
        if (klicenka_udrzba_rmdir($root . '/' . $b['id'])) {
            $deleted[] = $b['id'];
        }
    }
    return $deleted;
}

/**
 * Pokračuje v úloze do $deadline (microtime; null = až do konce, jen s pojistkou max_execution_time).
 * Při chybě složku úlohy smaže. @return array|false|WP_Error manifest hotové zálohy / false = pokračovat
 */
function klicenka_udrzba_job_run($root, &$job, $deadline = null)
{
    $dir = $root . '/' . $job['id'];
    $t0 = microtime(true);
    $job['steps']++;
    $budget = $deadline === null ? null : max(1.0, $deadline - $t0);
    $fail = function ($e) use ($dir) {
        klicenka_udrzba_rmdir($dir);
        return $e;
    };
    $did = false;
    for (;;) {
        if ($did && $deadline !== null && microtime(true) >= $deadline) {
            break;
        }
        if ($job['phase'] === 'db') {
            $r = klicenka_udrzba_db_export_step($dir . '/db.sql.gz', $job['db'], $deadline);
            if (is_wp_error($r)) {
                return $fail($r);
            }
            $did = true;
            if ($r !== true) {
                break;
            }
            if (!klicenka_udrzba_db_verify($dir . '/db.sql.gz')) {
                return $fail(klicenka_udrzba_error('verify', 'Záloha databáze se nedá přečíst zpět, zrušeno.'));
            }
            $job['phase'] = 'list';
        } elseif ($job['phase'] === 'list') {
            $l = klicenka_udrzba_list_files($dir . '/seznam.txt', !empty($job['uploads']));
            if (is_wp_error($l)) {
                return $fail($l);
            }
            $job['total'] = $l;
            $space = klicenka_udrzba_check_space($root, $l['bytes']);
            if (is_wp_error($space) && klicenka_udrzba_free_offsite($root, (string) $job['keep'])) {
                $space = klicenka_udrzba_check_space($root, $l['bytes']);
            }
            if (is_wp_error($space)) {
                return $fail($space);
            }
            $did = true;
            $job['phase'] = 'zip';
        } elseif ($job['phase'] === 'zip') {
            if ($deadline === null) {
                $ok = klicenka_udrzba_check_time(60);
                if (is_wp_error($ok)) {
                    return $fail($ok);
                }
                $max = $job['partMax'];
            } else {
                $left = $deadline - microtime(true);
                if ($did && $left < 0.4 * $budget) {
                    break; // na další část už by čas nemusel stačit
                }
                // Velikost části podle změřené rychlosti hostingu, ať se vejde do zbytku kroku.
                $rate = $job['rate'] ? (int) $job['rate'] : 20 * 1048576;
                $max = (int) min($job['partMax'], max(4 * 1048576, $rate * max(1.0, $left) * 0.6));
            }
            $r = klicenka_udrzba_zip_part($dir, $job, $max, $job['partFiles']);
            if (is_wp_error($r)) {
                return $fail($r);
            }
            $did = true;
            if ($r === true) {
                $job['phase'] = 'finish';
            }
        } else {
            global $wp_version;
            $parts = array(array('name' => 'db.sql.gz', 'size' => (int) filesize($dir . '/db.sql.gz'), 'sha256' => hash_file('sha256', $dir . '/db.sql.gz')));
            foreach ($job['parts'] as $p) {
                $parts[] = array('name' => $p['name'], 'size' => $p['size'], 'sha256' => $p['sha256']);
            }
            $job['seconds'] += microtime(true) - $t0;
            $manifest = array(
                'id'        => $job['id'],
                'created'   => $job['created'],
                'createdTs' => $job['createdTs'],
                'kind'      => $job['kind'],
                'complete'  => true,
                'uploads'   => !empty($job['uploads']),
                'wordpress' => (string) $wp_version,
                'db'        => array(
                    'tables' => count($job['db']['tables']), 'rows' => (int) $job['db']['rows'], 'views' => count((array) ($job['db']['views'] ?? array())),
                    'perTable' => (object) ($job['db']['perTable'] ?? array()), 'otherInstalls' => array_values((array) ($job['db']['other'] ?? array())),
                ),
                'filesInfo' => array(
                    'files' => (int) $job['files'], 'bytes' => (int) $job['bytes'], 'skipped' => (int) $job['skipped'],
                    'unreadable' => (int) ($job['total']['unreadable'] ?? 0),
                ),
                'roots'     => array_keys(klicenka_udrzba_file_roots(!empty($job['uploads']))),
                'wpConfig'  => klicenka_udrzba_wp_config() !== null,
                'files'     => $parts,
                'size'      => array_sum(wp_list_pluck($parts, 'size')),
                'sha256'    => hash('sha256', implode('', wp_list_pluck($parts, 'sha256'))),
                'seconds'   => round((float) $job['seconds'], 1),
                'steps'     => (int) $job['steps'],
                'chunked'   => !empty($job['chunked']),
                'by'        => $job['by'],
            );
            if (@file_put_contents($dir . '/manifest.json.new', wp_json_encode($manifest)) === false || !@rename($dir . '/manifest.json.new', $dir . '/manifest.json')) {
                return $fail(klicenka_udrzba_error('write', 'Popis zálohy nejde uložit.'));
            }
            @unlink($dir . '/job.json');
            @unlink($dir . '/seznam.txt');
            klicenka_udrzba_prune($root, (string) $job['keep']);
            return $manifest;
        }
    }
    $job['seconds'] += microtime(true) - $t0;
    if (!klicenka_udrzba_job_save($root, $job)) {
        return $fail(klicenka_udrzba_error('write', 'Stav zálohy nejde uložit.'));
    }
    return false;
}

/**
 * Nová ověřená záloha naráz (v jednom požadavku). $opts: uploads (bool), kind, keep (id, které prune nesmaže).
 * @return array|WP_Error manifest
 */
function klicenka_udrzba_backup_create($root, $opts = array())
{
    $job = klicenka_udrzba_job_new($root, $opts);
    if (is_wp_error($job)) {
        return $job;
    }
    $m = klicenka_udrzba_job_run($root, $job, null);
    return $m === false ? klicenka_udrzba_error('timeout', 'Záloha se nedokončila.', 504) : $m;
}

function klicenka_udrzba_public_backup($m)
{
    return array(
        'id' => $m['id'], 'created' => $m['created'], 'kind' => $m['kind'], 'uploads' => !empty($m['uploads']), 'wordpress' => $m['wordpress'] ?? null,
        'size' => (int) $m['size'], 'sha256' => $m['sha256'], 'files' => $m['files'], 'tables' => $m['db']['tables'] ?? null, 'rows' => $m['db']['rows'] ?? null,
        'fileCount' => $m['filesInfo']['files'] ?? null, 'seconds' => $m['seconds'] ?? null, 'by' => $m['by'] ?? null,
        'chunked' => !empty($m['chunked']), 'offsite' => $m['offsite'] ?? null,
    );
}

/**
 * Soubory zálohy odpovídají otiskům v popisu. $quick: velké soubory (nad 64 MB, typicky média) jen podle
 * velikosti — otisk gigabajtů by před aktualizací na sdíleném hostingu snědl celý limit běhu.
 */
function klicenka_udrzba_backup_intact($root, $m, $quick = false)
{
    foreach ($m['files'] as $f) {
        $p = $root . '/' . $m['id'] . '/' . $f['name'];
        if (!is_file($p)) {
            return false;
        }
        if ($quick && isset($f['size']) && $f['size'] > 64 * 1048576) {
            if ((int) filesize($p) !== (int) $f['size']) {
                return false;
            }
            continue;
        }
        if (hash_file('sha256', $p) !== $f['sha256']) {
            return false;
        }
    }
    return true;
}

// ---------------------------------------------------------------------------
// Kontrola webu
// ---------------------------------------------------------------------------

/** Úvodní stránka a přihlášení na stejném webu: HTTP < 500 a žádná PHP chyba v odpovědi. */
function klicenka_udrzba_health()
{
    $sslverify = apply_filters('https_local_ssl_verify', false);
    $out = array('ok' => true, 'checks' => array());
    foreach (array('home' => home_url('/'), 'login' => wp_login_url()) as $name => $url) {
        $url = add_query_arg('klicenka_kontrola', strtolower(wp_generate_password(10, false, false)), $url);
        $r = wp_remote_get($url, array('timeout' => 30, 'redirection' => 3, 'sslverify' => $sslverify, 'headers' => array('Cache-Control' => 'no-cache'), 'cookies' => array()));
        if (is_wp_error($r)) {
            $out['ok'] = false;
            $out['checks'][$name] = 'nedostupné: ' . $r->get_error_message();
            continue;
        }
        $code = (int) wp_remote_retrieve_response_code($r);
        $body = (string) wp_remote_retrieve_body($r);
        $fatal = preg_match('/<b>(Fatal|Parse) error<\/b>|PHP (Fatal|Parse) error|Uncaught (Error|Exception|TypeError)|critical error on (this|your) website|došlo k (závažné|kritické) chybě/i', $body);
        if ($code >= 500 || $code === 0 || $fatal) {
            $out['ok'] = false;
            $out['checks'][$name] = 'HTTP ' . $code . ($fatal ? ', PHP chyba' : '');
        } else {
            $out['checks'][$name] = 'HTTP ' . $code;
        }
    }
    return $out;
}

// ---------------------------------------------------------------------------
// Aktualizace
// ---------------------------------------------------------------------------

function klicenka_udrzba_admin_includes()
{
    require_once ABSPATH . 'wp-admin/includes/file.php';
    require_once ABSPATH . 'wp-admin/includes/misc.php';
    require_once ABSPATH . 'wp-admin/includes/plugin.php';
    require_once ABSPATH . 'wp-admin/includes/theme.php';
    require_once ABSPATH . 'wp-admin/includes/update.php';
    require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
}

/** Jen přímý přístup k souborům (bez FTP údajů). @return true|WP_Error */
function klicenka_udrzba_filesystem()
{
    if (get_filesystem_method(array(), WP_CONTENT_DIR, true) !== 'direct') {
        return klicenka_udrzba_error('filesystem', 'WordPress na tomto hostingu nemůže zapisovat soubory přímo (chce FTP údaje).', 409);
    }
    if (!WP_Filesystem()) {
        return klicenka_udrzba_error('filesystem', 'Přístup k souborům se nepodařilo připravit.', 409);
    }
    return true;
}

/** Položky z tokenu: [{type: core|plugin|theme, slug}], jádro první, bez duplicit. */
function klicenka_udrzba_items($raw)
{
    $items = array();
    $seen = array();
    foreach (is_array($raw) ? array_slice($raw, 0, 50) : array() as $it) {
        $type = is_array($it) && isset($it['type']) ? (string) $it['type'] : '';
        $slug = is_array($it) && isset($it['slug']) ? strtolower((string) $it['slug']) : '';
        if ($type === 'core') {
            $slug = 'wordpress';
        } elseif (!in_array($type, array('plugin', 'theme'), true) || !preg_match('/^[a-z0-9._-]{1,120}$/', $slug) || strpos($slug, '..') !== false || $slug[0] === '.') {
            continue;
        }
        if (isset($seen[$type . ':' . $slug])) {
            continue;
        }
        $seen[$type . ':' . $slug] = true;
        $items[] = array('type' => $type, 'slug' => $slug);
    }
    usort($items, function ($a, $b) {
        return ($a['type'] === 'core' ? 0 : 1) - ($b['type'] === 'core' ? 0 : 1);
    });
    return $items;
}

function klicenka_udrzba_plugin_file($slug)
{
    wp_clean_plugins_cache(false);
    foreach (array_keys(get_plugins()) as $file) {
        $s = strpos($file, '/') !== false ? dirname($file) : basename($file, '.php');
        if (strtolower($s) === $slug) {
            return $file;
        }
    }
    return null;
}

function klicenka_udrzba_plugin_version($file)
{
    $path = WP_PLUGIN_DIR . '/' . $file;
    if (!is_file($path)) {
        return null;
    }
    $data = get_file_data($path, array('Version' => 'Version'), 'plugin');
    return (string) $data['Version'];
}

function klicenka_udrzba_theme_version($slug)
{
    wp_clean_themes_cache(false);
    $style = get_theme_root($slug) . '/' . $slug . '/style.css';
    if (!is_file($style)) {
        return null;
    }
    $data = get_file_data($style, array('Version' => 'Version'), 'theme');
    return (string) $data['Version'];
}

function klicenka_udrzba_core_version()
{
    $src = @file_get_contents(ABSPATH . WPINC . '/version.php');
    return ($src && preg_match('/\$wp_version\s*=\s*\'([^\']+)\'/', $src, $m)) ? $m[1] : null;
}

/** Aktivní pluginy přímo z databáze (ne z mezipaměti). */
function klicenka_udrzba_active_plugins()
{
    wp_cache_delete('alloptions', 'options');
    wp_cache_delete('active_plugins', 'options');
    $active = (array) get_option('active_plugins', array());
    if (is_multisite()) {
        wp_cache_delete(get_current_network_id() . ':active_sitewide_plugins', 'site-options');
        $active = array_merge($active, array_keys((array) get_site_option('active_sitewide_plugins', array())));
    }
    return $active;
}

/** Vrátí plugin mezi aktivní bez spouštění jeho kódu v tomto procesu (stejně jako automatické aktualizace WP). */
function klicenka_udrzba_set_active($file, $active, $network)
{
    if ($network && is_multisite()) {
        $list = (array) get_site_option('active_sitewide_plugins', array());
        if ($active) {
            $list[$file] = time();
        } else {
            unset($list[$file]);
        }
        update_site_option('active_sitewide_plugins', $list);
        return;
    }
    $list = (array) get_option('active_plugins', array());
    $list = array_values(array_diff($list, array($file)));
    if ($active) {
        $list[] = $file;
        sort($list);
    }
    update_option('active_plugins', $list);
}

/** Cesty položky pro kopii: [klíč => cesta na disku]. */
function klicenka_udrzba_item_paths($item, $plugin_file)
{
    if ($item['type'] === 'plugin') {
        return array('item' => strpos($plugin_file, '/') !== false ? WP_PLUGIN_DIR . '/' . dirname($plugin_file) : WP_PLUGIN_DIR . '/' . $plugin_file);
    }
    if ($item['type'] === 'theme') {
        return array('item' => get_theme_root($item['slug']) . '/' . $item['slug']);
    }
    $paths = array('wp-admin' => ABSPATH . 'wp-admin', 'wp-includes' => ABSPATH . 'wp-includes');
    foreach ((array) glob(ABSPATH . '*.{php,txt,html}', GLOB_BRACE) as $f) {
        if (basename($f) !== 'wp-config.php') {
            $paths['root-' . basename($f)] = $f;
        }
    }
    return $paths;
}

/**
 * Vymění složku $target za $source: nová vedle cíle (.klicenka-new-*, WordPress tečkové složky přeskakuje),
 * pak dvě přejmenování ve stejné složce. $move = $source smí být přesunut místo zkopírování.
 * @return array|WP_Error {old: cesta k původní složce (smaže volající) nebo null}
 */
function klicenka_udrzba_replace($source, $target, $move = false)
{
    $parent = dirname($target);
    $tag = bin2hex(random_bytes(4));
    $new = $parent . '/.klicenka-new-' . $tag;
    $old = $parent . '/.klicenka-old-' . $tag;
    if (!$move || !@rename($source, $new)) {
        $c = klicenka_udrzba_copy($source, $new);
        if (is_wp_error($c)) {
            klicenka_udrzba_rmdir($new);
            return $c;
        }
    }
    $had = file_exists($target) || is_link($target);
    if ($had && !@rename($target, $old)) {
        klicenka_udrzba_rmdir($new);
        return klicenka_udrzba_error('replace', 'Složku ' . basename($target) . ' nejde vyměnit (přejmenování).');
    }
    if (!@rename($new, $target)) {
        if ($had) {
            @rename($old, $target);
        }
        klicenka_udrzba_rmdir($new);
        return klicenka_udrzba_error('replace', 'Složku ' . basename($target) . ' nejde vyměnit (přejmenování).');
    }
    return array('old' => $had ? $old : null);
}

/** Vrátí položku z kopie. @return true|WP_Error */
function klicenka_udrzba_swap_in($snapshot, $target)
{
    $r = klicenka_udrzba_replace($snapshot, $target, false);
    if (is_wp_error($r)) {
        return $r;
    }
    if ($r['old']) {
        klicenka_udrzba_rmdir($r['old']);
    }
    return true;
}

function klicenka_udrzba_find_update($item, $plugin_file)
{
    if ($item['type'] === 'plugin') {
        $t = get_site_transient('update_plugins');
        if (!isset($t->response[$plugin_file])) {
            wp_update_plugins();
            $t = get_site_transient('update_plugins');
        }
        return isset($t->response[$plugin_file]->new_version) ? (string) $t->response[$plugin_file]->new_version : null;
    }
    if ($item['type'] === 'theme') {
        $t = get_site_transient('update_themes');
        if (!isset($t->response[$item['slug']])) {
            wp_update_themes();
            $t = get_site_transient('update_themes');
        }
        return isset($t->response[$item['slug']]['new_version']) ? (string) $t->response[$item['slug']]['new_version'] : null;
    }
    $u = get_preferred_from_update_core();
    if (!$u || !isset($u->response) || $u->response !== 'upgrade') {
        wp_version_check(array(), true);
        $u = get_preferred_from_update_core();
    }
    return ($u && isset($u->response, $u->current) && $u->response === 'upgrade') ? (string) $u->current : null;
}

/**
 * Jedna položka: kontrola webu předem → kopie → aktualizace → kontrola → při chybě návrat z kopie
 * (a vypnutí pluginu, když web pořád nejde).
 */
function klicenka_udrzba_update_item($item, $backup_dir, $root)
{
    $res = array('type' => $item['type'], 'slug' => $item['slug'], 'from' => null, 'to' => null, 'ok' => false, 'rolledBack' => false, 'deactivated' => false, 'error' => null, 'health' => null, 'broken' => false);
    $plugin_file = null;
    if ($item['type'] === 'plugin') {
        $plugin_file = klicenka_udrzba_plugin_file($item['slug']);
        if (!$plugin_file) {
            $res['error'] = 'Plugin na webu není.';
            return $res;
        }
        $res['from'] = klicenka_udrzba_plugin_version($plugin_file);
    } elseif ($item['type'] === 'theme') {
        $res['from'] = klicenka_udrzba_theme_version($item['slug']);
        if ($res['from'] === null) {
            $res['error'] = 'Šablona na webu není.';
            return $res;
        }
    } else {
        $res['from'] = klicenka_udrzba_core_version();
    }
    $target = klicenka_udrzba_find_update($item, $plugin_file);
    if ($target === null) {
        $res['error'] = 'Aktualizace není k dispozici.';
        return $res;
    }
    $before = klicenka_udrzba_health();
    if (!$before['ok']) {
        $res['error'] = 'Web nefungoval už před aktualizací (' . implode(', ', $before['checks']) . '), nic se neměnilo.';
        $res['health'] = $before['checks'];
        return $res;
    }

    // Kopie položky do zálohy.
    $snap = $backup_dir . '/snap/' . gmdate('His') . '-' . $item['type'] . '-' . $item['slug'];
    $paths = klicenka_udrzba_item_paths($item, $plugin_file);
    $need = 0;
    foreach ($paths as $p) {
        $need += klicenka_udrzba_dir_size($p);
    }
    $space = klicenka_udrzba_check_space($root, $need * 2);
    if (is_wp_error($space)) {
        $res['error'] = $space->get_error_message();
        return $res;
    }
    foreach ($paths as $key => $p) {
        $c = klicenka_udrzba_copy($p, $snap . '/' . $key);
        if (is_wp_error($c)) {
            klicenka_udrzba_rmdir($snap);
            $res['error'] = 'Kopie před aktualizací se nepodařila, nic se neměnilo.';
            return $res;
        }
    }

    $was_active = false;
    $network = false;
    if ($plugin_file) {
        $was_active = in_array($plugin_file, klicenka_udrzba_active_plugins(), true);
        $network = is_multisite() && is_plugin_active_for_network($plugin_file);
    }

    // Aktualizace (tichý skin, žádný výstup).
    $skin = new Automatic_Upgrader_Skin();
    if ($item['type'] === 'plugin') {
        $result = (new Plugin_Upgrader($skin))->upgrade($plugin_file, array('clear_update_cache' => true));
    } elseif ($item['type'] === 'theme') {
        $result = (new Theme_Upgrader($skin))->upgrade($item['slug'], array('clear_update_cache' => true));
    } else {
        $update = find_core_update($target, get_locale());
        if (!$update) {
            $update = get_preferred_from_update_core();
        }
        $result = $update ? (new Core_Upgrader($skin))->upgrade($update, array('allow_relaxed_file_ownership' => true)) : new WP_Error('no-update', 'Aktualizace jádra nenalezena.');
    }
    if ($plugin_file && $was_active && !in_array($plugin_file, klicenka_udrzba_active_plugins(), true)) {
        klicenka_udrzba_set_active($plugin_file, true, $network);
    }
    $now = $item['type'] === 'plugin' ? klicenka_udrzba_plugin_version($plugin_file) : ($item['type'] === 'theme' ? klicenka_udrzba_theme_version($item['slug']) : klicenka_udrzba_core_version());
    $res['to'] = $now;

    $problem = null;
    if (is_wp_error($result) || $result === false || $result === null) {
        $msg = is_wp_error($result) ? $result->get_error_message() : implode(' ', array_slice(array_map('wp_strip_all_tags', (array) $skin->get_upgrade_messages()), -3));
        $problem = 'Aktualizace selhala: ' . ($msg !== '' ? $msg : 'neznámá chyba');
        if ($now === $res['from']) {
            $res['error'] = $problem; // nic se nezměnilo, návrat netřeba
            klicenka_udrzba_rmdir($snap);
            return $res;
        }
    } elseif ($now === null || $now === $res['from']) {
        $problem = 'Po aktualizaci je verze ' . ($now === null ? 'neznámá' : 'stejná') . '.';
    } else {
        $after = klicenka_udrzba_health();
        $res['health'] = $after['checks'];
        if (!$after['ok']) {
            $problem = 'Web po aktualizaci nefunguje (' . implode(', ', $after['checks']) . ').';
        } elseif ($plugin_file && $was_active && !in_array($plugin_file, klicenka_udrzba_active_plugins(), true)) {
            $problem = 'Plugin po aktualizaci není aktivní.';
        }
    }
    if ($problem === null) {
        $res['ok'] = true;
        return $res;
    }

    // Návrat z kopie.
    $res['error'] = $problem;
    // U jádra se wp-admin a wp-includes vymění celé; soubory, které nová verze přidala do kořene, nevadí.
    $failed = false;
    foreach ($paths as $key => $p) {
        $r = is_dir($snap . '/' . $key) ? klicenka_udrzba_swap_in($snap . '/' . $key, $p) : klicenka_udrzba_copy($snap . '/' . $key, $p);
        if (is_wp_error($r)) {
            $failed = true;
        }
    }
    if ($plugin_file) {
        wp_clean_plugins_cache(false);
        klicenka_udrzba_set_active($plugin_file, $was_active, $network);
    }
    if (function_exists('opcache_reset')) {
        @opcache_reset();
    }
    $res['rolledBack'] = !$failed;
    $res['to'] = $item['type'] === 'plugin' ? klicenka_udrzba_plugin_version($plugin_file) : ($item['type'] === 'theme' ? klicenka_udrzba_theme_version($item['slug']) : klicenka_udrzba_core_version());
    $check = klicenka_udrzba_health();
    $res['health'] = $check['checks'];
    if (!$check['ok'] && $plugin_file && $was_active) {
        klicenka_udrzba_set_active($plugin_file, false, $network);
        $res['deactivated'] = true;
        $check = klicenka_udrzba_health();
        $res['health'] = $check['checks'];
    }
    if (!$check['ok'] || $failed) {
        $res['broken'] = true;
        $res['error'] .= ' Web ani po návratu nefunguje — obnovte zálohu.';
    }
    return $res;
}

/** Čerstvá hotová záloha (≤ 1 h, s databází i soubory), jinak nová. @return array|WP_Error {backup, fresh} */
function klicenka_udrzba_ensure_backup($root, $uploads)
{
    foreach (klicenka_udrzba_backups($root) as $b) {
        if ((int) ($b['createdTs'] ?? 0) >= time() - KLICENKA_UDRZBA_FRESH && klicenka_udrzba_backup_intact($root, $b, true)) {
            return array('backup' => $b, 'new' => false);
        }
        break;
    }
    $b = klicenka_udrzba_backup_create($root, array('kind' => 'pred-aktualizaci', 'uploads' => $uploads));
    return is_wp_error($b) ? $b : array('backup' => $b, 'new' => true);
}

// ---------------------------------------------------------------------------
// Obnova
// ---------------------------------------------------------------------------

/** Spustí jeden příkaz zálohy (bez kontroly „neplatných znaků“, která by odmítla binární data). */
function klicenka_udrzba_exec($sql)
{
    global $wpdb;
    if (isset($wpdb->dbh) && $wpdb->dbh instanceof mysqli) {
        $ok = mysqli_query($wpdb->dbh, $sql);
        return $ok === false ? mysqli_error($wpdb->dbh) : '';
    }
    $wpdb->check_current_query = false;
    $wpdb->query($sql);
    return (string) $wpdb->last_error;
}

/** @return true|WP_Error */
function klicenka_udrzba_db_import($path)
{
    global $wpdb;
    $gz = @gzopen($path, 'rb');
    if (!$gz) {
        return klicenka_udrzba_error('restore', 'Zálohu databáze nejde otevřít.');
    }
    $stmt = '';
    $n = 0;
    while (!gzeof($gz)) {
        $part = gzgets($gz, 8 * 1048576);
        if ($part === false) {
            break;
        }
        $stmt .= $part;
        if (substr($stmt, -1) !== "\n" && !gzeof($gz)) {
            continue;
        }
        $line = rtrim($stmt, "\r\n");
        $stmt = '';
        if ($line === '' || strpos($line, '-- ') === 0) {
            continue;
        }
        if (substr($line, -1) === ';') {
            $line = substr($line, 0, -1);
        }
        $err = klicenka_udrzba_exec($line);
        if ($err !== '' && stripos($line, 'SET ') !== 0) {
            gzclose($gz);
            return klicenka_udrzba_error('restore', 'Obnova databáze selhala u příkazu ' . ($n + 1) . ': ' . $err);
        }
        $n++;
        if ($n % 50 === 0) {
            $ok = klicenka_udrzba_check_time(10);
            if (is_wp_error($ok)) {
                gzclose($gz);
                return $ok;
            }
        }
    }
    gzclose($gz);
    klicenka_udrzba_exec('SET FOREIGN_KEY_CHECKS=1');
    wp_cache_flush();
    return true;
}

/**
 * Soubory ze zálohy: rozbalit vedle, pak vyměnit celé složky plugins / themes (/ uploads).
 * Při chybě se už vyměněné složky vrátí. @return true|WP_Error
 */
function klicenka_udrzba_files_restore($root, $m)
{
    if (!class_exists('ZipArchive')) {
        return klicenka_udrzba_error('zip', 'Hosting nemá PHP rozšíření zip.');
    }
    $tmp = $root . '/tmp/restore-' . bin2hex(random_bytes(4));
    $parts = klicenka_udrzba_zip_parts($m);
    if (!$parts) {
        return klicenka_udrzba_error('restore', 'Záloha nemá žádné soubory.');
    }
    // Všechny části nejdřív zkontrolovat, pak rozbalit vedle (část po části do stejné složky).
    $entries = array();
    foreach ($parts as $part) {
        $zip = new ZipArchive();
        if ($zip->open($root . '/' . $m['id'] . '/' . $part) !== true) {
            return klicenka_udrzba_error('restore', 'Zálohu souborů nejde otevřít (' . $part . ').');
        }
        $take = array();
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $name = (string) $zip->getNameIndex($i);
            if (strpos($name, '..') !== false || $name === '' || $name[0] === '/' || !preg_match('#^(plugins|themes|uploads|wp-content|koren|nad-korenem)(/|$)#', $name)) {
                $zip->close();
                return klicenka_udrzba_error('restore', 'Záloha souborů obsahuje nepovolenou cestu.');
            }
            // wp-content/, koren/ a nad-korenem/ jsou jen pro obnovu od nuly (ručně); obnova tady je nevrací.
            if (preg_match('#^(plugins|themes|uploads)(/|$)#', $name)) {
                $take[] = $name;
            }
        }
        $zip->close();
        $entries[$part] = $take;
    }
    if (!@mkdir($tmp, 0755, true)) {
        return klicenka_udrzba_error('restore', 'Zálohu souborů nejde rozbalit (místo na disku?).');
    }
    foreach ($parts as $part) {
        if (empty($entries[$part])) {
            continue;
        }
        $zip = new ZipArchive();
        $opened = $zip->open($root . '/' . $m['id'] . '/' . $part) === true;
        $extracted = $opened && $zip->extractTo($tmp, $entries[$part]);
        if ($opened) {
            $zip->close();
        }
        if (!$extracted) {
            klicenka_udrzba_rmdir($tmp);
            return klicenka_udrzba_error('restore', 'Zálohu souborů nejde rozbalit (místo na disku?).');
        }
        $ok = klicenka_udrzba_check_time(30);
        if (is_wp_error($ok)) {
            klicenka_udrzba_rmdir($tmp);
            return $ok;
        }
    }
    $done = array();
    $error = null;
    foreach (klicenka_udrzba_restore_roots(!empty($m['uploads'])) as $key => $dir) {
        if (!is_dir($tmp . '/' . $key)) {
            continue;
        }
        $r = klicenka_udrzba_replace($tmp . '/' . $key, $dir, true);
        if (is_wp_error($r)) {
            $error = $r->get_error_message();
            break;
        }
        $done[] = array($dir, $r['old']);
    }
    if ($error !== null) {
        foreach (array_reverse($done) as $pair) {
            if ($pair[1]) {
                klicenka_udrzba_rmdir($pair[0]);
                @rename($pair[1], $pair[0]);
            }
        }
        klicenka_udrzba_rmdir($tmp);
        return klicenka_udrzba_error('restore', $error . ' Nic se nezměnilo.');
    }
    foreach ($done as $pair) {
        if ($pair[1]) {
            klicenka_udrzba_rmdir($pair[1]);
        }
    }
    klicenka_udrzba_rmdir($tmp);
    wp_clean_plugins_cache(false);
    if (function_exists('opcache_reset')) {
        @opcache_reset();
    }
    return true;
}

// ---------------------------------------------------------------------------
// Endpointy
// ---------------------------------------------------------------------------

/** Chyby databáze nikdy do výstupu (WP_DEBUG_DISPLAY by rozbil JSON); kontrolujeme last_error. */
function klicenka_udrzba_quiet_db()
{
    global $wpdb;
    $wpdb->suppress_errors(true);
    $wpdb->hide_errors();
}

/** Společný začátek akce: kořen, zámek, delší běh. @return array|WP_Error [root, lock] */
function klicenka_udrzba_begin()
{
    klicenka_udrzba_quiet_db();
    $root = klicenka_udrzba_root();
    if (is_wp_error($root)) {
        return $root;
    }
    $lock = klicenka_udrzba_lock($root);
    if (is_wp_error($lock)) {
        return $lock;
    }
    klicenka_udrzba_long_run();
    return array($root, $lock);
}

function klicenka_udrzba_rest_backup()
{
    $b = klicenka_udrzba_begin();
    if (is_wp_error($b)) {
        return klicenka_udrzba_fail($b);
    }
    list($root) = $b;
    $req = klicenka_udrzba_claims()['req'];
    $uploads = !empty($req['uploads']);
    $kind = isset($req['kind']) && in_array($req['kind'], array('rucni', 'mimo-hosting'), true) ? $req['kind'] : 'rucni';
    $log = function ($m) use ($root) {
        klicenka_udrzba_log_run($root, array('time' => gmdate('c'), 'akce' => 'zaloha', 'by' => klicenka_udrzba_actor()['email'], 'ok' => !is_wp_error($m), 'backup' => is_wp_error($m) ? null : $m['id'], 'error' => is_wp_error($m) ? $m->get_error_message() : null));
    };
    if (empty($req['krok'])) {
        $m = klicenka_udrzba_backup_create($root, array('kind' => $kind, 'uploads' => $uploads));
        $log($m);
        return is_wp_error($m) ? klicenka_udrzba_fail($m) : klicenka_udrzba_respond(array('ok' => true, 'done' => true, 'backup' => klicenka_udrzba_public_backup($m)));
    }

    // Po krocích: každé volání pracuje nejvýš budget sekund (a vždy s rezervou před limitem PHP), pak uloží stav.
    $budget = isset($req['budget']) ? max(1, min(120, (int) $req['budget'])) : 25;
    $deadline = microtime(true) + $budget;
    $left = klicenka_udrzba_time_left();
    if ($left !== null) {
        $deadline = min($deadline, microtime(true) + max(1, $left - 15));
    }
    $job = klicenka_udrzba_job_active($root);
    if ($job && (bool) $job['uploads'] !== $uploads) {
        return klicenka_udrzba_fail(klicenka_udrzba_error('busy', 'Na webu se právě dělá jiná záloha po krocích (' . ($job['uploads'] ? 's médii' : 'bez médií') . '). Zkuste to za chvíli.', 409));
    }
    if (!$job) {
        $job = klicenka_udrzba_job_new($root, array(
            'kind' => $kind, 'uploads' => $uploads, 'chunked' => true,
            'partMax' => isset($req['part']) ? max(1048576, min(KLICENKA_UDRZBA_PART_MAX, (int) $req['part'])) : KLICENKA_UDRZBA_PART_MAX,
            'partFiles' => isset($req['partFiles']) ? max(50, min(KLICENKA_UDRZBA_PART_FILES, (int) $req['partFiles'])) : KLICENKA_UDRZBA_PART_FILES,
        ));
        if (is_wp_error($job)) {
            $log($job);
            return klicenka_udrzba_fail($job);
        }
    }
    $m = klicenka_udrzba_job_run($root, $job, $deadline);
    if ($m === false) {
        return klicenka_udrzba_respond(array('ok' => true, 'done' => false, 'job' => klicenka_udrzba_job_public($job)));
    }
    $log($m);
    if (is_wp_error($m)) {
        return klicenka_udrzba_fail($m);
    }
    return klicenka_udrzba_respond(array('ok' => true, 'done' => true, 'backup' => klicenka_udrzba_public_backup($m)));
}

/** Aktualizace ani obnova nesmí měnit soubory, zatímco se po krocích balí záloha. @return true|WP_Error */
function klicenka_udrzba_no_active_job($root)
{
    return klicenka_udrzba_job_active($root) ? klicenka_udrzba_error('busy', 'Na webu se právě po krocích dělá záloha (pro zálohu mimo hosting). Zkuste to za pár minut.', 409) : true;
}

function klicenka_udrzba_rest_update()
{
    $b = klicenka_udrzba_begin();
    if (is_wp_error($b)) {
        return klicenka_udrzba_fail($b);
    }
    list($root) = $b;
    $busy = klicenka_udrzba_no_active_job($root);
    if (is_wp_error($busy)) {
        return klicenka_udrzba_fail($busy);
    }
    $req = klicenka_udrzba_claims()['req'];
    $items = klicenka_udrzba_items($req['items'] ?? array());
    if (!$items) {
        return klicenka_udrzba_fail(klicenka_udrzba_error('items', 'Není co aktualizovat.', 400));
    }
    if (file_exists(ABSPATH . '.maintenance')) {
        return klicenka_udrzba_fail(klicenka_udrzba_error('busy', 'Web je právě v režimu údržby (.maintenance), zkuste to za pár minut.', 409));
    }
    klicenka_udrzba_admin_includes();
    $fs = klicenka_udrzba_filesystem();
    if (is_wp_error($fs)) {
        return klicenka_udrzba_fail($fs);
    }
    // Nikdy bez zálohy.
    $eb = klicenka_udrzba_ensure_backup($root, !empty($req['uploads']));
    if (is_wp_error($eb)) {
        klicenka_udrzba_log_run($root, array('time' => gmdate('c'), 'akce' => 'aktualizace', 'by' => klicenka_udrzba_actor()['email'], 'ok' => false, 'error' => 'Záloha: ' . $eb->get_error_message()));
        return klicenka_udrzba_fail(new WP_Error('backup', 'Záloha před aktualizací se nepodařila, nic se neaktualizovalo: ' . $eb->get_error_message(), array('status' => 500)));
    }
    $backup_dir = $root . '/' . $eb['backup']['id'];
    $results = array();
    $stopped = false;
    foreach ($items as $item) {
        if ($stopped) {
            $results[] = array('type' => $item['type'], 'slug' => $item['slug'], 'from' => null, 'to' => null, 'ok' => false, 'rolledBack' => false, 'deactivated' => false, 'error' => 'Přeskočeno: předchozí položka nechala web nefunkční.', 'skipped' => true);
            continue;
        }
        $t = klicenka_udrzba_check_time(90);
        if (is_wp_error($t)) {
            $results[] = array('type' => $item['type'], 'slug' => $item['slug'], 'from' => null, 'to' => null, 'ok' => false, 'rolledBack' => false, 'deactivated' => false, 'error' => 'Přeskočeno: hostingu dochází čas, spusťte znovu.', 'skipped' => true);
            continue;
        }
        $r = klicenka_udrzba_update_item($item, $backup_dir, $root);
        if (!empty($r['broken'])) {
            $stopped = true;
        }
        $results[] = $r;
    }
    $ok = !array_filter($results, function ($r) {
        return empty($r['ok']);
    });
    klicenka_udrzba_log_run($root, array('time' => gmdate('c'), 'akce' => 'aktualizace', 'by' => klicenka_udrzba_actor()['email'], 'ok' => $ok, 'backup' => $eb['backup']['id'], 'items' => array_map(function ($r) {
        return array('type' => $r['type'], 'slug' => $r['slug'], 'from' => $r['from'], 'to' => $r['to'], 'ok' => $r['ok'], 'rolledBack' => $r['rolledBack'], 'error' => $r['error']);
    }, $results)));
    return klicenka_udrzba_respond(array('ok' => $ok, 'backup' => klicenka_udrzba_public_backup($eb['backup']), 'backupNew' => $eb['new'], 'items' => $results));
}

function klicenka_udrzba_rest_restore()
{
    $b = klicenka_udrzba_begin();
    if (is_wp_error($b)) {
        return klicenka_udrzba_fail($b);
    }
    list($root) = $b;
    $busy = klicenka_udrzba_no_active_job($root);
    if (is_wp_error($busy)) {
        return klicenka_udrzba_fail($busy);
    }
    $req = klicenka_udrzba_claims()['req'];
    $id = (string) $req['backup'];
    $db = !empty($req['db']);
    $files = !empty($req['files']);
    if (!klicenka_udrzba_backup_id_ok($id) || (!$db && !$files)) {
        return klicenka_udrzba_fail(klicenka_udrzba_error('request', 'Neplatná obnova.', 400));
    }
    $m = null;
    foreach (klicenka_udrzba_backups($root) as $x) {
        if ($x['id'] === $id) {
            $m = $x;
        }
    }
    if (!$m) {
        return klicenka_udrzba_fail(klicenka_udrzba_error('not-found', 'Záloha na webu není.', 404));
    }
    if (!klicenka_udrzba_backup_intact($root, $m)) {
        return klicenka_udrzba_fail(klicenka_udrzba_error('integrity', 'Soubory zálohy nesedí s otisky, obnova zrušena.', 409));
    }
    if ($files) {
        require_once ABSPATH . 'wp-admin/includes/plugin.php';
    }
    // Pojistka: současný stav se nejdřív zazálohuje.
    $safety = klicenka_udrzba_backup_create($root, array('kind' => 'pred-obnovou', 'uploads' => !empty($m['uploads']), 'keep' => $id));
    if (is_wp_error($safety)) {
        return klicenka_udrzba_fail(new WP_Error('backup', 'Pojistná záloha před obnovou se nepodařila, nic se neobnovilo: ' . $safety->get_error_message(), array('status' => 500)));
    }
    $out = array('ok' => true, 'backup' => $id, 'safetyBackup' => $safety['id'], 'db' => null, 'files' => null);
    // Návštěvníci mezitím vidí „probíhá údržba“ (WordPress sám po 10 minutách ignoruje).
    $maintenance = ABSPATH . '.maintenance';
    $own_maintenance = !file_exists($maintenance) && @file_put_contents($maintenance, '<?php $upgrading = ' . time() . ';') !== false;
    if ($files) {
        $r = klicenka_udrzba_files_restore($root, $m);
        $out['files'] = is_wp_error($r) ? $r->get_error_message() : 'ok';
        if (is_wp_error($r)) {
            $out['ok'] = false;
        }
    }
    if ($db && $out['ok']) {
        $r = klicenka_udrzba_db_import($root . '/' . $id . '/db.sql.gz');
        if (is_wp_error($r)) {
            $out['ok'] = false;
            $out['db'] = $r->get_error_message();
            // Napůl obnovená databáze je horší než žádná: zpět na stav před obnovou.
            $back = klicenka_udrzba_db_import($root . '/' . $safety['id'] . '/db.sql.gz');
            $out['db'] .= is_wp_error($back) ? ' Vrácení databáze selhalo: ' . $back->get_error_message() : ' Databáze vrácena do stavu před obnovou.';
        } else {
            $out['db'] = 'ok';
        }
    }
    if ($own_maintenance) {
        @unlink($maintenance);
    }
    $out['health'] = klicenka_udrzba_health()['checks'];
    klicenka_udrzba_log_run($root, array('time' => gmdate('c'), 'akce' => 'obnova', 'by' => klicenka_udrzba_actor()['email'], 'ok' => $out['ok'], 'backup' => $id, 'safetyBackup' => $safety['id'], 'db' => $out['db'], 'files' => $out['files']));
    return klicenka_udrzba_respond($out, $out['ok'] ? 200 : 500);
}

function klicenka_udrzba_rest_list()
{
    klicenka_udrzba_quiet_db();
    $root = klicenka_udrzba_root();
    if (is_wp_error($root)) {
        return klicenka_udrzba_fail($root);
    }
    global $wp_version;
    if (!function_exists('get_filesystem_method')) {
        require_once ABSPATH . 'wp-admin/includes/file.php';
    }
    $free = function_exists('disk_free_space') ? @disk_free_space($root) : false;
    return klicenka_udrzba_respond(array(
        'ok'       => true,
        'plugin'   => KLICENKA_UDRZBA_VERSION,
        'wordpress' => (string) $wp_version,
        'backups'  => array_map('klicenka_udrzba_public_backup', klicenka_udrzba_backups($root)),
        'job'      => ($job = klicenka_udrzba_job_active($root)) ? klicenka_udrzba_job_public($job) : null,
        'runs'     => klicenka_udrzba_state($root)['runs'],
        'checks'   => array(
            'zip'        => class_exists('ZipArchive'),
            'filesystem' => get_filesystem_method(array(), WP_CONTENT_DIR, true),
            'freeMb'     => $free === false ? null : (int) round($free / 1048576),
            'maxTime'    => (int) ini_get('max_execution_time'),
        ),
    ));
}

/** Hotová záloha podle id (nebo null). */
function klicenka_udrzba_find_backup($root, $id)
{
    if (!klicenka_udrzba_backup_id_ok($id)) {
        return null;
    }
    foreach (klicenka_udrzba_backups($root) as $x) {
        if ($x['id'] === $id) {
            return $x;
        }
    }
    return null;
}

/**
 * Stažení jednoho souboru hotové zálohy (db.sql.gz, soubory*.zip, manifest.json) proudem, po 1 MB.
 * Token má akci "stahnout" a v req.backup + req.file přesně tento soubor; Range "bytes=od-[do]" vrací 206,
 * takže přerušené stahování naváže tam, kde skončilo (s novým tokenem).
 */
function klicenka_udrzba_rest_download(WP_REST_Request $request)
{
    klicenka_udrzba_quiet_db();
    $root = klicenka_udrzba_root();
    if (is_wp_error($root)) {
        return klicenka_udrzba_fail($root);
    }
    $req = klicenka_udrzba_claims()['req'];
    $id = isset($req['backup']) ? (string) $req['backup'] : '';
    $file = isset($req['file']) ? (string) $req['file'] : '';
    if (!klicenka_udrzba_backup_id_ok($id) || !preg_match('/^(db\.sql\.gz|soubory(-\d{3})?\.zip|manifest\.json)$/', $file)) {
        return klicenka_udrzba_fail(klicenka_udrzba_error('request', 'Neplatný soubor zálohy.', 400));
    }
    $m = klicenka_udrzba_find_backup($root, $id);
    $names = $m ? array_merge(wp_list_pluck($m['files'], 'name'), array('manifest.json')) : array();
    if (!$m || !in_array($file, $names, true)) {
        return klicenka_udrzba_fail(klicenka_udrzba_error('not-found', 'Soubor zálohy na webu není.', 404));
    }
    $path = $root . '/' . $id . '/' . $file;
    $size = @filesize($path);
    $h = $size === false ? false : @fopen($path, 'rb');
    if (!$h) {
        return klicenka_udrzba_fail(klicenka_udrzba_error('not-found', 'Soubor zálohy nejde otevřít.', 404));
    }
    $start = 0;
    $end = $size - 1;
    $partial = false;
    $range = trim((string) $request->get_header('range'));
    if ($range !== '') {
        if (!preg_match('/^bytes=(\d*)-(\d*)$/', $range, $mm) || ($mm[1] === '' && $mm[2] === '')) {
            fclose($h);
            return klicenka_udrzba_fail(klicenka_udrzba_error('range', 'Neplatný rozsah.', 416));
        }
        if ($mm[1] === '') {
            $start = max(0, $size - (int) $mm[2]); // posledních N bajtů
        } else {
            $start = (int) $mm[1];
            if ($mm[2] !== '') {
                $end = min($end, (int) $mm[2]);
            }
        }
        if ($start >= $size || $start > $end) {
            fclose($h);
            $r = klicenka_udrzba_respond(array('ok' => false, 'error' => 'range', 'message' => 'Rozsah je mimo soubor.'), 416);
            $r->header('Content-Range', 'bytes */' . $size);
            return $r;
        }
        $partial = true;
    }
    $sha = null;
    foreach ($m['files'] as $f) {
        if ($f['name'] === $file) {
            $sha = $f['sha256'];
        }
    }
    // Žádné bufferování ani komprese: velký soubor jde rovnou ven.
    while (ob_get_level() > 0) {
        @ob_end_clean();
    }
    @ini_set('zlib.output_compression', 'Off');
    if (function_exists('apache_setenv')) {
        @apache_setenv('no-gzip', '1');
    }
    $disabled = array_map('trim', explode(',', (string) ini_get('disable_functions')));
    if (function_exists('set_time_limit') && !in_array('set_time_limit', $disabled, true)) {
        @set_time_limit(0);
    }
    @ignore_user_abort(false);
    status_header($partial ? 206 : 200);
    header('Content-Type: application/octet-stream');
    header('Content-Disposition: attachment; filename="' . $file . '"');
    header('Content-Length: ' . ($end - $start + 1));
    header('Accept-Ranges: bytes');
    if ($partial) {
        header('Content-Range: bytes ' . $start . '-' . $end . '/' . $size);
    }
    if ($sha) {
        header('X-Klicenka-Sha256: ' . $sha);
    }
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    header('X-Accel-Buffering: no');
    if ($start > 0) {
        fseek($h, $start);
    }
    $left = $end - $start + 1;
    while ($left > 0 && !feof($h)) {
        $data = fread($h, (int) min(1048576, $left));
        if ($data === false || $data === '') {
            break;
        }
        echo $data;
        $left -= strlen($data);
        flush();
        if (connection_aborted()) {
            break;
        }
    }
    fclose($h);
    exit;
}

/**
 * Záloha req.backup je bezpečně uložená mimo hosting: v popisu se označí (offsite) a místní zálohy s médii,
 * které už mimo hosting jsou, se smažou — kromě nejnovější hotové zálohy, ta zůstává pro rychlý návrat.
 */
function klicenka_udrzba_rest_release()
{
    $b = klicenka_udrzba_begin();
    if (is_wp_error($b)) {
        return klicenka_udrzba_fail($b);
    }
    list($root) = $b;
    $req = klicenka_udrzba_claims()['req'];
    $id = isset($req['backup']) ? (string) $req['backup'] : '';
    $m = klicenka_udrzba_find_backup($root, $id);
    if (!$m) {
        return klicenka_udrzba_fail(klicenka_udrzba_error('not-found', 'Záloha na webu není.', 404));
    }
    $m['offsite'] = gmdate('c');
    $dir = $root . '/' . $id;
    if (@file_put_contents($dir . '/manifest.json.new', wp_json_encode($m)) === false || !@rename($dir . '/manifest.json.new', $dir . '/manifest.json')) {
        return klicenka_udrzba_fail(klicenka_udrzba_error('write', 'Popis zálohy nejde uložit.'));
    }
    $deleted = klicenka_udrzba_free_offsite($root);
    $list = klicenka_udrzba_backups($root);
    klicenka_udrzba_log_run($root, array('time' => gmdate('c'), 'akce' => 'uvolnit', 'by' => klicenka_udrzba_actor()['email'], 'ok' => true, 'backup' => $id, 'error' => null, 'deleted' => $deleted));
    return klicenka_udrzba_respond(array('ok' => true, 'backup' => $id, 'deleted' => $deleted, 'newest' => $list ? $list[0]['id'] : null));
}

if (!defined('KLICENKA_UDRZBA') || KLICENKA_UDRZBA) {
    add_action('rest_api_init', function () {
        $routes = array(
            'zaloha'      => array('POST', 'klicenka_udrzba_rest_backup'),
            'aktualizace' => array('POST', 'klicenka_udrzba_rest_update'),
            'obnova'      => array('POST', 'klicenka_udrzba_rest_restore'),
            'zalohy'      => array('GET', 'klicenka_udrzba_rest_list'),
            'stahnout'    => array('GET', 'klicenka_udrzba_rest_download'),
            'uvolnit'     => array('POST', 'klicenka_udrzba_rest_release'),
        );
        foreach ($routes as $akce => $r) {
            register_rest_route('klicenka-udrzba/v1', '/' . $akce, array(
                'methods'             => $r[0],
                'callback'            => $r[1],
                'permission_callback' => function (WP_REST_Request $request) use ($akce) {
                    return klicenka_udrzba_authorize($request, $akce);
                },
            ));
        }
    });
}
