<?php
/**
 * JEN PRO TEST na WP Playground. Nikdy nedávat na skutečný web.
 * Založí testovací stránky a vystaví nechráněný endpoint pro kontrolu stavu databáze.
 */

if (!defined('ABSPATH')) {
    exit;
}

function kut_elementor_fixture()
{
    return array(
        array('id' => 'sec1', 'elType' => 'section', 'settings' => array('background_color' => '#ffffff'), 'elements' => array(
            array('id' => 'col1', 'elType' => 'column', 'settings' => array('_column_size' => 100), 'elements' => array(
                array('id' => 'head1', 'elType' => 'widget', 'widgetType' => 'heading', 'settings' => array('title' => 'Původní nadpis stránky', 'header_size' => 'h1', 'title_color' => '#111111'), 'elements' => array()),
                array('id' => 'text1', 'elType' => 'widget', 'widgetType' => 'text-editor', 'settings' => array('editor' => '<p>Původní odstavec s cestou C:\\data a "uvozovkami".</p>'), 'elements' => array()),
                array('id' => 'btn1', 'elType' => 'widget', 'widgetType' => 'button', 'settings' => array('text' => 'Kontaktujte nás', 'link' => array('url' => 'https://example.test/kontakt', 'is_external' => '', 'nofollow' => '')), 'elements' => array()),
                array('id' => 'img1', 'elType' => 'widget', 'widgetType' => 'image', 'settings' => array('image' => array('id' => 0, 'url' => 'https://example.test/foto.jpg')), 'elements' => array()),
                array('id' => 'list1', 'elType' => 'widget', 'widgetType' => 'icon-list', 'settings' => array('icon_list' => array(
                    array('_id' => 'a1', 'text' => 'První položka seznamu'),
                    array('_id' => 'a2', 'text' => 'Druhá položka seznamu'),
                )), 'elements' => array()),
            )),
        )),
    );
}

add_action('init', function () {
    if (get_option('kut_fixtures')) {
        return;
    }
    update_option('kut_fixtures', 1);
    $el = wp_insert_post(array('post_type' => 'page', 'post_status' => 'publish', 'post_title' => 'Test Elementor', 'post_content' => '<p>fallback</p>', 'post_author' => 1));
    update_post_meta($el, '_elementor_edit_mode', 'builder');
    update_post_meta($el, '_elementor_template_type', 'wp-page');
    update_post_meta($el, '_elementor_version', defined('ELEMENTOR_VERSION') ? ELEMENTOR_VERSION : '3.0.0');
    update_post_meta($el, '_wp_page_template', 'elementor_header_footer');
    update_post_meta($el, '_elementor_page_settings', array('hide_title' => 'yes'));
    update_post_meta($el, '_elementor_data', wp_slash(wp_json_encode(kut_elementor_fixture())));
    update_post_meta($el, 'vlastni_meta', 'puvodni');

    $gb = '<!-- wp:heading {"level":2} -->' . "\n" . '<h2 class="wp-block-heading">Původní nadpis bloku</h2>' . "\n" . '<!-- /wp:heading -->' . "\n\n"
        . '<!-- wp:paragraph -->' . "\n" . '<p>Původní odstavec <a href="https://example.test/odkaz">odkaz</a>.</p>' . "\n" . '<!-- /wp:paragraph -->' . "\n\n"
        . '<!-- wp:group {"layout":{"type":"constrained"}} -->' . "\n" . '<div class="wp-block-group"><!-- wp:paragraph -->' . "\n" . '<p>Vnořený odstavec</p>' . "\n" . '<!-- /wp:paragraph --></div>' . "\n" . '<!-- /wp:group -->' . "\n\n"
        . '<!-- wp:html -->' . "\n" . '<div class="vlastni"><iframe src="https://example.test/mapa"></iframe></div>' . "\n" . '<!-- /wp:html -->';
    kses_remove_filters();
    $g = wp_insert_post(wp_slash(array('post_type' => 'page', 'post_status' => 'publish', 'post_title' => 'Test Gutenberg', 'post_content' => $gb, 'post_author' => 1)));
    kses_init();
    wp_insert_post(array('post_type' => 'page', 'post_status' => 'publish', 'post_title' => 'Cizí stránka', 'post_content' => '<p>Nesahat</p>', 'post_author' => 1));

    // Šablona patičky (Elementor Pro Theme Builder) s podmínkou zobrazení na celém webu.
    $f = wp_insert_post(array('post_type' => 'elementor_library', 'post_status' => 'publish', 'post_title' => 'Test Patička', 'post_content' => '', 'post_author' => 1));
    update_post_meta($f, '_elementor_edit_mode', 'builder');
    update_post_meta($f, '_elementor_template_type', 'footer');
    update_post_meta($f, '_elementor_conditions', array('include/general'));
    update_post_meta($f, '_elementor_data', wp_slash(wp_json_encode(array(
        array('id' => 'fsec', 'elType' => 'section', 'settings' => array(), 'elements' => array(
            array('id' => 'fcol', 'elType' => 'column', 'settings' => array('_column_size' => 100), 'elements' => array(
                array('id' => 'ftext', 'elType' => 'widget', 'widgetType' => 'text-editor', 'settings' => array('editor' => '<p>Ceník 2025</p>'), 'elements' => array()),
                array('id' => 'fbtn', 'elType' => 'widget', 'widgetType' => 'button', 'settings' => array('text' => 'Stáhnout ceník', 'link' => array('url' => 'https://example.test/cenik-2025.pdf')), 'elements' => array()),
            )),
        )),
    ))));
});

// Polylang (jen když běží): čeština a němčina, německá kopie stránky Test Elementor propojená jako překlad.
add_action('init', function () {
    if (!function_exists('pll_set_post_language') || get_option('kut_pll') || !get_option('kut_fixtures')) {
        return;
    }
    update_option('kut_pll', 1);
    $model = PLL()->model;
    foreach (array(array('Čeština', 'cs', 'cs_CZ'), array('Deutsch', 'de', 'de_DE')) as $i => $l) {
        $args = array('name' => $l[0], 'slug' => $l[1], 'locale' => $l[2], 'rtl' => 0, 'term_group' => $i, 'flag' => '');
        if (isset($model->languages) && method_exists($model->languages, 'add')) {
            $model->languages->add($args);
        } else {
            $model->add_language($args);
        }
    }
    if (method_exists($model, 'clean_languages_cache')) {
        $model->clean_languages_cache();
    }
    $cs = get_page_by_title('Test Elementor', OBJECT, 'page');
    $de = wp_insert_post(array('post_type' => 'page', 'post_status' => 'publish', 'post_title' => 'Test Elementor DE', 'post_content' => '<p>de</p>', 'post_author' => 1));
    update_post_meta($de, '_elementor_edit_mode', 'builder');
    update_post_meta($de, '_elementor_data', wp_slash(wp_json_encode(kut_elementor_fixture())));
    pll_set_post_language($cs->ID, 'cs');
    pll_set_post_language($de, 'de');
    pll_save_post_translations(array('cs' => $cs->ID, 'de' => $de));
}, 20);

add_action('rest_api_init', function () {
    register_rest_route('kut/v1', '/inspect', array('methods' => 'GET', 'permission_callback' => '__return_true', 'callback' => function ($r) {
        global $wpdb;
        $id = (int) $r['post'];
        $post = get_post($id);
        $meta = array();
        foreach ($wpdb->get_results($wpdb->prepare("SELECT meta_key, meta_value FROM {$wpdb->postmeta} WHERE post_id=%d", $id), ARRAY_A) as $m) {
            $meta[$m['meta_key']] = $m['meta_value'];
        }
        $author = $post ? get_user_by('id', $post->post_author) : null;
        return array(
            'post'      => $post ? array('id' => $post->ID, 'title' => $post->post_title, 'status' => $post->post_status, 'content' => $post->post_content, 'parent' => $post->post_parent, 'modified' => $post->post_modified_gmt) : null,
            'author'    => $author ? $author->user_login : null,
            'meta'      => $meta,
            'revisions' => $post ? count(wp_get_post_revisions($id)) : 0,
            'attachments' => $post ? array_values(get_children(array('post_parent' => $id, 'post_type' => 'attachment', 'fields' => 'ids'))) : array(),
        );
    }));
    register_rest_route('kut/v1', '/state', array('methods' => 'GET', 'permission_callback' => '__return_true', 'callback' => function () {
        $u = get_user_by('login', 'claude-upravy');
        $role = get_role('claude_upravy');
        $login = null;
        if ($u) {
            wp_set_password('heslo-pro-test-123', $u->ID);
            $res = wp_authenticate('claude-upravy', 'heslo-pro-test-123');
            $login = is_wp_error($res) ? $res->get_error_code() : 'PRIHLASEN';
        }
        $pages = array();
        foreach (get_posts(array('post_type' => array('page', 'elementor_library'), 'post_status' => 'any', 'numberposts' => -1)) as $p) {
            $pages[$p->post_title] = $p->ID;
        }
        return array(
            'user'       => $u ? array('id' => $u->ID, 'roles' => $u->roles, 'caps' => $u->caps, 'allcaps' => array_keys(array_filter($u->allcaps))) : null,
            'role_caps'  => $role ? array_keys(array_filter($role->capabilities)) : null,
            'password_login' => $login,
            'log'        => get_option('klicenka_upravy_log', array()),
            'pages'      => $pages,
            'elementor'  => defined('ELEMENTOR_VERSION') ? ELEMENTOR_VERSION : null,
            'kit'        => (int) get_option('elementor_active_kit'),
        );
    }));
    register_rest_route('kut/v1', '/touch', array('methods' => 'POST', 'permission_callback' => '__return_true', 'callback' => function ($r) {
        $id = (int) $r['post'];
        sleep(1);
        wp_update_post(array('ID' => $id, 'post_excerpt' => 'změněno klientem ' . time()));
        return array('ok' => true);
    }));
    register_rest_route('kut/v1', '/elevate', array('methods' => 'POST', 'permission_callback' => '__return_true', 'callback' => function () {
        $u = get_user_by('login', 'claude-upravy');
        $u->add_role('administrator');
        $u->add_cap('manage_options');
        return array('ok' => true);
    }));
});
