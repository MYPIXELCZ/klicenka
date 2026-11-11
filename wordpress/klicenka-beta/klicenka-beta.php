<?php
/**
 * Plugin Name: Klíčenka – zkoušky bety
 * Description: Zkušební režim pro automatické zkoušky formulářů z Project Trackeru (MYPIXEL). Bez platného podpisu z trackeru nedělá vůbec nic.
 * Version: 0.1.0
 * Requires PHP: 7.4
 * License: MIT
 *
 * Patří do wp-content/mu-plugins/ vedle klicenka.php (od verze 1.8.0), jehož ověření tokenu používá.
 * Na web se dostane jen na výslovný pokyn z trackeru (claim "install"), sám od sebe nikdy.
 *
 * Požadavek ve zkušebním režimu nese hlavičku "X-Klicenka-Test: <token>" (typ "klicenka-beta+jwt", scope "test",
 * platnost nejvýš 120 s, jednorázový, adresát tento web). Bez hlavičky, s neplatným nebo prošlým tokenem se
 * nezaregistruje ani jeden háček a web se chová přesně jako bez tohoto souboru.
 *
 * Ve zkušebním požadavku:
 *  - žádný e-mail neodejde (pre_wp_mail, pojistka v PHPMaileru); komu a s jakým předmětem by odešel, se vrátí
 *    trackeru v hlavičce odpovědi "X-Klicenka-Beta" (base64url JSON),
 *  - od chvíle, kdy začne zpracování formuláře, WordPress neudělá žádný odchozí požadavek (pre_http_request),
 *    takže se nespustí webhooky ani zápisy do newsletterů; jen ověření captchy (reCAPTCHA, hCaptcha, Turnstile)
 *    dostane smyšlenou kladnou odpověď,
 *  - nic se neodloží na později: úlohy Action Scheduleru a WP-Cronu se nezaloží (odložený e-mail by jinak
 *    odešel až v dalším požadavku, mimo zkušební režim),
 *  - formulář Elementoru Pro spustí jen akce e-mail a přesměrování; WPForms jen upozornění e-mailem
 *    (bez ukládání, napojení a plateb); záznam v přehledu odeslaných formulářů nevznikne, a kdyby přece
 *    vznikl, smaže se,
 *  - ochrana proti robotům (honeypot, časový limit, token, captcha) se přeskočí,
 *  - stav hlásí wp-admin/admin-ajax.php?action=klicenka_beta_status.
 *
 * Formulář se odesílá na admin-ajax.php s action=klicenka_beta_submit a skutečnou akcí v poli
 * "klicenka_beta_action" (elementor_pro_forms_send_form | wpforms_submit). Web bez zkušebního režimu takovou akci
 * nezná a neudělá nic, takže zkušební odeslání nemůže skončit jako skutečná poptávka.
 */

if (!defined('ABSPATH')) {
    exit;
}

define('KLICENKA_BETA_VERSION', '0.1.0');
define('KLICENKA_BETA_TYP', 'klicenka-beta+jwt');
define('KLICENKA_BETA_TTL', 120);

/** Akce formulářů, které smí zkušební odeslání spustit. */
function klicenka_beta_submit_actions()
{
    return array('elementor_pro_forms_send_form', 'wpforms_submit');
}

/** Ověří token z hlavičky; jen s platným zapne zkušební režim. */
function klicenka_beta_boot()
{
    static $done = false;
    if ($done) {
        return;
    }
    $done = true;
    $token = isset($_SERVER['HTTP_X_KLICENKA_TEST']) ? trim((string) $_SERVER['HTTP_X_KLICENKA_TEST']) : '';
    if ($token === '' || !function_exists('klicenka_verify')) {
        return;
    }
    $payload = klicenka_verify($token, array('typ' => KLICENKA_BETA_TYP, 'max_ttl' => KLICENKA_BETA_TTL, 'single_use' => true));
    if (is_wp_error($payload) || ($payload['scope'] ?? '') !== 'test') {
        return;
    }
    klicenka_beta_start($payload);
}

function klicenka_beta_start($payload)
{
    if (defined('KLICENKA_BETA_TEST')) {
        return;
    }
    define('KLICENKA_BETA_TEST', true);
    $marks = array();
    foreach ((isset($payload['marks']) && is_array($payload['marks'])) ? $payload['marks'] : array() as $m) {
        if (is_string($m) && strlen($m) >= 6) {
            $marks[] = $m;
        }
    }
    $GLOBALS['klicenka_beta'] = array(
        'mails' => array(), 'http' => array(), 'captcha' => 0, 'deferred' => 0, 'actions' => null, 'skipped' => array(),
        'cleaned' => 0, 'notes' => array(), 'marks' => array_slice($marks, 0, 5), 'before' => null, 'wpf_before' => null,
        'submit' => false, 'plugin' => null, 'locked' => false,
    );

    // Pošta: nic neodejde, celý požadavek. První v pořadí (zachytí) a pojistka v PHPMaileru, kdyby někdo zkratku obešel.
    add_filter('pre_wp_mail', 'klicenka_beta_mail', -PHP_INT_MAX, 2);
    add_action('phpmailer_init', 'klicenka_beta_phpmailer', PHP_INT_MAX);

    add_action('wp_ajax_nopriv_klicenka_beta_status', 'klicenka_beta_status');
    add_action('wp_ajax_klicenka_beta_status', 'klicenka_beta_status');

    // Zkušební odeslání formuláře: skutečná akce je v poli klicenka_beta_action. Se zkušebním tokenem se stejně
    // chrání i odeslání přímo skutečnou akcí; mimo admin-ajax (WPForms bez AJAXu na stránce) se odmítne.
    $action = isset($_POST['action']) ? (string) $_POST['action'] : '';
    $real = isset($_POST['klicenka_beta_action']) ? (string) $_POST['klicenka_beta_action'] : '';
    if ($action !== 'klicenka_beta_submit' && in_array($action, klicenka_beta_submit_actions(), true)) {
        $real = $action;
        $action = 'klicenka_beta_submit';
    }
    if ((!defined('DOING_AJAX') || !DOING_AJAX) && (isset($_POST['wpforms']) || isset($_POST['form_fields']))) {
        $GLOBALS['klicenka_beta']['notes'][] = 'refused:not-ajax';
        klicenka_beta_header();
        status_header(409);
        nocache_headers();
        exit;
    }
    if ($action === 'klicenka_beta_submit' && in_array($real, klicenka_beta_submit_actions(), true)) {
        $GLOBALS['klicenka_beta']['submit'] = true;
        $GLOBALS['klicenka_beta']['plugin'] = $real === 'wpforms_submit' ? 'wpforms' : 'elementor';
        $_POST['action'] = $real;
        $_REQUEST['action'] = $real;
        unset($_POST['klicenka_beta_action'], $_REQUEST['klicenka_beta_action'], $_GET['action']);
        // Těsně před obsluhou formuláře (admin-ajax ji volá s prioritou 10): pojistky a ořezání akcí.
        add_action('wp_ajax_nopriv_' . $real, 'klicenka_beta_lock', -PHP_INT_MAX);
        add_action('wp_ajax_' . $real, 'klicenka_beta_lock', -PHP_INT_MAX);
        klicenka_beta_elementor();
        klicenka_beta_wpforms();
        add_action('shutdown', 'klicenka_beta_cleanup', 0);
    }
    klicenka_beta_header();
}

/** Jde na tomhle webu poštu spolehlivě zadržet? Vrací '' nebo důvod, proč ne. */
function klicenka_beta_mail_unsafe()
{
    global $wp_version, $wp_filter;
    if (version_compare((string) $wp_version, '5.7', '<')) {
        return 'wordpress-old';
    }
    if (!function_exists('wp_mail')) {
        return 'wp-mail-missing';
    }
    try {
        $file = wp_normalize_path((string) (new ReflectionFunction('wp_mail'))->getFileName());
    } catch (\Throwable $e) {
        return 'wp-mail-unknown';
    }
    if ($file !== wp_normalize_path(ABSPATH . WPINC . '/pluggable.php')) {
        // Jiný plugin si wp_mail nahradil vlastní funkcí: zkratka pre_wp_mail v ní být nemusí.
        return 'wp-mail-replaced';
    }
    if (isset($wp_filter['pre_wp_mail'])) {
        foreach ($wp_filter['pre_wp_mail']->callbacks as $list) {
            foreach ($list as $cb) {
                if ($cb['function'] !== 'klicenka_beta_mail') {
                    return 'pre-wp-mail-shared';
                }
            }
        }
    }
    if (function_exists('CF7DBPlugin_init')) {
        // Elementor Pro by odeslání zapsal do Contact Form DB mimo své akce.
        return 'cf7db';
    }
    return '';
}

/**
 * Těsně před obsluhou formuláře: když poštu nejde spolehlivě zadržet (nebo jde o platební formulář), zkouška
 * skončí dřív, než cokoli odejde. Jinak od teď nic ven a nic na později.
 */
function klicenka_beta_lock()
{
    if ($GLOBALS['klicenka_beta']['locked']) {
        return;
    }
    $GLOBALS['klicenka_beta']['locked'] = true;
    $why = klicenka_beta_mail_unsafe();
    if ($why === '' && $GLOBALS['klicenka_beta']['plugin'] === 'wpforms') {
        $why = klicenka_beta_wpforms_unsafe();
    }
    if ($why !== '') {
        $GLOBALS['klicenka_beta']['notes'][] = 'refused:' . $why;
        klicenka_beta_header();
        nocache_headers();
        wp_send_json(array('ok' => false, 'test' => true, 'error' => 'unsafe', 'reason' => $why), 409);
    }
    add_filter('pre_http_request', 'klicenka_beta_http', PHP_INT_MAX, 3);
    foreach (array('pre_as_enqueue_async_action', 'pre_as_schedule_single_action', 'pre_as_schedule_recurring_action', 'pre_as_schedule_cron_action') as $f) {
        add_filter($f, 'klicenka_beta_defer_as', PHP_INT_MAX);
    }
    add_filter('pre_schedule_event', 'klicenka_beta_defer_cron', PHP_INT_MAX, 2);
    if ($GLOBALS['klicenka_beta']['plugin'] === 'wpforms') {
        klicenka_beta_wpforms_prune();
    } else {
        klicenka_beta_drop('elementor_pro/forms/new_record');
    }
    klicenka_beta_header();
}

/** Odstraní všechny háčky dané akce a zapíše, co tam bylo (kvůli přehledu v trackeru). */
function klicenka_beta_drop($hook)
{
    global $wp_filter;
    if (empty($wp_filter[$hook]) || empty($wp_filter[$hook]->callbacks)) {
        return;
    }
    foreach ($wp_filter[$hook]->callbacks as $list) {
        foreach ($list as $cb) {
            $f = $cb['function'];
            $name = is_string($f) ? $f : (is_array($f) ? (is_object($f[0]) ? get_class($f[0]) : (string) $f[0]) . '::' . (string) $f[1] : 'closure');
            if (count($GLOBALS['klicenka_beta']['skipped']) < 20) {
                $GLOBALS['klicenka_beta']['skipped'][] = substr($hook . ':' . $name, 0, 120);
            }
        }
    }
    remove_all_actions($hook);
}

/** Úloha Action Scheduleru by se spustila až mimo zkušební režim: nezaloží se. */
function klicenka_beta_defer_as($pre)
{
    $GLOBALS['klicenka_beta']['deferred']++;
    klicenka_beta_header();
    return 0;
}

/** Totéž pro WP-Cron (wp_schedule_single_event a spol.). */
function klicenka_beta_defer_cron($pre, $event)
{
    $GLOBALS['klicenka_beta']['deferred']++;
    klicenka_beta_header();
    return false;
}

function klicenka_beta_addresses($v)
{
    $out = array();
    foreach (is_array($v) ? $v : explode(',', (string) $v) as $a) {
        $a = trim((string) $a);
        if (preg_match('/<([^>]+)>/', $a, $m)) {
            $a = trim($m[1]);
        }
        if ($a !== '') {
            $out[] = substr($a, 0, 120);
        }
    }
    return array_slice($out, 0, 6);
}

/** pre_wp_mail: e-mail se neodešle, jen se zapíše, komu a s jakým předmětem měl jít. */
function klicenka_beta_mail($null, $atts)
{
    $subject = (string) ($atts['subject'] ?? '');
    $mail = array('to' => klicenka_beta_addresses(isset($atts['to']) ? $atts['to'] : ''), 'subject' => function_exists('mb_substr') ? mb_substr($subject, 0, 160) : substr($subject, 0, 160));
    $headers = isset($atts['headers']) ? $atts['headers'] : array();
    if (!is_array($headers)) {
        $headers = explode("\n", str_replace("\r\n", "\n", (string) $headers));
    }
    foreach ($headers as $h) {
        if (!is_string($h) || strpos($h, ':') === false) {
            continue;
        }
        list($name, $value) = explode(':', $h, 2);
        $name = strtolower(trim($name));
        if ($name === 'cc' || $name === 'bcc' || $name === 'from' || $name === 'reply-to') {
            $key = $name === 'reply-to' ? 'replyTo' : $name;
            $mail[$key] = array_merge(isset($mail[$key]) ? $mail[$key] : array(), klicenka_beta_addresses($value));
        }
    }
    // Obsahuje e-mail zkušební hodnotu? (Že se do něj dostala data z formuláře.)
    $message = isset($atts['message']) ? (string) $atts['message'] : '';
    $mail['marked'] = false;
    foreach ($GLOBALS['klicenka_beta']['marks'] as $m) {
        if (strpos($message, $m) !== false || strpos($subject, $m) !== false) {
            $mail['marked'] = true;
        }
    }
    if (count($GLOBALS['klicenka_beta']['mails']) < 6) {
        $GLOBALS['klicenka_beta']['mails'][] = $mail;
    }
    klicenka_beta_header();
    return true;
}

/** Pojistka: kdyby se ve zkušebním požadavku přece dostalo až k PHPMaileru, zůstane bez příjemců a neodešle. */
function klicenka_beta_phpmailer($phpmailer)
{
    $GLOBALS['klicenka_beta']['notes'][] = 'phpmailer-reached';
    if (is_object($phpmailer) && method_exists($phpmailer, 'clearAllRecipients')) {
        $phpmailer->clearAllRecipients();
    }
    klicenka_beta_header();
}

/** pre_http_request: nic ven. Ověření captchy dostane smyšlenou kladnou odpověď. */
function klicenka_beta_http($pre, $args, $url)
{
    $host = strtolower((string) parse_url((string) $url, PHP_URL_HOST));
    $path = (string) parse_url((string) $url, PHP_URL_PATH);
    $captcha = (in_array($host, array('www.google.com', 'google.com', 'www.recaptcha.net', 'recaptcha.net'), true) && strpos($path, '/recaptcha/api/siteverify') === 0)
        || (in_array($host, array('hcaptcha.com', 'api.hcaptcha.com'), true) && strpos($path, '/siteverify') === 0)
        || ($host === 'challenges.cloudflare.com' && strpos($path, '/turnstile/') === 0);
    if ($captcha) {
        $GLOBALS['klicenka_beta']['captcha']++;
        klicenka_beta_header();
        $body = wp_json_encode(array('success' => true, 'score' => 0.9, 'challenge_ts' => gmdate('c'), 'hostname' => (string) parse_url(home_url(), PHP_URL_HOST)));
        return array('headers' => array(), 'body' => $body, 'response' => array('code' => 200, 'message' => 'OK'), 'cookies' => array(), 'filename' => null);
    }
    if ($host !== '' && !in_array($host, $GLOBALS['klicenka_beta']['http'], true) && count($GLOBALS['klicenka_beta']['http']) < 10) {
        $GLOBALS['klicenka_beta']['http'][] = substr($host, 0, 80);
    }
    klicenka_beta_header();
    return new WP_Error('klicenka_beta_blocked', 'Zkouška z trackeru: odchozí požadavek je zablokovaný.');
}

/** Hlavička odpovědi s tím, co zkouška zachytila. Přepisuje se po každé události, dokud nezačal výstup. */
function klicenka_beta_header()
{
    if (headers_sent()) {
        return;
    }
    $b = $GLOBALS['klicenka_beta'];
    $out = array(
        'v' => 1, 'version' => KLICENKA_BETA_VERSION, 'test' => true, 'submit' => $b['submit'], 'plugin' => $b['plugin'],
        'mails' => $b['mails'], 'http' => $b['http'], 'captcha' => $b['captcha'], 'deferred' => $b['deferred'],
        'actions' => $b['actions'], 'skipped' => $b['skipped'], 'cleaned' => $b['cleaned'], 'notes' => array_slice($b['notes'], 0, 8),
    );
    header('X-Klicenka-Beta: ' . rtrim(strtr(base64_encode((string) wp_json_encode($out)), '+/', '-_'), '='), true);
}

/** Stav pro tracker (jen s platným tokenem): je zkušební režim zapnutý a jde poštu spolehlivě zadržet? */
function klicenka_beta_status()
{
    global $wp_version;
    nocache_headers();
    $unsafe = klicenka_beta_mail_unsafe();
    wp_send_json(array(
        'ok' => true, 'test' => true, 'name' => 'klicenka-beta', 'version' => KLICENKA_BETA_VERSION,
        'mailSafe' => $unsafe === '', 'mailReason' => $unsafe === '' ? null : $unsafe,
        'wordpress' => (string) $wp_version, 'php' => PHP_VERSION,
        'elementorPro' => defined('ELEMENTOR_PRO_VERSION') ? ELEMENTOR_PRO_VERSION : null,
        'wpforms' => defined('WPFORMS_VERSION') ? WPFORMS_VERSION : null,
        'woocommerce' => defined('WC_VERSION') ? WC_VERSION : null,
    ));
}

/* ------------------------------------------------------------------ */
/* Elementor Pro                                                        */
/* ------------------------------------------------------------------ */

function klicenka_beta_elementor()
{
    // Před akcemi po odeslání: nechat jen e-mail a přesměrování (žádné ukládání, newslettery, webhooky).
    add_action('elementor_pro/forms/validation', 'klicenka_beta_elementor_prune', -PHP_INT_MAX, 2);
}

function klicenka_beta_table_max($table, $column)
{
    global $wpdb;
    if ($wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s', $wpdb->esc_like($table))) !== $table) {
        return null;
    }
    return (int) $wpdb->get_var("SELECT COALESCE(MAX(`{$column}`), 0) FROM `{$table}`");
}

function klicenka_beta_elementor_prune($record, $ajax_handler)
{
    global $wpdb;
    $keep = array('email', 'email2', 'redirect');
    $actions = is_object($record) && method_exists($record, 'get_form_settings') ? $record->get_form_settings('submit_actions') : null;
    $actions = is_array($actions) ? array_values(array_map('strval', $actions)) : array();
    $GLOBALS['klicenka_beta']['actions'] = array_slice($actions, 0, 20);
    foreach (array_diff($actions, $keep) as $a) {
        if (count($GLOBALS['klicenka_beta']['skipped']) < 20) {
            $GLOBALS['klicenka_beta']['skipped'][] = substr((string) $a, 0, 120);
        }
    }
    $GLOBALS['klicenka_beta']['before'] = klicenka_beta_table_max($wpdb->prefix . 'e_submissions', 'id');
    if (apply_filters('klicenka_beta_prune', true)) {
        try {
            $registrar = \ElementorPro\Modules\Forms\Module::instance()->actions_registrar;
            $class = new ReflectionClass($registrar);
            while ($class && !$class->hasProperty('items')) {
                $class = $class->getParentClass();
            }
            if ($class) {
                $prop = $class->getProperty('items');
                $prop->setAccessible(true);
                $items = (array) $prop->getValue($registrar);
                foreach ($items as $id => $action) {
                    $name = (is_object($action) && method_exists($action, 'get_name')) ? (string) $action->get_name() : (string) $id;
                    if (!in_array($name, $keep, true)) {
                        unset($items[$id]);
                    }
                }
                $prop->setValue($registrar, $items);
            } else {
                $GLOBALS['klicenka_beta']['notes'][] = 'prune:no-items';
            }
        } catch (\Throwable $e) {
            $GLOBALS['klicenka_beta']['notes'][] = 'prune:failed';
        }
    }
    klicenka_beta_header();
}

/**
 * Po zkoušce: smazat záznam, který by zkouška přece jen založila v přehledu odeslaných formulářů (Elementor,
 * WPForms Pro). Maže jen záznamy novější než před zkouškou, které obsahují zkušební hodnotu z tokenu (claim "marks").
 */
function klicenka_beta_cleanup()
{
    global $wpdb;
    $b = $GLOBALS['klicenka_beta'];
    if (!$b['marks']) {
        return;
    }
    if ($b['before'] !== null) {
        $t = $wpdb->prefix . 'e_submissions';
        $in = implode(',', array_fill(0, count($b['marks']), '%s'));
        $ids = $wpdb->get_col($wpdb->prepare(
            "SELECT DISTINCT s.id FROM `{$t}` s INNER JOIN `{$t}_values` v ON v.submission_id = s.id WHERE s.id > %d AND v.value IN ({$in}) LIMIT 5",
            array_merge(array((int) $b['before']), $b['marks'])
        ));
        foreach ((array) $ids as $id) {
            $wpdb->delete($t . '_values', array('submission_id' => (int) $id));
            $wpdb->delete($t . '_actions_log', array('submission_id' => (int) $id));
            $wpdb->delete($t, array('id' => (int) $id));
            $GLOBALS['klicenka_beta']['cleaned']++;
        }
    }
    if ($b['wpf_before'] !== null) {
        $t = $wpdb->prefix . 'wpforms_entries';
        $like = array();
        foreach ($b['marks'] as $m) {
            $like[] = $wpdb->prepare('fields LIKE %s', '%' . $wpdb->esc_like($m) . '%');
        }
        $ids = $wpdb->get_col($wpdb->prepare("SELECT entry_id FROM `{$t}` WHERE entry_id > %d AND (" . implode(' OR ', $like) . ') LIMIT 5', (int) $b['wpf_before']));
        foreach ((array) $ids as $id) {
            $entry = function_exists('wpforms') ? wpforms()->obj('entry') : null;
            if ($entry && method_exists($entry, 'delete')) {
                $entry->delete((int) $id);
            } else {
                $wpdb->delete($t, array('entry_id' => (int) $id));
            }
            $GLOBALS['klicenka_beta']['cleaned']++;
        }
    }
    klicenka_beta_header();
}

/* ------------------------------------------------------------------ */
/* WPForms (Lite i Pro)                                                 */
/* ------------------------------------------------------------------ */

function klicenka_beta_wpforms()
{
    // Ochrana proti robotům: server nespouští JavaScript, tak ji zkouška přeskočí (jen s platným tokenem).
    foreach (array('wpforms_process_anti_spam_honeypot_bypass', 'wpforms_process_anti_spam_direct_post_bypass', 'wpforms_process_time_limit_check_bypass', 'wpforms_process_bypass_captcha', 'wpforms_process_antispam') as $f) {
        add_filter($f, '__return_true', PHP_INT_MAX);
    }
    // E-mail odeslat hned, ne přes frontu („Optimize Email Sending“): odložený by odešel mimo zkušební režim.
    add_filter('wpforms_tasks_entry_emails_trigger_send_same_process', '__return_true', PHP_INT_MAX);
}

/** Platební formulář se nezkouší (platba by šla k bráně) a formulář musí existovat. */
function klicenka_beta_wpforms_unsafe()
{
    $id = isset($_POST['wpforms']['id']) ? absint($_POST['wpforms']['id']) : 0;
    if (!$id || !function_exists('wpforms') || !function_exists('wpforms_decode')) {
        return 'wpforms-missing';
    }
    $form = wpforms()->obj('form') ? wpforms()->obj('form')->get($id) : null;
    $data = $form ? wpforms_decode($form->post_content) : null;
    if (!is_array($data)) {
        return 'wpforms-form-missing';
    }
    foreach ((isset($data['fields']) && is_array($data['fields'])) ? $data['fields'] : array() as $f) {
        $type = isset($f['type']) ? (string) $f['type'] : '';
        if (strpos($type, 'payment') === 0 || in_array($type, array('credit-card', 'stripe-credit-card', 'square', 'paypal-commerce', 'authorize_net'), true)) {
            return 'payment-form';
        }
    }
    foreach ((isset($data['payments']) && is_array($data['payments'])) ? $data['payments'] : array() as $p) {
        if (is_array($p) && !empty($p['enable'])) {
            return 'payment-form';
        }
    }
    return '';
}

/** Po validaci nechat jen upozornění e-mailem a potvrzení: bez uložení, napojení (newslettery, CRM) a Lite Connect. */
function klicenka_beta_wpforms_prune()
{
    global $wpdb;
    $id = isset($_POST['wpforms']['id']) ? absint($_POST['wpforms']['id']) : 0;
    $GLOBALS['klicenka_beta']['wpf_before'] = klicenka_beta_table_max($wpdb->prefix . 'wpforms_entries', 'entry_id');
    if (!apply_filters('klicenka_beta_prune', true)) {
        return;
    }
    foreach (array('wpforms_process_entry_save', 'wpforms_process_entry_saved', 'wpforms_process_complete', 'wpforms_process_complete_' . $id, 'wpforms_process_after') as $hook) {
        klicenka_beta_drop($hook);
    }
}

// Bez hlavičky se nic neregistruje. klicenka.php se v mu-plugins načítá až po tomhle souboru, proto háček.
if (isset($_SERVER['HTTP_X_KLICENKA_TEST'])) {
    if (function_exists('klicenka_verify')) {
        klicenka_beta_boot();
    } else {
        add_action('muplugins_loaded', 'klicenka_beta_boot', 0);
    }
}
