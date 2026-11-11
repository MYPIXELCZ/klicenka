<?php
/**
 * Jen pro test klicenka-beta (WP Playground): zapisuje, co by se na webu opravdu stalo – e-mail až k PHPMaileru,
 * odchozí požadavky, napojení po odeslání, úlohy na později – a nabízí stav a přepínače přes REST.
 */
if (!defined('ABSPATH')) {
    exit;
}

function kbt_log($what, $data = null)
{
    $log = get_option('kbt_log', array());
    $log[] = array('what' => $what, 'data' => $data);
    update_option('kbt_log', $log, false);
}

// Každý pokus o e-mail (filtr wp_mail běží před pre_wp_mail) a každý, který došel až k PHPMaileru.
add_filter('wp_mail', function ($atts) {
    kbt_log('wp_mail', array('to' => $atts['to'], 'subject' => $atts['subject']));
    return $atts;
}, 1);
add_action('phpmailer_init', function () {
    kbt_log('phpmailer');
}, 1);
add_action('wp_mail_succeeded', function () {
    kbt_log('mail_sent');
});
add_action('wp_mail_failed', function () {
    kbt_log('mail_failed');
});
// Skutečně provedený odchozí požadavek.
add_action('http_api_debug', function ($response, $context, $class, $args, $url) {
    kbt_log('http', (string) parse_url($url, PHP_URL_HOST));
}, 10, 5);
// V Playgroundu nic ven: kromě místního „trackeru“ (JWKS, manifest) spy zablokuje vše (zkušební režim, když běží,
// rozhoduje až po něm a zapíše si, kam to mělo jít).
add_filter('pre_http_request', function ($pre, $args, $url) {
    $host = (string) parse_url($url, PHP_URL_HOST);
    if ($host === '127.0.0.1' || $host === 'localhost') {
        return $pre;
    }
    kbt_log('http_blocked_by_spy', $host);
    return new WP_Error('kbt_offline', 'Test bez sítě.');
}, 5, 3);

// „Napojení“ formulářů: po dokončení (tohle zkušební režim odstraní) a během zpracování (zůstane, ale nic neodejde ven
// a nic se neodloží na později).
add_action('wpforms_process_complete', function () {
    kbt_log('wpf_complete_hook');
    wp_remote_post('https://hook.example.test/wpforms');
}, 10, 0);
add_action('wpforms_process', function () {
    kbt_log('wpf_process_hook');
    wp_remote_post('https://kept.example.test/wpforms');
    wp_schedule_single_event(time() + 3600, 'kbt_later', array(wp_rand()));
    if (function_exists('as_enqueue_async_action')) {
        as_enqueue_async_action('kbt_as', array(wp_rand()), 'kbt');
    }
}, 10, 0);
add_action('elementor_pro/forms/new_record', function () {
    kbt_log('el_new_record_hook');
    wp_remote_post('https://hook.example.test/elementor');
}, 10, 0);

// Zkouška pojistky: ořezání akcí Elementoru vypnuté (záznam pak vznikne a musí se smazat).
if (get_option('kbt_noprune')) {
    add_filter('klicenka_beta_prune', '__return_false');
}

// Cizí zkratka pre_wp_mail (např. plugin pro SMTP): zkušební režim pak poštu za spolehlivě zadrženou nepovažuje.
if (get_option('kbt_shared_pre_wp_mail')) {
    add_filter('pre_wp_mail', function ($r) {
        return $r;
    }, 10);
}

add_action('rest_api_init', function () {
    register_rest_route('kbt/v1', '/state', array('methods' => 'GET', 'permission_callback' => '__return_true', 'callback' => function () {
        global $wpdb;
        $as = $wpdb->get_var("SHOW TABLES LIKE '{$wpdb->prefix}actionscheduler_actions'") ? (int) $wpdb->get_var("SELECT COUNT(*) FROM {$wpdb->prefix}actionscheduler_actions WHERE hook IN ('kbt_as', 'wpforms_process_entry_emails_meta_cleanup', 'wpforms_email_send') OR hook LIKE 'wpforms%email%'") : -1;
        $cron = 0;
        foreach ((array) _get_cron_array() as $hooks) {
            if (isset($hooks['kbt_later'])) {
                $cron += count($hooks['kbt_later']);
            }
        }
        $sub = $wpdb->get_var("SHOW TABLES LIKE '{$wpdb->prefix}e_submissions'") ? (int) $wpdb->get_var("SELECT COUNT(*) FROM {$wpdb->prefix}e_submissions") : -1;
        return array('log' => get_option('kbt_log', array()), 'as' => $as, 'cron' => $cron, 'submissions' => $sub, 'forms' => get_option('kbt_forms', array()), 'adminEmail' => get_option('admin_email'));
    }));
    register_rest_route('kbt/v1', '/set', array('methods' => 'POST', 'permission_callback' => '__return_true', 'callback' => function ($req) {
        $p = $req->get_json_params();
        if (!empty($p['reset'])) {
            update_option('kbt_log', array(), false);
        }
        if (isset($p['noprune'])) {
            update_option('kbt_noprune', $p['noprune'] ? 1 : 0, false);
        }
        if (isset($p['shared'])) {
            update_option('kbt_shared_pre_wp_mail', $p['shared'] ? 1 : 0, false);
        }
        return array('ok' => true);
    }));
});
