<?php
/**
 * JEN PRO TEST na WP Playground. Nikdy nedávat na skutečný web.
 * Podstrčí „aktualizace“ testovacího pluginu a šablony z lokálních zipů, zablokuje volání wordpress.org
 * a vystaví nechráněný endpoint pro nastavení a čtení stavu.
 */

if (!defined('ABSPATH')) {
    exit;
}

add_filter('pre_http_request', function ($pre, $args, $url) {
    $host = (string) wp_parse_url($url, PHP_URL_HOST);
    if (preg_match('/(^|\.)wordpress\.org$/', $host)) {
        return new WP_Error('kut-offline', 'Test bez wordpress.org');
    }
    return $pre;
}, 10, 3);

add_filter('site_transient_update_plugins', function ($t) {
    $pkg = get_option('kut_plugin_package');
    if (!$pkg) {
        return $t;
    }
    if (!is_object($t)) {
        $t = new stdClass();
    }
    if (!isset($t->response) || !is_array($t->response)) {
        $t->response = array();
    }
    $t->response['kut-dummy/kut-dummy.php'] = (object) array(
        'slug' => 'kut-dummy', 'plugin' => 'kut-dummy/kut-dummy.php', 'new_version' => (string) get_option('kut_plugin_version'), 'package' => $pkg, 'url' => '',
    );
    return $t;
});

add_filter('site_transient_update_themes', function ($t) {
    $pkg = get_option('kut_theme_package');
    if (!$pkg) {
        return $t;
    }
    if (!is_object($t)) {
        $t = new stdClass();
    }
    if (!isset($t->response) || !is_array($t->response)) {
        $t->response = array();
    }
    $t->response['kut-theme'] = array('theme' => 'kut-theme', 'new_version' => (string) get_option('kut_theme_version'), 'package' => $pkg, 'url' => '');
    return $t;
});

add_action('rest_api_init', function () {
    register_rest_route('kut/v1', '/set', array(
        'methods' => 'POST',
        'permission_callback' => '__return_true',
        'callback' => function (WP_REST_Request $r) {
            foreach ((array) $r->get_json_params() as $k => $v) {
                if (in_array($k, array('kut_plugin_package', 'kut_plugin_version', 'kut_theme_package', 'kut_theme_version', 'blogname'), true)) {
                    update_option($k, $v);
                }
            }
            return array('ok' => true);
        },
    ));
    register_rest_route('kut/v1', '/state', array(
        'methods' => 'GET',
        'permission_callback' => '__return_true',
        'callback' => function () {
            if (!function_exists('get_plugins')) {
                require_once ABSPATH . 'wp-admin/includes/plugin.php';
            }
            wp_clean_plugins_cache(false);
            wp_cache_delete('alloptions', 'options');
            $p = get_plugins();
            $t = wp_get_theme('kut-theme');
            return array(
                'pluginVersion' => isset($p['kut-dummy/kut-dummy.php']) ? $p['kut-dummy/kut-dummy.php']['Version'] : null,
                'pluginActive'  => in_array('kut-dummy/kut-dummy.php', (array) get_option('active_plugins'), true),
                'themeVersion'  => $t->exists() ? $t->get('Version') : null,
                'blogname'      => get_option('blogname'),
            );
        },
    ));
});
