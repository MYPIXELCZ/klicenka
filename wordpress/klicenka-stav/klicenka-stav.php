<?php
/**
 * Plugin Name: Klíčenka – stav webu
 * Description: Pro kontrolu bezpečnosti v Project Trackeru vrací verze WordPressu, PHP, pluginů a šablon. Jen čtení, jen pro token z trackeru.
 * Version: 0.1.0
 * Requires PHP: 7.4
 * License: MIT
 *
 * Patří do wp-content/mu-plugins/ vedle klicenka.php (od verze 1.3.0), jehož ověření tokenu používá.
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

function klicenka_stav_authorize(WP_REST_Request $request)
{
    if (!function_exists('klicenka_verify') || !defined('KLICENKA_PLUGIN_VERSION') || version_compare(KLICENKA_PLUGIN_VERSION, '1.3.0', '<')) {
        return new WP_Error('config', 'Chybí klicenka.php 1.3.0 nebo novější v mu-plugins.', array('status' => 500));
    }
    $token = klicenka_stav_token($request);
    if ($token === '') {
        return new WP_Error('unauthorized', 'Chybí token.', array('status' => 401));
    }
    $payload = klicenka_verify($token, array('typ' => KLICENKA_STAV_TYP, 'max_ttl' => 60, 'single_use' => true));
    if (is_wp_error($payload)) {
        return new WP_Error('unauthorized', $payload->get_error_message(), array('status' => 401));
    }
    if (($payload['scope'] ?? '') !== 'stav') {
        return new WP_Error('forbidden', 'Token nemá oprávnění pro tuto akci.', array('status' => 403));
    }
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
