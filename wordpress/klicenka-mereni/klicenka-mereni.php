<?php
/**
 * Plugin Name: Klíčenka – měření návštěvnosti
 * Description: Vloží do hlavičky webu měřicí skript Project Trackeru (MYPIXEL), bez cookies a bez lišty se souhlasem. Nic jiného nedělá.
 * Version: 0.1.1
 * Requires PHP: 7.4
 * License: MIT
 *
 * Patří do wp-content/mu-plugins/ vedle klicenka.php (od 1.7.0 ho samoaktualizace přidá sama).
 * Na wp_head vypíše <script defer src="<issuer>/n.js" data-site="<KLICENKA_AUDIENCE>">; skript pošle
 * zobrazení na <issuer>/api/n, který web pozná podle identifikátoru a domény. Bez cookies, bez IP.
 * Nevypisuje se přihlášeným, kdo smí upravovat obsah (správci, redaktoři, autoři), v administraci,
 * v kanálech, REST, AMP, náhledech, přizpůsobení vzhledu ani ve vložených příspěvcích (embed).
 * Na stránce jen jednou: když ho už někdo zařadil přes wp_enqueue_script nebo je definovaná
 * KLICENKA_TRAFFIC_TAG (konstanta „značka už je na stránce“, nastavuje ji i tenhle soubor),
 * nevypíše se. Šablona s tagem natvrdo: stačí define('KLICENKA_TRAFFIC', false), n.js se navíc
 * na jedné stránce spustí nejvýš jednou.
 * Vypnout: define('KLICENKA_TRAFFIC', false); pak se ani nepřidá.
 */

if (!defined('ABSPATH')) {
    exit;
}
// Načtený z mu-plugins i z klicenka.php (balíček pluginu v inc/): podruhé nic.
if (defined('KLICENKA_MERENI_VERSION')) {
    return;
}

define('KLICENKA_MERENI_VERSION', '0.1.1');

function klicenka_mereni_enabled()
{
    return !(defined('KLICENKA_TRAFFIC') && !KLICENKA_TRAFFIC);
}

/** Vydavatel (tracker) z konfigurace Klíčenky, ať měří i testovací tracker. */
function klicenka_mereni_issuer()
{
    if (function_exists('klicenka_config')) {
        return klicenka_config()['issuer'];
    }
    return rtrim(defined('KLICENKA_ISSUER') ? KLICENKA_ISSUER : 'https://tracker.mypixel.cz', '/');
}

function klicenka_mereni_audience()
{
    if (function_exists('klicenka_config')) {
        return (string) klicenka_config()['audience'];
    }
    return defined('KLICENKA_AUDIENCE') ? (string) KLICENKA_AUDIENCE : '';
}

/** Kdy se neměří: administrace, kanály, REST, AMP, náhledy, přizpůsobení, embed a přihlášení s právem upravovat. */
function klicenka_mereni_skip()
{
    if (is_admin() || is_feed() || is_embed() || is_preview() || is_customize_preview()) {
        return true;
    }
    if ((defined('REST_REQUEST') && REST_REQUEST) || wp_doing_ajax() || wp_doing_cron() || (function_exists('wp_is_json_request') && wp_is_json_request())) {
        return true;
    }
    if ((function_exists('amp_is_request') && amp_is_request())
        || (function_exists('is_amp_endpoint') && is_amp_endpoint())
        || (function_exists('ampforwp_is_amp_endpoint') && ampforwp_is_amp_endpoint())) {
        return true;
    }
    // Správci a redaktoři (i autoři) by zkreslovali čísla; přihlášení zákazníci e-shopu se měří.
    return is_user_logged_in() && current_user_can('edit_posts');
}

/** Už je na stránce: náš příznak, nebo n.js z trackeru zařazený přes wp_enqueue_script. */
function klicenka_mereni_present($src)
{
    if (defined('KLICENKA_TRAFFIC_TAG')) {
        return true;
    }
    $scripts = function_exists('wp_scripts') ? wp_scripts() : null;
    if (!$scripts) {
        return false;
    }
    foreach ((array) $scripts->queue as $handle) {
        $s = isset($scripts->registered[$handle]) ? (string) $scripts->registered[$handle]->src : '';
        if ($s !== '' && strtok($s, '?#') === $src) {
            return true;
        }
    }
    return false;
}

/**
 * Stránky z mezipaměti by měřicí značku neměly, dokud mezipaměť sama nevyprší — po nasazení
 * (nebo nové verzi) tohoto souboru se proto jednou vyčistí celá mezipaměť stránek.
 */
function klicenka_mereni_purge_all()
{
    try {
        do_action('litespeed_purge_all');
        if (function_exists('rocket_clean_domain')) {
            rocket_clean_domain();
        }
        if (function_exists('w3tc_flush_all')) {
            w3tc_flush_all();
        }
        if (function_exists('wp_cache_clear_cache')) {
            wp_cache_clear_cache();
        }
        if (function_exists('sg_cachepress_purge_cache')) {
            sg_cachepress_purge_cache();
        }
        do_action('hostinger_purge_cache');
    } catch (\Throwable $e) {
        error_log('[klicenka-mereni] purge: ' . get_class($e));
    }
}
add_action('init', function () {
    if (defined('KLICENKA_TRAFFIC') && !KLICENKA_TRAFFIC) {
        return;
    }
    if (get_option('klicenka_mereni_purged') !== KLICENKA_MERENI_VERSION) {
        update_option('klicenka_mereni_purged', KLICENKA_MERENI_VERSION, false);
        klicenka_mereni_purge_all();
    }
}, 20);

add_action('wp_head', function () {
    if (!klicenka_mereni_enabled() || klicenka_mereni_skip()) {
        return;
    }
    $src = klicenka_mereni_issuer() . '/n.js';
    if (klicenka_mereni_present($src)) {
        return;
    }
    define('KLICENKA_TRAFFIC_TAG', true);
    $attrs = array('defer' => true, 'src' => esc_url_raw($src));
    $audience = klicenka_mereni_audience();
    if ($audience !== '') {
        // n.js pošle data-site jako identifikátor; tracker podle něj najde produkční web a ověří doménu.
        $attrs['data-site'] = $audience;
    }
    // LiteSpeed: neslučovat ani nepřesouvat (n.js bere adresu sběru ze svého src).
    $attrs['data-no-optimize'] = '1';
    $attrs['id'] = 'klicenka-mereni';
    if (function_exists('wp_print_script_tag')) {
        // Od WP 5.7; filtr wp_script_attributes umožní pluginům s CSP přidat nonce.
        wp_print_script_tag($attrs);
        return;
    }
    $html = '<script';
    foreach ($attrs as $k => $v) {
        $html .= $v === true ? ' ' . $k : ' ' . $k . '="' . esc_attr($v) . '"';
    }
    echo $html . "></script>\n";
}, 99);
