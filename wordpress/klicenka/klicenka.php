<?php
/**
 * Plugin Name: Klíčenka
 * Description: Přihlášení na klik z Project Trackeru (MYPIXEL). Běžné přihlášení heslem zůstává beze změny.
 * Version: 1.3.0
 * Requires PHP: 7.4
 * License: MIT
 *
 * Instalace: soubor do wp-content/mu-plugins/ a do wp-config.php:
 *   define('KLICENKA_AUDIENCE', 'identifikator-webu');      // stejný jako v Klíčence
 *   define('KLICENKA_ENVIRONMENT', 'production');           // production | preview | local
 *   // volitelně:
 *   define('KLICENKA_ISSUER', 'https://tracker.mypixel.cz');
 *   define('KLICENKA_REDIRECT', '/wp-admin/');
 *
 * Token přijímá na wp-login.php?action=klicenka (POST, pole "token"), stav hlásí na
 * wp-admin/admin-ajax.php?action=klicenka_status.
 */

if (!defined('ABSPATH')) {
    exit;
}

define('KLICENKA_PLUGIN_VERSION', '1.3.0');

function klicenka_config()
{
    $issuer = defined('KLICENKA_ISSUER') ? KLICENKA_ISSUER : 'https://tracker.mypixel.cz';
    return array(
        'issuer'      => rtrim($issuer, '/'),
        'audience'    => defined('KLICENKA_AUDIENCE') ? KLICENKA_AUDIENCE : '',
        'environment' => defined('KLICENKA_ENVIRONMENT') ? KLICENKA_ENVIRONMENT : 'production',
        'jwks'        => defined('KLICENKA_JWKS_URL') ? KLICENKA_JWKS_URL : rtrim($issuer, '/') . '/.well-known/jwks.json',
        'redirect'    => defined('KLICENKA_REDIRECT') ? KLICENKA_REDIRECT : admin_url(),
        'tolerance'   => 30,
    );
}

function klicenka_b64url_decode($s)
{
    $s = strtr($s, '-_', '+/');
    $pad = strlen($s) % 4;
    if ($pad) {
        $s .= str_repeat('=', 4 - $pad);
    }
    return base64_decode($s, true);
}

/** Public keys by kid, cached 10 minutes; an unknown kid refetches at most every 30 s. */
function klicenka_keys($refresh = false)
{
    $cfg = klicenka_config();
    $cached = get_transient('klicenka_jwks');
    if (!$refresh && is_array($cached)) {
        return $cached;
    }
    if ($refresh) {
        if (get_transient('klicenka_jwks_cooldown')) {
            return is_array($cached) ? $cached : array();
        }
        set_transient('klicenka_jwks_cooldown', 1, 30);
    }
    $res = wp_remote_get($cfg['jwks'], array('timeout' => 5, 'redirection' => 0));
    if (is_wp_error($res) || (int) wp_remote_retrieve_response_code($res) !== 200) {
        return is_array($cached) ? $cached : array();
    }
    $data = json_decode(wp_remote_retrieve_body($res), true);
    $keys = array();
    foreach ((isset($data['keys']) && is_array($data['keys'])) ? $data['keys'] : array() as $k) {
        if (isset($k['kty'], $k['crv'], $k['kid'], $k['x']) && $k['kty'] === 'OKP' && $k['crv'] === 'Ed25519') {
            $keys[(string) $k['kid']] = (string) $k['x'];
        }
    }
    set_transient('klicenka_jwks', $keys, 600);
    return $keys;
}

/**
 * @param array $opts Optional (since 1.3.0), for other mu-plugins such as klicenka-upravy:
 *   'typ'        token type in the header; default 'klicenka+jwt' (login)
 *   'max_ttl'    longest allowed exp - iat in seconds; default 60, hard cap 900
 *   'single_use' reject a second use of the same jti; default true
 *   A login token ('klicenka+jwt') is always 60 s and single use, whatever $opts say.
 * @return array|WP_Error the verified payload
 */
function klicenka_verify($token, $opts = array())
{
    $cfg = klicenka_config();
    $opts = array_merge(array('typ' => 'klicenka+jwt', 'max_ttl' => 60, 'single_use' => true), is_array($opts) ? $opts : array());
    $typ = (string) $opts['typ'];
    $max_ttl = max(1, min(900, (int) $opts['max_ttl']));
    $single_use = (bool) $opts['single_use'];
    if ($typ === 'klicenka+jwt') {
        $max_ttl = 60;
        $single_use = true;
    }
    if (!is_string($token) || !preg_match('/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/', $token)) {
        return new WP_Error('malformed', 'Přihlašovací token chybí nebo je poškozený.');
    }
    if ($cfg['audience'] === '') {
        return new WP_Error('config', 'Web nemá nastavený identifikátor pro Klíčenku (KLICENKA_AUDIENCE).');
    }
    if (!function_exists('sodium_crypto_sign_verify_detached')) {
        return new WP_Error('config', 'Server nemá rozšíření sodium potřebné k ověření podpisu.');
    }
    list($h64, $p64, $s64) = explode('.', $token);
    $header = json_decode((string) klicenka_b64url_decode($h64), true);
    $payload = json_decode((string) klicenka_b64url_decode($p64), true);
    $sig = klicenka_b64url_decode($s64);
    if (!is_array($header) || !is_array($payload) || $sig === false || strlen($sig) !== SODIUM_CRYPTO_SIGN_BYTES) {
        return new WP_Error('malformed', 'Přihlašovací token je poškozený.');
    }
    if (($header['alg'] ?? '') !== 'EdDSA' || ($header['typ'] ?? '') !== $typ || empty($header['kid'])) {
        return new WP_Error('malformed', 'Přihlašovací token má neznámý formát.');
    }

    $kid = (string) $header['kid'];
    $keys = klicenka_keys();
    if (!isset($keys[$kid])) {
        $keys = klicenka_keys(true);
    }
    if (!isset($keys[$kid])) {
        return new WP_Error('unknown-key', 'Token je podepsaný klíčem, který tracker už nepoužívá.');
    }
    $pk = klicenka_b64url_decode($keys[$kid]);
    if ($pk === false || strlen($pk) !== SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES
        || !sodium_crypto_sign_verify_detached($sig, $h64 . '.' . $p64, $pk)) {
        return new WP_Error('signature', 'Podpis přihlašovacího tokenu nesedí.');
    }

    $now = time();
    $tol = $cfg['tolerance'];
    $aud = isset($payload['aud']) ? (array) $payload['aud'] : array();
    if (($payload['iss'] ?? '') !== $cfg['issuer']) {
        return new WP_Error('issuer', 'Token nevydal náš Project Tracker.');
    }
    if (!in_array($cfg['audience'] . '@' . $cfg['environment'], $aud, true)) {
        return new WP_Error('audience', 'Token je určený pro jiný web nebo jiné prostředí.');
    }
    $exp = $payload['exp'] ?? null;
    $iat = $payload['iat'] ?? null;
    if (!is_int($exp) || !is_int($iat) || $exp + $tol < $now || $iat - $tol > $now || $now - $iat > $max_ttl + $tol) {
        return new WP_Error('expired', 'Přihlašovací odkaz vypršel. Klikněte v trackeru znovu.');
    }
    if ($exp - $iat > $max_ttl) {
        return new WP_Error('claims', 'Přihlašovací token má neplatnou dobu platnosti.');
    }
    $act = $payload['act'] ?? null;
    if (empty($payload['sub']) || !is_string($payload['sub']) || empty($payload['jti']) || !is_string($payload['jti'])
        || !is_array($act) || empty($act['sub']) || empty($act['email'])) {
        return new WP_Error('claims', 'Přihlašovací token nemá potřebné údaje.');
    }

    // One use per token id.
    if ($single_use) {
        $jti_key = 'klicenka_jti_' . md5($payload['jti']);
        if (get_transient($jti_key) !== false) {
            return new WP_Error('used', 'Tento přihlašovací odkaz už byl použit. Klikněte v trackeru znovu.');
        }
        set_transient($jti_key, 1, max(180, $max_ttl + 2 * $tol));
    }

    return $payload;
}

function klicenka_fail($message, $status = 401)
{
    $cfg = klicenka_config();
    nocache_headers();
    header('Referrer-Policy: no-referrer');
    wp_die(
        '<h1>Přihlášení se nepodařilo</h1><p>' . esc_html($message) . '</p><p><a href="' . esc_url($cfg['issuer'] . '/klicenka') . '">Zpět do Klíčenky</a></p>',
        'Přihlášení se nepodařilo',
        array('response' => $status)
    );
}

/** Who really clicked — kept in the PHP log, a short list in the database and an action for other plugins. */
function klicenka_log($user, $payload)
{
    $act = $payload['act'];
    $entry = array(
        'time'    => gmdate('c'),
        'account' => $user->user_login,
        'act'     => array('sub' => (string) $act['sub'], 'name' => isset($act['name']) ? (string) $act['name'] : null, 'email' => (string) $act['email']),
        'jti'     => $payload['jti'],
    );
    error_log('[klicenka] ' . wp_json_encode($entry));
    $log = get_option('klicenka_log', array());
    $log = is_array($log) ? $log : array();
    array_unshift($log, $entry);
    update_option('klicenka_log', array_slice($log, 0, 100), false);
    do_action('klicenka_login', $user, $entry['act'], $payload);
}

/**
 * A link from the installed tracker app carries a one-time code (60 s) instead of
 * the token; the token is collected for it from the tracker, server to server.
 */
function klicenka_redeem($code)
{
    $cfg = klicenka_config();
    if (!is_string($code) || !preg_match('/^[A-Za-z0-9_-]{20,100}$/', $code)) {
        return '';
    }
    $res = wp_remote_post($cfg['issuer'] . '/api/klicenka/handoff', array(
        'timeout'     => 5,
        'redirection' => 0,
        'headers'     => array('Content-Type' => 'application/json'),
        'body'        => wp_json_encode(array('code' => $code, 'audience' => $cfg['audience'] . '@' . $cfg['environment'])),
    ));
    if (is_wp_error($res) || (int) wp_remote_retrieve_response_code($res) !== 200) {
        return '';
    }
    $data = json_decode(wp_remote_retrieve_body($res), true);
    return (is_array($data) && isset($data['token']) && is_string($data['token'])) ? $data['token'] : '';
}

/**
 * Link with a one-time code: wp-admin/admin-ajax.php?action=klicenka_otevrit&k=…
 * (not wp-login.php?…code=…, which Safari's OAuth heuristic keeps inside the
 * installed tracker app). The old wp-login link from 1.1 still works.
 */
function klicenka_open_link()
{
    $code = isset($_GET['k']) ? wp_unslash($_GET['k']) : (isset($_GET['code']) ? wp_unslash($_GET['code']) : '');
    $token = klicenka_redeem($code);
    if ($token === '') {
        klicenka_fail('Přihlašovací odkaz vypršel nebo už byl použit. Klikněte v Klíčence znovu.');
    }
    klicenka_sign_in($token);
}
add_action('wp_ajax_nopriv_klicenka_otevrit', 'klicenka_open_link');
add_action('wp_ajax_klicenka_otevrit', 'klicenka_open_link');

add_action('login_form_klicenka', function () {
    $method = $_SERVER['REQUEST_METHOD'] ?? '';
    if ($method === 'GET' && (isset($_GET['code']) || isset($_GET['k']))) {
        klicenka_open_link();
    }
    if ($method !== 'POST') {
        klicenka_fail('Sem se přichází tlačítkem „Přihlásit se“ v Klíčence.', 405);
    }
    klicenka_sign_in(isset($_POST['token']) ? wp_unslash($_POST['token']) : '');
});

/** Verify the token, sign in exactly the named account, log the real person. */
function klicenka_sign_in($token)
{
    $payload = klicenka_verify($token);
    if (is_wp_error($payload)) {
        error_log('[klicenka] refused: ' . $payload->get_error_code());
        klicenka_fail($payload->get_error_message());
    }

    // Exactly the account the token names — never "the first admin".
    $sub = $payload['sub'];
    $user = is_email($sub) ? get_user_by('email', $sub) : get_user_by('login', $sub);
    if (!$user) {
        klicenka_fail(sprintf('Účet „%s“ na tomto webu neexistuje. Opravte ho v Klíčence.', $sub), 403);
    }

    $hours = (isset($payload['sh']) && is_numeric($payload['sh']) && $payload['sh'] > 0 && $payload['sh'] <= 72) ? (float) $payload['sh'] : 8;
    $ttl = (int) round($hours * 3600);
    $limit = function () use ($ttl) {
        return $ttl;
    };
    add_filter('auth_cookie_expiration', $limit, 99);
    wp_set_current_user($user->ID);
    wp_set_auth_cookie($user->ID, false, is_ssl());
    remove_filter('auth_cookie_expiration', $limit, 99);
    do_action('wp_login', $user->user_login, $user);

    klicenka_log($user, $payload);
    nocache_headers();
    wp_safe_redirect(klicenka_config()['redirect']);
    exit;
}

function klicenka_status()
{
    nocache_headers();
    $cfg = klicenka_config();
    $out = array('name' => 'klicenka', 'version' => KLICENKA_PLUGIN_VERSION, 'protocol' => 1, 'adapter' => 'wordpress');
    // The identifier and environment are the token's audience — public, and the
    // tracker reads them when the site is added.
    if ($cfg['audience'] !== '') {
        $out['audience'] = $cfg['audience'];
        $out['environment'] = $cfg['environment'];
    }
    wp_send_json($out);
}
add_action('wp_ajax_nopriv_klicenka_status', 'klicenka_status');
add_action('wp_ajax_klicenka_status', 'klicenka_status');
