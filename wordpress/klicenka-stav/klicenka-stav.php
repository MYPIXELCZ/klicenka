<?php
/**
 * Plugin Name: Klíčenka – stav webu
 * Description: Pro kontrolu bezpečnosti v Project Trackeru vrací verze WordPressu, PHP, pluginů a šablon. Jen čtení, jen pro token z trackeru.
 * Version: 0.1.0
 * Requires PHP: 7.4
 * License: MIT
 *
 * Patří do wp-content/mu-plugins/ vedle klicenka.php (jakákoli verze 1.x), jehož konfiguraci a klíče používá.
 * Token: hlavička typ "klicenka-stav+jwt", claimy jako u Klíčenky (iss, aud, sub, act, jti, iat, exp)
 * a scope "stav"; nejvýš 60 s. Posílá se v "Authorization: Bearer …". Nikdy v URL.
 * Nic nemění, nepřihlašuje a nevrací žádná data obsahu ani uživatelů.
 */

if (!defined('ABSPATH')) {
    exit;
}

define('KLICENKA_STAV_VERSION', '0.1.0');
define('KLICENKA_STAV_TYP', 'klicenka-stav+jwt');

function klicenka_stav_token(WP_REST_Request $request)
{
    $auth = (string) $request->get_header('authorization');
    if ($auth === '' && isset($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) {
        $auth = (string) $_SERVER['REDIRECT_HTTP_AUTHORIZATION'];
    }
    return preg_match('/^\s*Bearer\s+(\S+)\s*$/i', $auth, $m) ? $m[1] : '';
}

/**
 * Vlastní ověření tokenu nad konfigurací a klíči z klicenka.php (funguje s 1.0–1.3):
 * EdDSA podpis klíčem z JWKS trackeru, typ klicenka-stav+jwt, náš issuer a audience,
 * nejvýš 60 s, jednorázové jti, scope "stav". Přihlašovací token sem neprojde a tento
 * token nikoho nepřihlásí.
 * @return true|WP_Error
 */
function klicenka_stav_authorize(WP_REST_Request $request)
{
    if (!function_exists('klicenka_config') || !function_exists('klicenka_keys') || !function_exists('klicenka_b64url_decode') || !function_exists('sodium_crypto_sign_verify_detached')) {
        return new WP_Error('config', 'Chybí klicenka.php v mu-plugins.', array('status' => 500));
    }
    $deny = function ($why) {
        return new WP_Error('unauthorized', $why, array('status' => 401));
    };
    $token = klicenka_stav_token($request);
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
    if (($header['alg'] ?? '') !== 'EdDSA' || ($header['typ'] ?? '') !== KLICENKA_STAV_TYP || empty($header['kid'])) {
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
    if (($payload['iss'] ?? '') !== $cfg['issuer'] || !in_array($cfg['audience'] . '@' . $cfg['environment'], $aud, true)) {
        return $deny('Token není pro tento web.');
    }
    if (!is_int($exp) || !is_int($iat) || $exp + $tol < $now || $iat - $tol > $now || $exp - $iat > 60) {
        return $deny('Token vypršel.');
    }
    if (($payload['scope'] ?? '') !== 'stav' || empty($payload['jti']) || !is_string($payload['jti'])) {
        return new WP_Error('forbidden', 'Token nemá oprávnění pro tuto akci.', array('status' => 403));
    }
    $jti_key = 'klicenka_stav_jti_' . md5($payload['jti']);
    if (get_transient($jti_key) !== false) {
        return $deny('Token už byl použit.');
    }
    set_transient($jti_key, 1, 180);
    return true;
}

function klicenka_stav_rest()
{
    if (!function_exists('get_plugins')) {
        require_once ABSPATH . 'wp-admin/includes/plugin.php';
    }
    global $wp_version;
    $plugin_updates = get_site_transient('update_plugins');
    $theme_updates = get_site_transient('update_themes');
    $core_updates = get_site_transient('update_core');

    $plugins = array();
    foreach (get_plugins() as $file => $p) {
        $slug = strpos($file, '/') !== false ? dirname($file) : basename($file, '.php');
        $update = isset($plugin_updates->response[$file]->new_version) ? (string) $plugin_updates->response[$file]->new_version : null;
        $plugins[] = array(
            'slug'    => $slug,
            'name'    => wp_strip_all_tags((string) $p['Name']),
            'version' => (string) $p['Version'],
            'active'  => is_plugin_active($file),
            'update'  => $update,
        );
    }

    $active_theme = get_stylesheet();
    $parent_theme = get_template();
    $themes = array();
    foreach (wp_get_themes() as $slug => $t) {
        $themes[] = array(
            'slug'    => (string) $slug,
            'name'    => wp_strip_all_tags((string) $t->get('Name')),
            'version' => (string) $t->get('Version'),
            'active'  => $slug === $active_theme || $slug === $parent_theme,
            'update'  => isset($theme_updates->response[$slug]['new_version']) ? (string) $theme_updates->response[$slug]['new_version'] : null,
        );
    }

    $core_update = null;
    if (isset($core_updates->updates) && is_array($core_updates->updates)) {
        foreach ($core_updates->updates as $u) {
            if (isset($u->response, $u->current) && $u->response === 'upgrade') {
                $core_update = (string) $u->current;
                break;
            }
        }
    }

    $response = new WP_REST_Response(array(
        'plugin'    => KLICENKA_STAV_VERSION,
        'wordpress' => array('version' => (string) $wp_version, 'update' => $core_update),
        'php'       => array('version' => PHP_VERSION),
        'plugins'   => $plugins,
        'themes'    => $themes,
    ));
    $response->header('Cache-Control', 'no-store');
    return $response;
}

add_action('rest_api_init', function () {
    register_rest_route('klicenka-stav/v1', '/stav', array(
        'methods'             => 'GET',
        'callback'            => 'klicenka_stav_rest',
        'permission_callback' => 'klicenka_stav_authorize',
    ));
});
