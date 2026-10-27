<?php
/**
 * Plugin Name: Klíčenka – ověření Search Console
 * Description: Vloží do hlavičky webu značku google-site-verification, kterou pro tento web vydal Project Tracker (MYPIXEL). Nic jiného nedělá.
 * Version: 0.1.0
 * Requires PHP: 7.4
 * License: MIT
 *
 * Patří do wp-content/mu-plugins/ vedle klicenka.php (od 1.6.0 ho samoaktualizace přidá sama).
 * Značku si bere z <issuer>/api/gsc-overeni?host=<hostitel webu> (veřejná hodnota, bez tajemství)
 * a drží ji v autoload volbě: 24 h, když ji tracker má, 1 h, když ne. Obnovuje se z WP cronu
 * a při vykreslení stránky s prošlou hodnotou nejvýš jednou za tu dobu, s limitem 3 s; výpadek
 * trackeru stránku nezdrží víc a už stažená značka zůstane. Když se značka změní, smaže se
 * z cache stránek úvodní stránka (LiteSpeed, WP Rocket, W3TC, WP Super Cache, SiteGround).
 * Vypnout: define('KLICENKA_GSC_VERIFY', false);
 */

if (!defined('ABSPATH')) {
    exit;
}
// Načtený z mu-plugins i z klicenka.php (balíček pluginu v inc/): podruhé nic.
if (defined('KLICENKA_OVERENI_VERSION')) {
    return;
}

define('KLICENKA_OVERENI_VERSION', '0.1.0');
define('KLICENKA_OVERENI_OPTION', 'klicenka_overeni');

function klicenka_overeni_enabled()
{
    return !(defined('KLICENKA_GSC_VERIFY') && !KLICENKA_GSC_VERIFY);
}

/** Uložený stav: ['token' => string, 'checked' => int, 'ttl' => int]. */
function klicenka_overeni_state()
{
    $s = get_option(KLICENKA_OVERENI_OPTION);
    return is_array($s) ? $s : null;
}

/** Hodnota značky: jen znaky, které Google používá (base64url), rozumná délka. */
function klicenka_overeni_valid($t)
{
    return is_string($t) && preg_match('/^[A-Za-z0-9_\-+\/=]{8,200}$/', $t) === 1;
}

/**
 * Stáhne značku z trackeru, pokud je uložená prošlá (nebo $force). Nikdy nehází.
 * 200 + platná značka → 24 h; 404 → žádná značka, 1 h; chyba trackeru → stávající značka zůstane, zkusí se za 1 h.
 */
function klicenka_overeni_refresh($force = false)
{
    $state = klicenka_overeni_state();
    $now = time();
    if (!$force && $state && ($state['checked'] ?? 0) + ($state['ttl'] ?? 0) > $now) {
        return;
    }
    $old = $state ? (string) ($state['token'] ?? '') : '';
    // Nejdřív zapsat čas: souběžné požadavky už tracker znovu nevolají.
    update_option(KLICENKA_OVERENI_OPTION, array('token' => $old, 'checked' => $now, 'ttl' => HOUR_IN_SECONDS), true);

    $issuer = function_exists('klicenka_config') ? klicenka_config()['issuer']
        : rtrim(defined('KLICENKA_ISSUER') ? KLICENKA_ISSUER : 'https://tracker.mypixel.cz', '/');
    $host = strtolower((string) wp_parse_url(home_url('/'), PHP_URL_HOST));
    if ($host === '') {
        return;
    }
    $res = wp_remote_get($issuer . '/api/gsc-overeni?host=' . rawurlencode($host), array('timeout' => 3, 'redirection' => 0));
    $code = is_wp_error($res) ? 0 : (int) wp_remote_retrieve_response_code($res);
    if ($code === 200) {
        $data = json_decode(wp_remote_retrieve_body($res), true);
        $token = is_array($data) && isset($data['token']) && klicenka_overeni_valid($data['token']) ? $data['token'] : '';
    } elseif ($code === 404) {
        $token = '';
    } else {
        // Tracker neodpověděl: nechat, co bylo.
        return;
    }
    update_option(KLICENKA_OVERENI_OPTION, array('token' => $token, 'checked' => $now, 'ttl' => $token !== '' ? DAY_IN_SECONDS : HOUR_IN_SECONDS), true);
    if ($token !== '' && $token !== $old) {
        klicenka_overeni_purge_home();
    }
}

/** Úvodní stránka v cache by značku neměla, dokud cache nevyprší — smazat ji u běžných pluginů. */
function klicenka_overeni_purge_home()
{
    $home = home_url('/');
    try {
        do_action('litespeed_purge_url', $home);
        if (function_exists('rocket_clean_home')) {
            rocket_clean_home();
        }
        if (function_exists('w3tc_flush_url')) {
            w3tc_flush_url($home);
        }
        if (function_exists('wpsc_delete_url_cache')) {
            wpsc_delete_url_cache($home);
        }
        if (function_exists('sg_cachepress_purge_cache')) {
            sg_cachepress_purge_cache($home);
        }
    } catch (\Throwable $e) {
        error_log('[klicenka-overeni] purge: ' . get_class($e));
    }
}

add_action('wp_head', function () {
    if (!klicenka_overeni_enabled() || is_admin() || is_feed()) {
        return;
    }
    klicenka_overeni_refresh();
    $state = klicenka_overeni_state();
    $token = $state ? (string) ($state['token'] ?? '') : '';
    if (klicenka_overeni_valid($token)) {
        echo '<meta name="google-site-verification" content="' . esc_attr($token) . '" />' . "\n";
    }
}, 1);

// Obnova na pozadí (WP cron), ať se značka objeví i na webech, kde stránky jdou z cache.
add_action('klicenka_overeni_refresh', function () {
    if (klicenka_overeni_enabled()) {
        klicenka_overeni_refresh();
    }
});
add_action('init', function () {
    if (klicenka_overeni_enabled() && !wp_next_scheduled('klicenka_overeni_refresh')) {
        wp_schedule_event(time() + 60, 'hourly', 'klicenka_overeni_refresh');
    }
});
