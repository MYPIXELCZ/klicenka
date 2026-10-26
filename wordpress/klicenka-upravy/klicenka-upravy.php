<?php
/**
 * Plugin Name: Klíčenka – úpravy Claudem
 * Description: Úzké REST API, přes které spouštěč úprav (Claude Code) mění jen kopii stránky (koncept). Publikovat jde jen tokenem z trackeru po kliknutí člověka.
 * Version: 0.3.0
 * Requires PHP: 7.4
 * License: MIT
 *
 * Patří do wp-content/mu-plugins/ vedle klicenka.php (od verze 1.3.0), jehož ověření tokenu používá.
 * Konfigurace je stejná jako u Klíčenky (KLICENKA_AUDIENCE, KLICENKA_ENVIRONMENT, KLICENKA_ISSUER).
 * Volitelně:
 *   define('KLICENKA_UPRAVY_MAX_UPLOAD', 5 * 1024 * 1024);   // největší obrázek v bajtech
 *   define('KLICENKA_UPRAVY_POST_TYPES', 'page,post,elementor_library'); // čárkou oddělené typy obsahu
 *
 * Šablony Elementoru (hlavička, patička, pop-up, sekce, kit) se upravují stejně jako stránky: kopie jako koncept,
 * publikace jen z trackeru, záloha a návrat. Podmínky zobrazení šablon (_elementor_conditions) se nekopírují ani nemění,
 * koncept šablony se proto na webu nikdy neuplatní; náhled ho na stránce vymění jen pro požadavek s podepsaným odkazem.
 *
 * Token: hlavička typ "klicenka-upravy+jwt", claimy jako u Klíčenky (iss, aud, sub, act, jti, iat, exp)
 * a navíc scope (drafts | publish), req (id požadavku) a post (id originální stránky).
 * Posílá se v "Authorization: Bearer …" nebo v "X-Klicenka-Token: …". Nikdy v URL.
 */

if (!defined('ABSPATH')) {
    exit;
}

define('KLICENKA_UPRAVY_VERSION', '0.3.0');
define('KLICENKA_UPRAVY_NS', 'klicenka-upravy/v1');
define('KLICENKA_UPRAVY_TYP', 'klicenka-upravy+jwt');
define('KLICENKA_UPRAVY_USER', 'claude-upravy');
define('KLICENKA_UPRAVY_ROLE', 'claude_upravy');
define('KLICENKA_UPRAVY_DRAFTS_TTL', 900);
define('KLICENKA_UPRAVY_PUBLISH_TTL', 60);
define('KLICENKA_UPRAVY_PREVIEW_TTL', 23 * 3600);
define('KLICENKA_UPRAVY_BACKUPS', 3);

/* ------------------------------------------------------------------ */
/* Pomocné                                                              */
/* ------------------------------------------------------------------ */

function klicenka_upravy_error($code, $message, $status)
{
    return new WP_Error($code, $message, array('status' => $status));
}

function klicenka_upravy_post_types()
{
    $types = defined('KLICENKA_UPRAVY_POST_TYPES') ? KLICENKA_UPRAVY_POST_TYPES : 'page,post,elementor_library';
    return array_values(array_filter(array_map('trim', explode(',', (string) $types))));
}

function klicenka_upravy_max_upload()
{
    return defined('KLICENKA_UPRAVY_MAX_UPLOAD') ? (int) KLICENKA_UPRAVY_MAX_UPLOAD : 5 * 1024 * 1024;
}

/** PDF (ceníky, menu, dokumenty) smí být větší než obrázek. */
function klicenka_upravy_max_pdf()
{
    return defined('KLICENKA_UPRAVY_MAX_PDF') ? (int) KLICENKA_UPRAVY_MAX_PDF : 30 * 1024 * 1024;
}

/**
 * Meta, která se nekopírují ani nepřepisují: technické zámky, cache Elementoru, naše vlastní, koš
 * a podmínky zobrazení šablon (kde se hlavička/patička/pop-up ukazuje); ty mění jen člověk v Elementoru.
 */
function klicenka_upravy_skip_meta($key)
{
    static $exact = array('_edit_lock', '_edit_last', '_wp_old_slug', '_wp_old_date', '_wp_desired_post_slug',
        '_wp_trash_meta_status', '_wp_trash_meta_time', '_elementor_css', '_elementor_element_cache',
        '_elementor_page_assets', '_encloseme', '_pingme', '_elementor_conditions');
    return in_array($key, $exact, true) || strpos($key, '_klicenka_upravy_') === 0;
}

/** Všechna meta příspěvku (key => list hodnot) v syrové podobě z databáze, bez přeskočených. */
function klicenka_upravy_raw_meta($post_id)
{
    global $wpdb;
    $rows = $wpdb->get_results($wpdb->prepare("SELECT meta_key, meta_value FROM {$wpdb->postmeta} WHERE post_id = %d ORDER BY meta_id", $post_id), ARRAY_A);
    $out = array();
    foreach ((array) $rows as $r) {
        if (klicenka_upravy_skip_meta($r['meta_key'])) {
            continue;
        }
        $out[$r['meta_key']][] = $r['meta_value'];
    }
    return $out;
}

/**
 * Zapíše meta tak, jak jsou v databázi (hodnoty už serializované). Přímo přes $wpdb, aby se
 * nic neodescapovalo ani dvakrát neserializovalo (Elementor JSON obsahuje zpětná lomítka).
 */
function klicenka_upravy_write_meta($post_id, $meta)
{
    global $wpdb;
    foreach ($meta as $key => $values) {
        $wpdb->delete($wpdb->postmeta, array('post_id' => $post_id, 'meta_key' => $key));
        foreach ($values as $v) {
            $wpdb->insert($wpdb->postmeta, array('post_id' => $post_id, 'meta_key' => $key, 'meta_value' => $v));
        }
    }
    wp_cache_delete($post_id, 'post_meta');
}

function klicenka_upravy_set_meta_raw($post_id, $key, $value)
{
    klicenka_upravy_write_meta($post_id, array($key => array($value)));
}

function klicenka_upravy_get_meta_raw($post_id, $key)
{
    global $wpdb;
    $v = $wpdb->get_var($wpdb->prepare("SELECT meta_value FROM {$wpdb->postmeta} WHERE post_id = %d AND meta_key = %s ORDER BY meta_id LIMIT 1", $post_id, $key));
    return $v === null ? null : (string) $v;
}

function klicenka_upravy_is_elementor($post_id)
{
    return get_post_meta($post_id, '_elementor_edit_mode', true) === 'builder';
}

function klicenka_upravy_elementor_data($post_id)
{
    $raw = klicenka_upravy_get_meta_raw($post_id, '_elementor_data');
    if ($raw === null || $raw === '') {
        return array();
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        $data = maybe_unserialize($raw);
    }
    return is_array($data) ? $data : array();
}

function klicenka_upravy_editor($post)
{
    if (klicenka_upravy_is_elementor($post->ID)) {
        return 'elementor';
    }
    return has_blocks($post->post_content) ? 'gutenberg' : 'classic';
}

/** Kdo a co, bez tokenů. Posledních 500 záznamů v option + řádek v PHP logu. */
function klicenka_upravy_log($action, $payload, $data = array())
{
    $act = (is_array($payload) && isset($payload['act']) && is_array($payload['act'])) ? $payload['act'] : array();
    $entry = array_merge(array(
        'time'   => gmdate('c'),
        'action' => $action,
        'req'    => isset($payload['req']) ? (string) $payload['req'] : null,
        'post'   => isset($payload['post']) ? (int) $payload['post'] : null,
        'scope'  => isset($payload['scope']) ? (string) $payload['scope'] : null,
        'who'    => isset($act['email']) ? (string) $act['email'] : null,
        'name'   => isset($act['name']) ? (string) $act['name'] : null,
        'ip'     => isset($_SERVER['REMOTE_ADDR']) ? (string) $_SERVER['REMOTE_ADDR'] : null,
    ), $data);
    error_log('[klicenka-upravy] ' . wp_json_encode($entry));
    $log = get_option('klicenka_upravy_log', array());
    $log = is_array($log) ? $log : array();
    array_unshift($log, $entry);
    update_option('klicenka_upravy_log', array_slice($log, 0, 500), false);
}

/* ------------------------------------------------------------------ */
/* Role a uživatel                                                     */
/* ------------------------------------------------------------------ */

function klicenka_upravy_role_caps()
{
    // Jen vlastní koncepty a média. Žádné publish_*, edit_others_*, edit_published_*, správa webu ani unfiltered_html.
    return array('read' => true, 'edit_pages' => true, 'edit_posts' => true, 'upload_files' => true);
}

function klicenka_upravy_ensure_role()
{
    $role = get_role(KLICENKA_UPRAVY_ROLE);
    if (!$role) {
        $role = add_role(KLICENKA_UPRAVY_ROLE, 'Claude (úpravy)', klicenka_upravy_role_caps());
        return;
    }
    $want = klicenka_upravy_role_caps();
    foreach (array_keys($role->capabilities) as $cap) {
        if (!isset($want[$cap])) {
            $role->remove_cap($cap);
        }
    }
    foreach ($want as $cap => $grant) {
        if (empty($role->capabilities[$cap])) {
            $role->add_cap($cap, $grant);
        }
    }
}

/** Uživatel claude-upravy, při prvním použití založený. Vždy jen s naší rolí. */
function klicenka_upravy_user()
{
    klicenka_upravy_ensure_role();
    $user = get_user_by('login', KLICENKA_UPRAVY_USER);
    if (!$user) {
        $id = wp_insert_user(array(
            'user_login'   => KLICENKA_UPRAVY_USER,
            'user_pass'    => wp_generate_password(64, true, true),
            'display_name' => 'Claude (úpravy)',
            'role'         => KLICENKA_UPRAVY_ROLE,
        ));
        if (is_wp_error($id)) {
            return $id;
        }
        $user = get_user_by('id', $id);
    }
    // Vždy právě jedna role a žádná přidaná oprávnění navíc (kdyby je někdo účtu přidal ručně).
    if (array_values($user->roles) !== array(KLICENKA_UPRAVY_ROLE) || array_keys($user->caps) !== array(KLICENKA_UPRAVY_ROLE)) {
        $user->set_role(KLICENKA_UPRAVY_ROLE);
        foreach (array_keys($user->caps) as $cap) {
            if ($cap !== KLICENKA_UPRAVY_ROLE) {
                $user->remove_cap($cap);
            }
        }
        $user = get_user_by('id', $user->ID);
    }
    if (is_multisite() && is_super_admin($user->ID)) {
        return klicenka_upravy_error('config', 'Účet claude-upravy nesmí být superadmin.', 500);
    }
    return $user;
}

// Účet se nepřihlašuje heslem ani aplikačním heslem, jen tímto pluginem.
add_filter('wp_authenticate_user', function ($user) {
    if ($user instanceof WP_User && $user->user_login === KLICENKA_UPRAVY_USER) {
        return new WP_Error('klicenka_upravy', 'Tento účet se nepřihlašuje heslem.');
    }
    return $user;
}, 99);
add_filter('wp_is_application_passwords_available_for_user', function ($available, $user) {
    return ($user instanceof WP_User && $user->user_login === KLICENKA_UPRAVY_USER) ? false : $available;
}, 10, 2);

/* ------------------------------------------------------------------ */
/* Token                                                               */
/* ------------------------------------------------------------------ */

function klicenka_upravy_request_token(WP_REST_Request $request)
{
    $auth = (string) $request->get_header('authorization');
    if ($auth === '' && isset($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) {
        $auth = (string) $_SERVER['REDIRECT_HTTP_AUTHORIZATION'];
    }
    if (preg_match('/^\s*Bearer\s+(\S+)\s*$/i', $auth, $m)) {
        return $m[1];
    }
    return trim((string) $request->get_header('x_klicenka_token'));
}

/**
 * Ověří token pro daný scope. Při úspěchu uloží payload do požadavku (atribut klicenka_upravy).
 * @return true|WP_Error
 */
function klicenka_upravy_authorize(WP_REST_Request $request, $scope, $need_post = true)
{
    if (!function_exists('klicenka_verify') || !defined('KLICENKA_PLUGIN_VERSION') || version_compare(KLICENKA_PLUGIN_VERSION, '1.3.0', '<')) {
        return klicenka_upravy_error('config', 'Chybí klicenka.php 1.3.0 nebo novější v mu-plugins.', 500);
    }
    $token = klicenka_upravy_request_token($request);
    if ($token === '') {
        return klicenka_upravy_error('unauthorized', 'Chybí token.', 401);
    }
    $publish = $scope === 'publish';
    $payload = klicenka_verify($token, array(
        'typ'        => KLICENKA_UPRAVY_TYP,
        'max_ttl'    => $publish ? KLICENKA_UPRAVY_PUBLISH_TTL : KLICENKA_UPRAVY_DRAFTS_TTL,
        'single_use' => $publish,
    ));
    if (is_wp_error($payload)) {
        klicenka_upravy_log('refused', null, array('reason' => $payload->get_error_code(), 'route' => $request->get_route()));
        return klicenka_upravy_error('unauthorized', $payload->get_error_message(), 401);
    }
    if (($payload['scope'] ?? '') !== $scope) {
        klicenka_upravy_log('refused', $payload, array('reason' => 'scope', 'route' => $request->get_route()));
        return klicenka_upravy_error('forbidden', 'Token nemá oprávnění pro tuto akci.', 403);
    }
    $req = $payload['req'] ?? null;
    if (is_int($req)) {
        $req = (string) $req;
    }
    if (!is_string($req) || !preg_match('/^[A-Za-z0-9_-]{1,64}$/', $req)) {
        return klicenka_upravy_error('forbidden', 'Token nemá platné id požadavku.', 403);
    }
    $post = $payload['post'] ?? null;
    if ($need_post && (!is_int($post) || $post <= 0)) {
        return klicenka_upravy_error('forbidden', 'Token nemá platné id stránky.', 403);
    }
    $payload['req'] = $req;
    $payload['post'] = is_int($post) ? $post : 0;

    $user = klicenka_upravy_user();
    if (is_wp_error($user)) {
        return $user;
    }
    wp_set_current_user($user->ID);
    $GLOBALS['klicenka_upravy_payload'] = $payload;
    return true;
}

function klicenka_upravy_payload()
{
    return isset($GLOBALS['klicenka_upravy_payload']) ? $GLOBALS['klicenka_upravy_payload'] : array();
}

/** Originál z tokenu: musí sedět s id v URL a být zveřejněná stránka povoleného typu. */
function klicenka_upravy_original($id)
{
    $p = klicenka_upravy_payload();
    $id = (int) $id;
    if ($id !== (int) $p['post']) {
        return klicenka_upravy_error('forbidden', 'Token platí pro jinou stránku.', 403);
    }
    $post = get_post($id);
    if (!$post || !in_array($post->post_type, klicenka_upravy_post_types(), true)
        || !in_array($post->post_status, array('publish', 'private'), true)
        || get_post_meta($id, '_klicenka_upravy_source', true) !== '') {
        return klicenka_upravy_error('not_found', 'Stránka neexistuje nebo ji nelze upravovat.', 404);
    }
    return $post;
}

/** Koncept z URL: náš, pro originál i požadavek z tokenu, ještě nezveřejněný. */
function klicenka_upravy_draft($id)
{
    $p = klicenka_upravy_payload();
    $post = get_post((int) $id);
    if (!$post || $post->post_status !== 'draft'
        || (int) get_post_meta($post->ID, '_klicenka_upravy_source', true) !== (int) $p['post']
        || (string) get_post_meta($post->ID, '_klicenka_upravy_req', true) !== (string) $p['req']) {
        return klicenka_upravy_error('not_found', 'Koncept pro tento požadavek neexistuje.', 404);
    }
    $user = get_user_by('login', KLICENKA_UPRAVY_USER);
    if (!$user || (int) $post->post_author !== (int) $user->ID) {
        return klicenka_upravy_error('not_found', 'Koncept pro tento požadavek neexistuje.', 404);
    }
    return $post;
}

/* ------------------------------------------------------------------ */
/* Obsah: kopie, sanitizace, outline                                   */
/* ------------------------------------------------------------------ */

/** Zapíše post_content beze změny (bez kses), protože jde o kopii obsahu, který napsal administrátor. */
function klicenka_upravy_save_content($postarr)
{
    if (isset($postarr['ID'])) {
        // wp_update_post jinak znovu ověří šablonu stránky a odmítne uložení, když šablona
        // (např. motivu nebo vypnutého Elementoru) zrovna není k dispozici. Šablonu neměníme.
        $postarr['page_template'] = '';
    }
    kses_remove_filters();
    $id = isset($postarr['ID']) ? wp_update_post(wp_slash($postarr), true) : wp_insert_post(wp_slash($postarr), true);
    kses_init();
    return $id;
}

/** Hodnoty od Clauda: texty přes wp_kses_post, odkazy přes esc_url_raw, klíče jen bezpečné znaky. */
function klicenka_upravy_clean($value, $key = '')
{
    if (is_array($value)) {
        $out = array();
        foreach ($value as $k => $v) {
            if (!is_int($k) && !preg_match('/^[A-Za-z0-9_\-]{1,100}$/', (string) $k)) {
                return new WP_Error('invalid', 'Neplatný klíč nastavení: ' . substr((string) $k, 0, 40));
            }
            $c = klicenka_upravy_clean($v, (string) $k);
            if (is_wp_error($c)) {
                return $c;
            }
            $out[$k] = $c;
        }
        return $out;
    }
    if (is_string($value)) {
        if (in_array($key, array('url', 'href', 'link'), true)) {
            return $value === '' || $value[0] === '#' ? $value : esc_url_raw($value);
        }
        return wp_kses_post($value);
    }
    if (is_bool($value) || is_int($value) || is_float($value) || $value === null) {
        return $value;
    }
    return new WP_Error('invalid', 'Neplatná hodnota nastavení.');
}

/** Sloučení: asociativní pole i seznamy po klíčích/indexech, null klíč odebere. */
function klicenka_upravy_merge($base, $patch)
{
    if (!is_array($base)) {
        $base = array();
    }
    foreach ($patch as $k => $v) {
        if ($v === null) {
            unset($base[$k]);
        } elseif (is_array($v) && isset($base[$k]) && is_array($base[$k]) && $v !== array()) {
            $base[$k] = klicenka_upravy_merge($base[$k], $v);
        } else {
            $base[$k] = $v;
        }
    }
    return $base;
}

function klicenka_upravy_short($text, $len = 160)
{
    $text = trim(preg_replace('/\s+/u', ' ', wp_strip_all_tags((string) $text)));
    return mb_strlen($text) > $len ? mb_substr($text, 0, $len - 1) . '…' : $text;
}

/** Projde nastavení prvku a vybere texty, odkazy a obrázky (s cestou ke klíči). */
function klicenka_upravy_collect($settings, $path, &$texts, &$links, &$images)
{
    static $skip = '/(^_|color|typography|font|size|align|width|height|padding|margin|border|radius|shadow|position|background_(?!image)|animation|transition|hover|css|class|_id$|^id$|gap|spacing|ratio|opacity|order|flex|overflow|display|z_index|view|layout|skin|style|icon$|selected_icon|tag$|html_tag|header_size|_type$|unit$)/';
    foreach ((array) $settings as $k => $v) {
        $p = $path === '' ? (string) $k : $path . '.' . $k;
        if (is_array($v)) {
            if (isset($v['url']) && is_string($v['url']) && $v['url'] !== '') {
                if (!empty($v['id']) || preg_match('/image|img|photo|gallery|logo|background/i', (string) $k . $path)) {
                    $images[$p] = array('id' => isset($v['id']) ? (int) $v['id'] : 0, 'url' => $v['url']);
                } else {
                    $links[$p] = $v['url'];
                }
                continue;
            }
            klicenka_upravy_collect($v, $p, $texts, $links, $images);
            continue;
        }
        if (!is_string($v) || $v === '' || (!is_int($k) && preg_match($skip, (string) $k))) {
            continue;
        }
        $t = klicenka_upravy_short($v);
        if ($t !== '' && preg_match('/\p{L}/u', $t) && (strpos($t, ' ') !== false || mb_strlen($t) > 2)) {
            $texts[$p] = $t;
        }
    }
}

function klicenka_upravy_outline_elementor($elements)
{
    $out = array();
    foreach ((array) $elements as $el) {
        if (!is_array($el) || empty($el['id'])) {
            continue;
        }
        $texts = $links = $images = array();
        klicenka_upravy_collect(isset($el['settings']) ? $el['settings'] : array(), '', $texts, $links, $images);
        $node = array('id' => (string) $el['id'], 'type' => isset($el['widgetType']) ? (string) $el['widgetType'] : (string) ($el['elType'] ?? ''));
        if (isset($el['elType']) && $el['elType'] !== 'widget') {
            $node['elType'] = (string) $el['elType'];
        }
        if ($texts) {
            $node['texts'] = $texts;
        }
        if ($links) {
            $node['links'] = $links;
        }
        if ($images) {
            $node['images'] = $images;
        }
        if (!empty($el['elements'])) {
            $node['children'] = klicenka_upravy_outline_elementor($el['elements']);
        }
        $out[] = $node;
    }
    return $out;
}

/** Najde prvky podle id (reference do stromu). */
function klicenka_upravy_find_elements(&$elements, $ids, &$found)
{
    foreach ($elements as &$el) {
        if (is_array($el) && isset($el['id']) && in_array((string) $el['id'], $ids, true)) {
            $found[(string) $el['id']] = &$el;
        }
        if (is_array($el) && !empty($el['elements']) && is_array($el['elements'])) {
            klicenka_upravy_find_elements($el['elements'], $ids, $found);
        }
    }
    unset($el);
}

/** Bloky Gutenbergu bez prázdných mezer; id = cesta indexů "0.2.1" do výsledku parse_blocks. */
function klicenka_upravy_outline_blocks($blocks, $prefix = '')
{
    $out = array();
    foreach ($blocks as $i => $b) {
        if (empty($b['blockName']) && trim((string) $b['innerHTML']) === '') {
            continue;
        }
        $id = $prefix === '' ? (string) $i : $prefix . '.' . $i;
        $node = array('id' => $id, 'type' => $b['blockName'] ? $b['blockName'] : 'core/freeform');
        $html = (string) $b['innerHTML'];
        $t = klicenka_upravy_short($html, 200);
        if ($t !== '') {
            $node['text'] = $t;
        }
        if (preg_match_all('/href="([^"]+)"/', $html, $m)) {
            $node['links'] = array_values(array_unique($m[1]));
        }
        $imgs = array();
        if (!empty($b['attrs']['id']) && preg_match('/image|cover|media/', (string) $b['blockName'])) {
            $imgs[] = array('id' => (int) $b['attrs']['id']);
        }
        if (preg_match_all('/<img[^>]+src="([^"]+)"/', $html, $m)) {
            foreach ($m[1] as $src) {
                $imgs[] = array('url' => $src);
            }
        }
        if ($imgs) {
            $node['images'] = $imgs;
        }
        if (!empty($b['attrs'])) {
            $node['attrs'] = array_map(function ($v) {
                return is_string($v) ? klicenka_upravy_short($v, 80) : $v;
            }, $b['attrs']);
        }
        if (!empty($b['innerBlocks'])) {
            $node['children'] = klicenka_upravy_outline_blocks($b['innerBlocks'], $id);
        }
        $out[] = $node;
    }
    return $out;
}

function &klicenka_upravy_block_ref(&$blocks, $id)
{
    $null = null;
    if (!preg_match('/^\d+(\.\d+)*$/', $id)) {
        return $null;
    }
    $parts = array_map('intval', explode('.', $id));
    $cur = &$blocks;
    $last = count($parts) - 1;
    foreach ($parts as $n => $i) {
        if (!isset($cur[$i])) {
            return $null;
        }
        if ($n === $last) {
            return $cur[$i];
        }
        $cur = &$cur[$i]['innerBlocks'];
    }
    return $null;
}

/* ------------------------------------------------------------------ */
/* Elementor                                                           */
/* ------------------------------------------------------------------ */

function klicenka_upravy_elementor_refresh($post_id)
{
    delete_post_meta($post_id, '_elementor_css');
    delete_post_meta($post_id, '_elementor_element_cache');
    delete_post_meta($post_id, '_elementor_page_assets');
    if (!did_action('elementor/loaded') || !class_exists('\Elementor\Plugin')) {
        return false;
    }
    try {
        if (class_exists('\Elementor\Core\Files\CSS\Post')) {
            $css = \Elementor\Core\Files\CSS\Post::create($post_id);
            $css->update();
        }
        return true;
    } catch (\Throwable $e) {
        error_log('[klicenka-upravy] elementor css: ' . $e->getMessage());
        return false;
    }
}

/* ------------------------------------------------------------------ */
/* Endpointy                                                           */
/* ------------------------------------------------------------------ */

function klicenka_upravy_page_info($post)
{
    return array(
        'id'       => $post->ID,
        'title'    => get_the_title($post),
        'status'   => $post->post_status,
        'type'     => $post->post_type,
        'link'     => get_permalink($post),
        'modified' => mysql2date('c', $post->post_modified_gmt, false),
        'editor'   => klicenka_upravy_editor($post),
        'template' => (string) get_post_meta($post->ID, '_wp_page_template', true),
        'parent'   => (int) $post->post_parent,
    ) + klicenka_upravy_template_info($post);
}

/** U šablony Elementoru: typ (header, footer, popup, section, kit…), podmínky zobrazení a jestli je aktivní kit. */
function klicenka_upravy_template_info($post)
{
    if ($post->post_type !== 'elementor_library') {
        return array();
    }
    $type = (string) get_post_meta($post->ID, '_elementor_template_type', true);
    $conditions = get_post_meta($post->ID, '_elementor_conditions', true);
    return array(
        'template_type' => $type,
        'conditions'    => is_array($conditions) ? array_values($conditions) : array(),
        'active_kit'    => $type === 'kit' && (int) get_option('elementor_active_kit') === (int) $post->ID,
    );
}

function klicenka_upravy_rest_pages(WP_REST_Request $request)
{
    $types = klicenka_upravy_post_types();
    $type = (string) $request->get_param('type');
    if ($type !== '') {
        if (!in_array($type, $types, true)) {
            return klicenka_upravy_error('invalid', 'Typ obsahu není povolený.', 400);
        }
        $types = array($type);
    }
    $q = new WP_Query(array(
        'post_type'      => $types,
        'post_status'    => array('publish', 'private'),
        'posts_per_page' => 100,
        'paged'          => max(1, (int) $request->get_param('page')),
        's'              => (string) $request->get_param('search'),
        'orderby'        => $types === array('post') ? 'date' : 'menu_order title',
        'order'          => $types === array('post') ? 'DESC' : 'ASC',
        'meta_query'     => array(array('key' => '_klicenka_upravy_source', 'compare' => 'NOT EXISTS')),
        'no_found_rows'  => false,
    ));
    $pages = array_map('klicenka_upravy_page_info', $q->posts);
    klicenka_upravy_log('pages', klicenka_upravy_payload(), array('count' => count($pages)));
    return rest_ensure_response(array('pages' => $pages, 'total' => (int) $q->found_posts, 'pages_total' => (int) $q->max_num_pages));
}

function klicenka_upravy_rest_duplicate(WP_REST_Request $request)
{
    $orig = klicenka_upravy_original($request['id']);
    if (is_wp_error($orig)) {
        return $orig;
    }
    $p = klicenka_upravy_payload();

    // Stejný požadavek a stránka = stejný koncept (opakované volání nic nezdvojí).
    $existing = get_posts(array(
        'post_type'   => $orig->post_type,
        'post_status' => 'draft',
        'numberposts' => 1,
        'fields'      => 'ids',
        'meta_query'  => array(
            array('key' => '_klicenka_upravy_source', 'value' => (string) $orig->ID),
            array('key' => '_klicenka_upravy_req', 'value' => $p['req']),
        ),
    ));
    if ($existing) {
        return rest_ensure_response(array('id' => (int) $existing[0], 'created' => false, 'original' => $orig->ID, 'editor' => klicenka_upravy_editor($orig)));
    }

    $id = klicenka_upravy_save_content(array(
        'post_type'      => $orig->post_type,
        'post_status'    => 'draft',
        'post_author'    => get_current_user_id(),
        'post_title'     => sprintf('[Úprava #%s] %s', $p['req'], $orig->post_title),
        'post_content'   => $orig->post_content,
        'post_excerpt'   => $orig->post_excerpt,
        'post_parent'    => $orig->post_parent,
        'menu_order'     => $orig->menu_order,
        'comment_status' => 'closed',
        'ping_status'    => 'closed',
    ));
    if (is_wp_error($id) || !$id) {
        return klicenka_upravy_error('failed', 'Koncept se nepodařilo založit.', 500);
    }
    klicenka_upravy_write_meta($id, klicenka_upravy_raw_meta($orig->ID));
    update_post_meta($id, '_klicenka_upravy_source', (string) $orig->ID);
    update_post_meta($id, '_klicenka_upravy_req', $p['req']);
    update_post_meta($id, '_klicenka_upravy_source_modified', $orig->post_modified_gmt);
    if (klicenka_upravy_is_elementor($id)) {
        klicenka_upravy_elementor_refresh($id);
    }
    klicenka_upravy_log('duplicate', $p, array('draft' => (int) $id));
    return rest_ensure_response(array('id' => (int) $id, 'created' => true, 'original' => $orig->ID, 'editor' => klicenka_upravy_editor($orig)));
}

function klicenka_upravy_rest_outline(WP_REST_Request $request)
{
    $draft = klicenka_upravy_draft($request['id']);
    if (is_wp_error($draft)) {
        return $draft;
    }
    $ids = array_filter(array_map('trim', explode(',', (string) $request->get_param('ids'))));
    $editor = klicenka_upravy_editor($draft);
    $out = array('id' => $draft->ID, 'original' => (int) klicenka_upravy_payload()['post'], 'editor' => $editor) + klicenka_upravy_template_info($draft);
    $page = get_post_meta($draft->ID, '_elementor_page_settings', true);
    if (in_array('@page', $ids, true)) {
        $out['page_settings'] = is_array($page) ? $page : (object) array();
        $ids = array_values(array_diff($ids, array('@page')));
        if (!$ids) {
            return rest_ensure_response($out);
        }
    } elseif (is_array($page) && $page) {
        $out['page_settings_keys'] = array_keys($page);
    }
    if ($editor === 'elementor') {
        $data = klicenka_upravy_elementor_data($draft->ID);
        if ($ids) {
            // Plné nastavení vybraných prvků (aby Claude znal přesné klíče), bez potomků.
            $found = array();
            klicenka_upravy_find_elements($data, $ids, $found);
            $out['elements'] = array();
            foreach ($found as $eid => $el) {
                $out['elements'][] = array('id' => $eid, 'elType' => $el['elType'] ?? '', 'widgetType' => $el['widgetType'] ?? null, 'settings' => $el['settings'] ?? (object) array());
            }
        } else {
            $out['outline'] = klicenka_upravy_outline_elementor($data);
        }
    } else {
        $blocks = parse_blocks($draft->post_content);
        if ($ids) {
            $out['elements'] = array();
            foreach ($ids as $bid) {
                $ref = &klicenka_upravy_block_ref($blocks, $bid);
                if ($ref !== null) {
                    $out['elements'][] = array('id' => $bid, 'type' => $ref['blockName'], 'attrs' => $ref['attrs'] ?: (object) array(), 'html' => $ref['innerHTML'], 'has_children' => !empty($ref['innerBlocks']));
                }
                unset($ref);
            }
        } else {
            $out['outline'] = klicenka_upravy_outline_blocks($blocks);
        }
    }
    return rest_ensure_response($out);
}

function klicenka_upravy_rest_elements(WP_REST_Request $request)
{
    $draft = klicenka_upravy_draft($request['id']);
    if (is_wp_error($draft)) {
        return $draft;
    }
    $changes = $request->get_json_params();
    $changes = isset($changes['elements']) ? $changes['elements'] : $changes;
    if (!is_array($changes) || !$changes || count($changes) > 200) {
        return klicenka_upravy_error('invalid', 'Pošlete seznam {id, settings} (1 až 200 položek).', 400);
    }
    $clean = array();
    foreach ($changes as $i => $c) {
        if (!is_array($c) || !isset($c['id']) || !is_scalar($c['id']) || !isset($c['settings']) || !is_array($c['settings'])) {
            return klicenka_upravy_error('invalid', "Položka $i nemá id a settings.", 400);
        }
        $s = klicenka_upravy_clean($c['settings']);
        if (is_wp_error($s)) {
            return klicenka_upravy_error('invalid', "Položka $i: " . $s->get_error_message(), 400);
        }
        $clean[] = array('id' => (string) $c['id'], 'settings' => $s);
    }
    // „@page“ = nastavení dokumentu Elementoru (_elementor_page_settings); u kitu globální barvy, písma a logo.
    foreach ($clean as $k => $c) {
        if ($c['id'] !== '@page') {
            continue;
        }
        $cur = get_post_meta($draft->ID, '_elementor_page_settings', true);
        update_post_meta($draft->ID, '_elementor_page_settings', klicenka_upravy_merge(is_array($cur) ? $cur : array(), $c['settings']));
        klicenka_upravy_elementor_refresh($draft->ID);
        unset($clean[$k]);
    }
    $clean = array_values($clean);
    $ids = array_column($clean, 'id');
    $editor = klicenka_upravy_editor($draft);

    if (!$clean) {
        // Jen nastavení dokumentu.
    } elseif ($editor === 'elementor') {
        $data = klicenka_upravy_elementor_data($draft->ID);
        $found = array();
        klicenka_upravy_find_elements($data, $ids, $found);
        $missing = array_values(array_diff(array_unique($ids), array_keys($found)));
        if ($missing) {
            return klicenka_upravy_error('unknown_element', 'Prvky neexistují: ' . implode(', ', $missing), 422);
        }
        foreach ($clean as $c) {
            $found[$c['id']]['settings'] = klicenka_upravy_merge(isset($found[$c['id']]['settings']) ? $found[$c['id']]['settings'] : array(), $c['settings']);
        }
        unset($found);
        $json = wp_json_encode($data);
        if (!is_string($json)) {
            return klicenka_upravy_error('failed', 'Data Elementoru se nepodařilo uložit.', 500);
        }
        klicenka_upravy_set_meta_raw($draft->ID, '_elementor_data', $json);
        klicenka_upravy_elementor_refresh($draft->ID);
        clean_post_cache($draft->ID);
    } else {
        $blocks = parse_blocks($draft->post_content);
        foreach ($ids as $bid) {
            $ref = &klicenka_upravy_block_ref($blocks, $bid);
            $ok = $ref !== null;
            unset($ref);
            if (!$ok) {
                return klicenka_upravy_error('unknown_element', 'Blok neexistuje: ' . $bid, 422);
            }
        }
        foreach ($clean as $c) {
            $ref = &klicenka_upravy_block_ref($blocks, $c['id']);
            $s = $c['settings'];
            if (isset($s['attrs']) && is_array($s['attrs'])) {
                $ref['attrs'] = klicenka_upravy_merge(is_array($ref['attrs']) ? $ref['attrs'] : array(), $s['attrs']);
            }
            $leaf = empty($ref['innerBlocks']);
            if (isset($s['html'])) {
                if (!$leaf) {
                    unset($ref);
                    return klicenka_upravy_error('invalid', 'Blok ' . $c['id'] . ' má vnořené bloky, html nejde nahradit celé (použijte replace).', 422);
                }
                $ref['innerHTML'] = (string) $s['html'];
                $ref['innerContent'] = array((string) $s['html']);
            }
            if (isset($s['replace']) && is_array($s['replace'])) {
                foreach ($s['replace'] as $r) {
                    if (!is_array($r) || !isset($r['from'], $r['to']) || $r['from'] === '') {
                        continue;
                    }
                    $hits = 0;
                    foreach ($ref['innerContent'] as $k => $chunk) {
                        if (is_string($chunk)) {
                            $ref['innerContent'][$k] = str_replace($r['from'], $r['to'], $chunk, $n);
                            $hits += $n;
                        }
                    }
                    if ($hits === 0) {
                        unset($ref);
                        return klicenka_upravy_error('not_found', 'Text „' . klicenka_upravy_short($r['from'], 60) . '“ v bloku ' . $c['id'] . ' není.', 422);
                    }
                    $ref['innerHTML'] = str_replace($r['from'], $r['to'], $ref['innerHTML']);
                }
            }
            unset($ref);
        }
        $res = klicenka_upravy_save_content(array('ID' => $draft->ID, 'post_content' => serialize_blocks($blocks)));
        if (is_wp_error($res)) {
            return klicenka_upravy_error('failed', 'Koncept se nepodařilo uložit.', 500);
        }
    }
    $updated = array_column($changes, 'id');
    klicenka_upravy_log('elements', klicenka_upravy_payload(), array('draft' => $draft->ID, 'ids' => array_slice($updated, 0, 50)));
    return rest_ensure_response(array('id' => $draft->ID, 'updated' => array_values(array_unique(array_map('strval', $updated)))));
}

function klicenka_upravy_rest_media(WP_REST_Request $request)
{
    $draft = klicenka_upravy_draft($request['id']);
    if (is_wp_error($draft)) {
        return $draft;
    }
    if (!current_user_can('upload_files')) {
        return klicenka_upravy_error('forbidden', 'Účet nesmí nahrávat soubory.', 403);
    }
    $files = $request->get_file_params();
    if (empty($files['file']) || !is_array($files['file']) || (int) $files['file']['error'] !== UPLOAD_ERR_OK) {
        $err = isset($files['file']['error']) ? (int) $files['file']['error'] : -1;
        if ($err === UPLOAD_ERR_INI_SIZE || $err === UPLOAD_ERR_FORM_SIZE) {
            return klicenka_upravy_error('too_large', 'Soubor je příliš velký.', 413);
        }
        return klicenka_upravy_error('invalid', 'Pošlete soubor jako multipart pole „file“.', 400);
    }
    $file = $files['file'];
    // PDF jen jako nový soubor v knihovně médií (nic se nepřepisuje); na živém webu se objeví až s publikací konceptu,
    // který na něj odkazuje. Pozná se podle hlavičky %PDF-, ne podle přípony.
    $head = (string) @file_get_contents($file['tmp_name'], false, null, 0, 5);
    $is_pdf = $head === '%PDF-';
    $max = $is_pdf ? klicenka_upravy_max_pdf() : klicenka_upravy_max_upload();
    if ((int) $file['size'] > $max || filesize($file['tmp_name']) > $max) {
        return klicenka_upravy_error('too_large', sprintf('Soubor může mít nejvýš %d kB.', $max / 1024), 413);
    }
    $allowed = $is_pdf
        ? array('pdf' => 'application/pdf')
        : array('jpg|jpeg|jpe' => 'image/jpeg', 'png' => 'image/png', 'gif' => 'image/gif', 'webp' => 'image/webp');
    $check = wp_check_filetype_and_ext($file['tmp_name'], $file['name'], $allowed);
    $info = $is_pdf ? null : @getimagesize($file['tmp_name']);
    if (empty($check['type']) || !in_array($check['type'], $allowed, true) || (!$is_pdf && (!$info || !in_array($info['mime'], $allowed, true)))) {
        return klicenka_upravy_error('unsupported', 'Povolené jsou jen obrázky JPEG, PNG, GIF, WebP a PDF.', 415);
    }
    require_once ABSPATH . 'wp-admin/includes/file.php';
    require_once ABSPATH . 'wp-admin/includes/media.php';
    require_once ABSPATH . 'wp-admin/includes/image.php';
    $sideload = array('name' => sanitize_file_name($file['name']), 'tmp_name' => $file['tmp_name'], 'type' => $check['type'], 'size' => (int) $file['size'], 'error' => 0);
    $mimes = function () use ($allowed) {
        return $allowed;
    };
    add_filter('upload_mimes', $mimes, 99);
    $att = media_handle_sideload($sideload, $draft->ID, null, array('post_author' => get_current_user_id()));
    remove_filter('upload_mimes', $mimes, 99);
    if (is_wp_error($att)) {
        return klicenka_upravy_error('failed', 'Soubor se nepodařilo uložit: ' . $att->get_error_message(), 500);
    }
    $alt = $request->get_param('alt');
    if (is_string($alt) && $alt !== '') {
        update_post_meta($att, '_wp_attachment_image_alt', sanitize_text_field($alt));
    }
    $meta = wp_get_attachment_metadata($att);
    klicenka_upravy_log('media', klicenka_upravy_payload(), array('draft' => $draft->ID, 'attachment' => (int) $att));
    return rest_ensure_response(array(
        'id'     => (int) $att,
        'url'    => wp_get_attachment_url($att),
        'width'  => isset($meta['width']) ? (int) $meta['width'] : ($info ? (int) $info[0] : null),
        'height' => isset($meta['height']) ? (int) $meta['height'] : ($info ? (int) $info[1] : null),
        'mime'   => $check['type'],
    ));
}

/* ---------- Dočasný veřejný náhled konceptu ---------- */

function klicenka_upravy_preview_sig($id, $exp)
{
    return hash_hmac('sha256', 'klicenka-upravy-nahled|' . (int) $id . '|' . (int) $exp, wp_salt('auth'));
}

function klicenka_upravy_rest_preview(WP_REST_Request $request)
{
    $draft = klicenka_upravy_draft($request['id']);
    if (is_wp_error($draft)) {
        return $draft;
    }
    $exp = time() + KLICENKA_UPRAVY_PREVIEW_TTL;
    $param = $exp . '.' . klicenka_upravy_preview_sig($draft->ID, $exp);
    if ($draft->post_type === 'elementor_library') {
        // Šablona (hlavička, patička, pop-up, kit) se ukáže na skutečné stránce místo originálu. ?path=/kontakt/ = jiná stránka.
        $path = '/' . ltrim((string) $request->get_param('path'), '/');
        $path = preg_match('#^/[A-Za-z0-9/_.%-]*$#', $path) ? $path : '/';
        $url = add_query_arg(array('klicenka_sablona' => $draft->ID, 'klicenka_nahled' => $param), home_url($path));
    } else {
        $key = $draft->post_type === 'page' ? 'page_id' : 'p';
        $url = add_query_arg(array($key => $draft->ID, 'klicenka_nahled' => $param), home_url('/'));
    }
    klicenka_upravy_log('preview-link', klicenka_upravy_payload(), array('draft' => $draft->ID));
    return rest_ensure_response(array('url' => $url, 'expires' => gmdate('c', $exp)));
}

/** Platný náhled → id konceptu, jinak 0. */
function klicenka_upravy_preview_id()
{
    static $id = null;
    if ($id !== null) {
        return $id;
    }
    $id = 0;
    $param = isset($_GET['klicenka_nahled']) ? (string) wp_unslash($_GET['klicenka_nahled']) : '';
    $pid = isset($_GET['page_id']) ? (int) $_GET['page_id'] : (isset($_GET['p']) ? (int) $_GET['p'] : 0);
    if ($param === '' || $pid <= 0 || !preg_match('/^(\d{9,12})\.([a-f0-9]{64})$/', $param, $m)) {
        return $id;
    }
    if ((int) $m[1] < time() || !hash_equals(klicenka_upravy_preview_sig($pid, (int) $m[1]), $m[2])) {
        return $id;
    }
    $post = get_post($pid);
    if ($post && $post->post_status === 'draft' && get_post_meta($pid, '_klicenka_upravy_source', true) !== '') {
        $id = $pid;
    }
    return $id;
}

add_action('pre_get_posts', function ($q) {
    if (!is_admin() && $q->is_main_query() && klicenka_upravy_preview_id()) {
        $q->set('post_status', array('publish', 'draft'));
    }
});
add_filter('posts_results', function ($posts, $q) {
    $id = klicenka_upravy_preview_id();
    if ($id && $q->is_main_query() && count($posts) === 1 && (int) $posts[0]->ID === $id) {
        // Jen v paměti pro tento požadavek, v databázi zůstává koncept.
        $posts[0]->post_status = 'publish';
        add_filter('redirect_canonical', '__return_false');
        add_filter('wp_robots', 'wp_robots_no_robots');
        add_action('send_headers', function () {
            nocache_headers();
            header('X-Robots-Tag: noindex, nofollow');
            header('Referrer-Policy: no-referrer');
        });
    }
    return $posts;
}, 10, 2);

/** Platný náhled šablony (klicenka_sablona) → [id konceptu, id originálu], jinak null. */
function klicenka_upravy_preview_template()
{
    static $res = false;
    if ($res !== false) {
        return $res;
    }
    $res = null;
    $param = isset($_GET['klicenka_nahled']) ? (string) wp_unslash($_GET['klicenka_nahled']) : '';
    $id = isset($_GET['klicenka_sablona']) ? (int) $_GET['klicenka_sablona'] : 0;
    if ($param === '' || $id <= 0 || !preg_match('/^(\d{9,12})\.([a-f0-9]{64})$/', $param, $m)) {
        return $res;
    }
    if ((int) $m[1] < time() || !hash_equals(klicenka_upravy_preview_sig($id, (int) $m[1]), $m[2])) {
        return $res;
    }
    $post = get_post($id);
    $source = $post ? (int) get_post_meta($id, '_klicenka_upravy_source', true) : 0;
    if ($post && $post->post_status === 'draft' && $post->post_type === 'elementor_library' && $source > 0) {
        $res = array($id, $source);
    }
    return $res;
}

add_action('init', function () {
    $t = klicenka_upravy_preview_template();
    if (!$t) {
        return;
    }
    list($draft, $orig) = $t;
    // Elementor Pro vybírá šablony pro hlavičku, patičku, pop-upy… podle podmínek; tady jen vymění originál za koncept.
    add_filter('elementor/theme/get_location_templates/template_id', function ($id) use ($draft, $orig) {
        return (int) $id === $orig ? $draft : $id;
    });
    // Kdyby Elementor kontroloval stav: koncept se v tomto požadavku tváří jako zveřejněný (jen filtr, nic se neukládá).
    add_filter('get_post_status', function ($status, $post) use ($draft) {
        return (int) $post->ID === $draft ? 'publish' : $status;
    }, 10, 2);
    // Kit (globální barvy, písma): Elementor bere jen zveřejněný kit, proto se CSS konceptu přidá navrch.
    // Jeho pravidla platí pro třídu elementor-kit-<koncept>, kterou dostane body, a načtou se až po originálu.
    if ((int) get_option('elementor_active_kit') === $orig) {
        add_filter('body_class', function ($classes) use ($draft) {
            $classes[] = 'elementor-kit-' . $draft;
            return $classes;
        });
        add_action('wp_enqueue_scripts', function () use ($draft) {
            if (class_exists('\\Elementor\\Core\\Files\\CSS\\Post')) {
                \Elementor\Core\Files\CSS\Post::create($draft)->enqueue();
            }
        }, 999);
    }
    if (!defined('DONOTCACHEPAGE')) {
        define('DONOTCACHEPAGE', true);
    }
    add_filter('wp_robots', 'wp_robots_no_robots');
    add_action('send_headers', function () {
        nocache_headers();
        header('X-Robots-Tag: noindex, nofollow');
        header('Referrer-Policy: no-referrer');
        header('X-LiteSpeed-Cache-Control: no-cache');
    });
    add_action('wp_footer', function () use ($draft) {
        echo '<div style="position:fixed;left:12px;bottom:12px;z-index:2147483647;background:#7c3aed;color:#fff;font:13px/1.4 system-ui,sans-serif;padding:6px 10px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.25)">Náhled konceptu šablony (' . esc_html(get_the_title($draft)) . '), na webu zatím není</div>';
    });
});

/**
 * Po publikaci nebo návratu šablony: CSS Elementoru a cache stránek celého webu (hlavička je na všech stránkách).
 * Jen když to web má; nic jiného se nemění.
 */
function klicenka_upravy_purge_all()
{
    try {
        if (did_action('elementor/loaded') && class_exists('\Elementor\Plugin') && isset(\Elementor\Plugin::$instance->files_manager)) {
            \Elementor\Plugin::$instance->files_manager->clear_cache();
        }
    } catch (\Throwable $e) {
        error_log('[klicenka-upravy] elementor cache: ' . $e->getMessage());
    }
    do_action('litespeed_purge_all');
    if (function_exists('wp_cache_clear_cache')) {
        wp_cache_clear_cache();
    }
    if (function_exists('rocket_clean_domain')) {
        rocket_clean_domain();
    }
}

/* ---------- Publikace a návrat ---------- */

/** @return array snímek stránky: obsah, výtah a meta v syrové podobě */
function klicenka_upravy_snapshot($post)
{
    return array('post_content' => $post->post_content, 'post_excerpt' => $post->post_excerpt, 'meta' => klicenka_upravy_raw_meta($post->ID));
}

function klicenka_upravy_backups($post_id)
{
    $raw = klicenka_upravy_get_meta_raw($post_id, '_klicenka_upravy_backups');
    $list = $raw ? json_decode($raw, true) : array();
    return is_array($list) ? $list : array();
}

function klicenka_upravy_store_backups($post_id, $list)
{
    if (!$list) {
        delete_post_meta($post_id, '_klicenka_upravy_backups');
        return true;
    }
    $json = wp_json_encode(array_values($list));
    if (!is_string($json)) {
        return false;
    }
    klicenka_upravy_set_meta_raw($post_id, '_klicenka_upravy_backups', $json);
    return klicenka_upravy_get_meta_raw($post_id, '_klicenka_upravy_backups') === $json;
}

/** Přepíše obsah a meta originálu ze snímku. Klíče, které ve snímku nejsou, zůstávají. */
function klicenka_upravy_apply($orig_id, $snap, $remove_keys = array())
{
    $res = klicenka_upravy_save_content(array('ID' => $orig_id, 'post_content' => $snap['post_content'], 'post_excerpt' => $snap['post_excerpt']));
    if (is_wp_error($res)) {
        return $res;
    }
    klicenka_upravy_write_meta($orig_id, $snap['meta']);
    foreach ($remove_keys as $k) {
        if (!klicenka_upravy_skip_meta($k)) {
            delete_post_meta($orig_id, $k);
        }
    }
    clean_post_cache($orig_id);
    return true;
}

function klicenka_upravy_rest_publish(WP_REST_Request $request)
{
    $draft = klicenka_upravy_draft($request['id']);
    if (is_wp_error($draft)) {
        return $draft;
    }
    $p = klicenka_upravy_payload();
    $orig = klicenka_upravy_original($p['post']);
    if (is_wp_error($orig)) {
        return $orig;
    }
    $was = (string) get_post_meta($draft->ID, '_klicenka_upravy_source_modified', true);
    if ($was !== '' && $was !== $orig->post_modified_gmt && !$request->get_param('force')) {
        return klicenka_upravy_error('conflict', 'Originál se od vytvoření konceptu změnil. Zkontrolujte ho; přepsat jde s "force": true.', 409);
    }

    // Záloha: vlastní kopie (posledních 3) + revize WordPressu.
    $backups = klicenka_upravy_backups($orig->ID);
    array_unshift($backups, array('time' => gmdate('c'), 'req' => $p['req'], 'draft' => $draft->ID, 'who' => $p['act']['email'] ?? null, 'snapshot' => klicenka_upravy_snapshot($orig)));
    if (!klicenka_upravy_store_backups($orig->ID, array_slice($backups, 0, KLICENKA_UPRAVY_BACKUPS))) {
        return klicenka_upravy_error('failed', 'Zálohu originálu se nepodařilo uložit, nic se nezměnilo.', 500);
    }
    if (wp_revisions_enabled($orig)) {
        wp_save_post_revision($orig->ID);
    }

    $snap = klicenka_upravy_snapshot($draft);
    $res = klicenka_upravy_apply($orig->ID, $snap);
    if (is_wp_error($res)) {
        return klicenka_upravy_error('failed', 'Publikace selhala, záloha je uložená.', 500);
    }
    // Obrázky nahrané ke konceptu patří od teď originálu.
    foreach (get_children(array('post_parent' => $draft->ID, 'post_type' => 'attachment', 'fields' => 'ids')) as $att) {
        wp_update_post(array('ID' => $att, 'post_parent' => $orig->ID));
    }
    $css = klicenka_upravy_is_elementor($orig->ID) ? klicenka_upravy_elementor_refresh($orig->ID) : null;
    if ($orig->post_type === 'elementor_library') {
        klicenka_upravy_purge_all();
    }
    // Koncept kitu: Elementor by mazání kitu zastavil dotazem pro člověka; naše kopie přestane být kitem a jde do koše.
    if (get_post_meta($draft->ID, '_elementor_template_type', true) === 'kit') {
        update_post_meta($draft->ID, '_elementor_template_type', 'section');
    }
    wp_trash_post($draft->ID);
    clean_post_cache($orig->ID);
    klicenka_upravy_log('publish', $p, array('draft' => $draft->ID, 'elementor_css' => $css));
    return rest_ensure_response(array('published' => $orig->ID, 'link' => get_permalink($orig->ID), 'draft_trashed' => $draft->ID, 'backups' => min(count($backups), KLICENKA_UPRAVY_BACKUPS), 'elementor_css' => $css));
}

function klicenka_upravy_rest_rollback(WP_REST_Request $request)
{
    $orig = klicenka_upravy_original($request['id']);
    if (is_wp_error($orig)) {
        return $orig;
    }
    $p = klicenka_upravy_payload();
    $backups = klicenka_upravy_backups($orig->ID);
    if (!$backups || !isset($backups[0]['snapshot'])) {
        return klicenka_upravy_error('not_found', 'Stránka nemá zálohu.', 404);
    }
    if ((string) $backups[0]['req'] !== $p['req']) {
        return klicenka_upravy_error('conflict', 'Poslední publikace patří jinému požadavku (#' . $backups[0]['req'] . '). Vracet jde jen poslední.', 409);
    }
    $b = array_shift($backups);
    if (wp_revisions_enabled($orig)) {
        wp_save_post_revision($orig->ID);
    }
    // Klíče, které přidal koncept a v záloze nejsou, se odeberou.
    $added = array_diff(array_keys(klicenka_upravy_raw_meta($orig->ID)), array_keys($b['snapshot']['meta']), array('_klicenka_upravy_backups'));
    $res = klicenka_upravy_apply($orig->ID, $b['snapshot'], $added);
    if (is_wp_error($res)) {
        return klicenka_upravy_error('failed', 'Obnova selhala.', 500);
    }
    klicenka_upravy_store_backups($orig->ID, $backups);
    $css = klicenka_upravy_is_elementor($orig->ID) ? klicenka_upravy_elementor_refresh($orig->ID) : null;
    if ($orig->post_type === 'elementor_library') {
        klicenka_upravy_purge_all();
    }
    klicenka_upravy_log('rollback', $p, array('backup_time' => $b['time']));
    return rest_ensure_response(array('restored' => $orig->ID, 'backup_time' => $b['time'], 'backups_left' => count($backups), 'elementor_css' => $css));
}

function klicenka_upravy_rest_status()
{
    nocache_headers();
    return rest_ensure_response(array(
        'name'      => 'klicenka-upravy',
        'version'   => KLICENKA_UPRAVY_VERSION,
        'klicenka'  => defined('KLICENKA_PLUGIN_VERSION') ? KLICENKA_PLUGIN_VERSION : null,
        'elementor' => defined('ELEMENTOR_VERSION'),
    ));
}

add_action('rest_api_init', function () {
    $id = '(?P<id>\d+)';
    $auth = function ($scope, $need_post = true) {
        return function (WP_REST_Request $r) use ($scope, $need_post) {
            return klicenka_upravy_authorize($r, $scope, $need_post);
        };
    };
    register_rest_route(KLICENKA_UPRAVY_NS, '/status', array('methods' => 'GET', 'callback' => 'klicenka_upravy_rest_status', 'permission_callback' => '__return_true'));
    register_rest_route(KLICENKA_UPRAVY_NS, '/pages', array('methods' => 'GET', 'callback' => 'klicenka_upravy_rest_pages', 'permission_callback' => $auth('drafts', false)));
    register_rest_route(KLICENKA_UPRAVY_NS, "/pages/$id/duplicate", array('methods' => 'POST', 'callback' => 'klicenka_upravy_rest_duplicate', 'permission_callback' => $auth('drafts')));
    register_rest_route(KLICENKA_UPRAVY_NS, "/drafts/$id/outline", array('methods' => 'GET', 'callback' => 'klicenka_upravy_rest_outline', 'permission_callback' => $auth('drafts')));
    register_rest_route(KLICENKA_UPRAVY_NS, "/drafts/$id/elements", array('methods' => 'PATCH', 'callback' => 'klicenka_upravy_rest_elements', 'permission_callback' => $auth('drafts')));
    register_rest_route(KLICENKA_UPRAVY_NS, "/drafts/$id/media", array('methods' => 'POST', 'callback' => 'klicenka_upravy_rest_media', 'permission_callback' => $auth('drafts')));
    register_rest_route(KLICENKA_UPRAVY_NS, "/drafts/$id/preview-link", array('methods' => 'GET', 'callback' => 'klicenka_upravy_rest_preview', 'permission_callback' => $auth('drafts')));
    register_rest_route(KLICENKA_UPRAVY_NS, "/drafts/$id/publish", array('methods' => 'POST', 'callback' => 'klicenka_upravy_rest_publish', 'permission_callback' => $auth('publish')));
    register_rest_route(KLICENKA_UPRAVY_NS, "/pages/$id/rollback", array('methods' => 'POST', 'callback' => 'klicenka_upravy_rest_rollback', 'permission_callback' => $auth('publish')));
});

// Odpovědi tohoto API se necachují (Hostinger/LiteSpeed cache).
add_filter('rest_post_dispatch', function ($res, $server, $request) {
    if (strpos($request->get_route(), '/' . KLICENKA_UPRAVY_NS) === 0 && $res instanceof WP_REST_Response) {
        $res->header('Cache-Control', 'no-store, private');
        $res->header('Referrer-Policy', 'no-referrer');
    }
    return $res;
}, 10, 3);
