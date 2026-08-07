<?php
/**
 * Plugin Name:  Artivio Elementor Agent
 * Plugin URI:   https://artivio.io
 * Description:  Exposes Elementor's page tree over the REST API so Artivio's agent can read and edit layouts. Elementor stores every page in the protected `_elementor_data` postmeta key, which core WP REST will never touch — this plugin is the only reason remote editing is possible.
 * Version:      1.1.0
 * Requires PHP: 7.4
 * Author:       Artivio
 * License:      GPL-2.0-or-later
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SECURITY MODEL
 *
 * Every route requires an authenticated user with `edit_posts`, and every route
 * that names a document ALSO checks `edit_post` on that specific post. Auth is
 * whatever WordPress already accepts — in Artivio's case an Application
 * Password over HTTPS Basic, identical to the WordPress and DiviOps plugins.
 *
 * This plugin does NOT run kses on element settings. Elementor settings legally
 * contain raw HTML (the Text Editor widget, the HTML widget, custom CSS), so
 * filtering them would corrupt real pages. A caller with these routes therefore
 * has the same power as a user sitting in the Elementor editor — no more, but no
 * less. Issue the Application Password to an Editor, never an Administrator, and
 * revoke it when the engagement ends.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TWO GOTCHAS THAT SILENTLY CORRUPT ELEMENTOR PAGES
 *
 * 1. `_elementor_data` must be written with wp_slash( wp_json_encode( $tree ) ).
 *    update_post_meta() runs wp_unslash() on its input, so an unslashed JSON
 *    string loses every backslash in it. Pages using \n, unicode escapes or
 *    regex in settings come back subtly broken, days later, with no error.
 *
 * 2. Elementor serves a CACHED CSS FILE per post. Write the tree without
 *    clearing that cache and the save succeeds, the editor shows the change,
 *    and the live page looks identical to before. Every write route here ends
 *    in artivio_ea_flush_css().
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'ARTIVIO_EA_VERSION', '1.1.0' );
define( 'ARTIVIO_EA_NS', 'artivio-elementor/v1' );

/* ══════════════════════════════════════════════════════════════════════════
 * Basic-auth bootstrap (added 1.1.0)
 *
 * WordPress authenticates Application Passwords in
 * wp_authenticate_application_password(), which reads ONLY
 * $_SERVER['PHP_AUTH_USER'] and $_SERVER['PHP_AUTH_PW']. Apache/mod_php fills
 * those in automatically. **PHP running as CGI/FastCGI — which is the norm on
 * LiteSpeed, and on most managed hosts — does not.**
 *
 * The standard `.htaccess` line WordPress ships,
 *   RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]
 * only copies the header into an ENV VAR ($_SERVER['HTTP_AUTHORIZATION'] or
 * ['REDIRECT_HTTP_AUTHORIZATION']). Core never reads those back, so the
 * credential arrives at the server, sits in $_SERVER, and is ignored.
 *
 * The failure is silent and deeply misleading: the request is simply treated as
 * ANONYMOUS. Public reads (list posts, list pages, list categories) keep
 * working, so the integration looks healthy, while anything requiring auth
 * returns `rest_not_logged_in` / "You are not currently logged in." That reads
 * like a bad password, and it is not one.
 *
 * 🔒 THIS GRANTS NOTHING. It only re-exposes to PHP a header the client already
 * sent, in the exact form PHP would have provided natively. WordPress still
 * validates the username and password normally, and a wrong credential still
 * fails. We touch it only when PHP_AUTH_USER is absent, and only for `Basic`.
 *
 * The alternative is a server change — `CGIPassAuth On` in .htaccess (Apache
 * 2.4.13+ / LiteSpeed) — which not every host permits. This runs everywhere.
 * ══════════════════════════════════════════════════════════════════════════ */

if ( ! function_exists( 'artivio_ea_bootstrap_basic_auth' ) ) {
	function artivio_ea_bootstrap_basic_auth(): void {
		/**
		 * Four states, not two. The first version recorded a bare
		 * shimmed-yes/no, which collapsed the two most important cases into one
		 * label: "PHP handled it natively" and "there was no Authorization
		 * header to handle" both reported `native`. Those need opposite
		 * responses — one is healthy, the other means something upstream ate
		 * the header — so they get different names.
		 */
		$GLOBALS['artivio_ea_auth_source'] = 'absent';

		if ( ! empty( $_SERVER['PHP_AUTH_USER'] ) ) {
			$GLOBALS['artivio_ea_auth_source'] = 'native';
			return; // PHP already parsed it — nothing to repair.
		}

		$header = '';
		foreach (
			array(
				'HTTP_AUTHORIZATION',
				'REDIRECT_HTTP_AUTHORIZATION',
				'REDIRECT_REDIRECT_HTTP_AUTHORIZATION',
			) as $key
		) {
			if ( ! empty( $_SERVER[ $key ] ) ) {
				$header = trim( (string) $_SERVER[ $key ] );
				break;
			}
		}

		if ( '' === $header && function_exists( 'apache_request_headers' ) ) {
			foreach ( (array) apache_request_headers() as $k => $v ) {
				if ( 'authorization' === strtolower( (string) $k ) ) {
					$header = trim( (string) $v );
					break;
				}
			}
		}

		if ( '' === $header ) {
			return; // stays 'absent' — nothing reached PHP at all.
		}
		if ( 0 !== stripos( $header, 'basic ' ) ) {
			$GLOBALS['artivio_ea_auth_source'] = 'unusable';
			return;
		}

		$decoded = base64_decode( substr( $header, 6 ), true ); // phpcs:ignore
		if ( false === $decoded || false === strpos( $decoded, ':' ) ) {
			$GLOBALS['artivio_ea_auth_source'] = 'unusable';
			return;
		}

		// Split at the FIRST colon: application passwords contain spaces but
		// never a colon, and a WordPress username cannot contain one either.
		list( $user, $pass ) = explode( ':', $decoded, 2 );
		if ( '' === $user ) {
			$GLOBALS['artivio_ea_auth_source'] = 'unusable';
			return;
		}

		$_SERVER['PHP_AUTH_USER']          = $user;
		$_SERVER['PHP_AUTH_PW']            = $pass;
		$GLOBALS['artivio_ea_auth_source'] = 'shim';
	}
}

/**
 * Explain a 401/403 on OUR routes, in the response body.
 *
 * A rejected request never reaches a handler, so /status cannot report on the
 * one case that most needs reporting: an Authorization header that never
 * arrived. WordPress renders that as `rest_forbidden` — indistinguishable from
 * a wrong password, which is the exact confusion that made this plugin's own
 * rollout take an afternoon. Anyone installing this on a host that strips the
 * header should be told so by the response, not left to guess.
 */
function artivio_ea_annotate_auth_failure( $response, $server, $request ) {
	unset( $server );
	if ( ! ( $response instanceof WP_REST_Response ) || ! ( $request instanceof WP_REST_Request ) ) {
		return $response;
	}
	if ( 0 !== strpos( ltrim( (string) $request->get_route(), '/' ), 'artivio-elementor/' ) ) {
		return $response;
	}
	$status = $response->get_status();
	if ( 401 !== $status && 403 !== $status ) {
		return $response;
	}
	$data = $response->get_data();
	if ( ! is_array( $data ) ) {
		return $response;
	}

	$source = isset( $GLOBALS['artivio_ea_auth_source'] ) ? (string) $GLOBALS['artivio_ea_auth_source'] : 'absent';
	$hints  = array(
		'absent'   => 'PHP received NO Authorization header for this request. The credential was never seen, so this is not a wrong password. Something upstream removed it — a proxy, CDN, or a server passing PHP as CGI/FastCGI without CGIPassAuth. Fix at the server: add "CGIPassAuth On" to .htaccess (Apache 2.4.13+ / LiteSpeed), or ask the host to forward the Authorization header.',
		'unusable' => 'An Authorization header arrived but was not a decodable HTTP Basic credential. Artivio sends Basic; something in front of this site is rewriting it.',
		'native'   => 'The credential reached WordPress and WordPress rejected it. The username or application password is wrong or revoked, or the user lacks the edit_posts capability.',
		'shim'     => 'The credential reached WordPress and WordPress rejected it. The username or application password is wrong or revoked, or the user lacks the edit_posts capability.',
	);

	$data['artivioDiagnostic'] = array(
		'authSource' => $source,
		'hint'       => $hints[ $source ] ?? $hints['absent'],
	);
	$response->set_data( $data );
	return $response;
}
add_filter( 'rest_post_dispatch', 'artivio_ea_annotate_auth_failure', 10, 3 );

// Must run at file scope: WordPress resolves the current user lazily, after
// plugins load, so setting these here is early enough for both core REST auth
// and our own routes.
artivio_ea_bootstrap_basic_auth();

/* ══════════════════════════════════════════════════════════════════════════
 * Storage
 * ══════════════════════════════════════════════════════════════════════════ */

function artivio_ea_elementor_active(): bool {
	return did_action( 'elementor/loaded' ) || class_exists( '\Elementor\Plugin' );
}

/** Read a document's Elementor tree. Returns [] for a page not built with Elementor. */
function artivio_ea_get_tree( int $post_id ): array {
	$raw = get_post_meta( $post_id, '_elementor_data', true );
	if ( empty( $raw ) ) {
		return array();
	}
	if ( is_array( $raw ) ) {
		return $raw;
	}
	$decoded = json_decode( $raw, true );
	return is_array( $decoded ) ? $decoded : array();
}

/**
 * Write a document's Elementor tree.
 * wp_slash() is NOT optional — see GOTCHA 1 at the top of this file.
 */
function artivio_ea_put_tree( int $post_id, array $tree ): void {
	update_post_meta( $post_id, '_elementor_data', wp_slash( wp_json_encode( $tree ) ) );
	update_post_meta( $post_id, '_elementor_edit_mode', 'builder' );
	if ( ! get_post_meta( $post_id, '_elementor_template_type', true ) ) {
		update_post_meta( $post_id, '_elementor_template_type', 'wp-page' );
	}
	if ( defined( 'ELEMENTOR_VERSION' ) ) {
		update_post_meta( $post_id, '_elementor_version', ELEMENTOR_VERSION );
	}
	artivio_ea_flush_css( $post_id );
}

/** Clear Elementor's cached CSS so the live page actually reflects the write. */
function artivio_ea_flush_css( int $post_id ): void {
	if ( $post_id > 0 ) {
		delete_post_meta( $post_id, '_elementor_css' );
		clean_post_cache( $post_id );
	}
	if ( ! artivio_ea_elementor_active() ) {
		return;
	}
	try {
		if ( isset( \Elementor\Plugin::$instance->files_manager ) ) {
			\Elementor\Plugin::$instance->files_manager->clear_cache();
		}
	} catch ( \Throwable $e ) { // phpcs:ignore Generic.CodeAnalysis.EmptyStatement
		// A cache-clear failure must never fail the write that already succeeded.
		unset( $e );
	}
}

/* ══════════════════════════════════════════════════════════════════════════
 * Tree navigation
 *
 * Elements are addressed by PATH — a list of integer indices from the root.
 * The obvious alternative (a finder that returns PHP references into the tree)
 * looks tidier and is a trap: references survive array copies in ways that are
 * almost impossible to reason about, and a foreach-by-reference leaves a live
 * alias behind after the loop. Paths are plain data; the only references in
 * this file are the three tiny *_ref() helpers below.
 * ══════════════════════════════════════════════════════════════════════════ */

/** Path to the element with $target, or null. */
function artivio_ea_path( array $tree, string $target, array $prefix = array() ) {
	foreach ( $tree as $i => $el ) {
		$path = array_merge( $prefix, array( (int) $i ) );
		if ( isset( $el['id'] ) && (string) $el['id'] === $target ) {
			return $path;
		}
		if ( ! empty( $el['elements'] ) && is_array( $el['elements'] ) ) {
			$found = artivio_ea_path( $el['elements'], $target, $path );
			if ( null !== $found ) {
				return $found;
			}
		}
	}
	return null;
}

/** Reference to the array that holds the element at $path (its sibling list). */
function &artivio_ea_siblings_ref( array &$tree, array $path ) {
	$ref   = &$tree;
	$depth = count( $path ) - 1;
	for ( $i = 0; $i < $depth; $i++ ) {
		$idx = $path[ $i ];
		if ( ! isset( $ref[ $idx ]['elements'] ) || ! is_array( $ref[ $idx ]['elements'] ) ) {
			$ref[ $idx ]['elements'] = array();
		}
		$ref = &$ref[ $idx ]['elements'];
	}
	return $ref;
}

/** Reference to the element at $path. */
function &artivio_ea_element_ref( array &$tree, array $path ) {
	$siblings = &artivio_ea_siblings_ref( $tree, $path );
	$last     = $path[ count( $path ) - 1 ];
	$ref      = &$siblings[ $last ];
	return $ref;
}

/** Reference to a container's child list. An empty path means the document root. */
function &artivio_ea_children_ref( array &$tree, array $path ) {
	if ( empty( $path ) ) {
		return $tree;
	}
	$el = &artivio_ea_element_ref( $tree, $path );
	if ( ! isset( $el['elements'] ) || ! is_array( $el['elements'] ) ) {
		$el['elements'] = array();
	}
	return $el['elements'];
}

/** Read-only fetch of the element at $path. */
function artivio_ea_element_at( array $tree, array $path ) {
	$node = null;
	$list = $tree;
	foreach ( $path as $idx ) {
		if ( ! isset( $list[ $idx ] ) ) {
			return null;
		}
		$node = $list[ $idx ];
		$list = ( ! empty( $node['elements'] ) && is_array( $node['elements'] ) ) ? $node['elements'] : array();
	}
	return $node;
}

/* ══════════════════════════════════════════════════════════════════════════
 * Element helpers
 * ══════════════════════════════════════════════════════════════════════════ */

/** Elementor-style 7-char element id, unique against $taken. */
function artivio_ea_new_id( array &$taken ): string {
	do {
		$id = substr( md5( uniqid( (string) wp_rand(), true ) ), 0, 7 );
	} while ( isset( $taken[ $id ] ) );
	$taken[ $id ] = true;
	return $id;
}

/** Every element id already used in a tree. */
function artivio_ea_collect_ids( array $tree, array &$taken ): void {
	foreach ( $tree as $el ) {
		if ( isset( $el['id'] ) ) {
			$taken[ (string) $el['id'] ] = true;
		}
		if ( ! empty( $el['elements'] ) && is_array( $el['elements'] ) ) {
			artivio_ea_collect_ids( $el['elements'], $taken );
		}
	}
}

/** Give a subtree fresh ids throughout, and normalise its shape. */
function artivio_ea_reid( array $el, array &$taken ): array {
	$el['id'] = artivio_ea_new_id( $taken );
	if ( ! isset( $el['settings'] ) || ! is_array( $el['settings'] ) ) {
		$el['settings'] = array();
	}
	if ( ! empty( $el['elements'] ) && is_array( $el['elements'] ) ) {
		$children = array();
		foreach ( $el['elements'] as $child ) {
			if ( is_array( $child ) ) {
				$children[] = artivio_ea_reid( $child, $taken );
			}
		}
		$el['elements'] = $children;
	} else {
		$el['elements'] = array();
	}
	return $el;
}

/** Short human label for an element, so the agent can navigate a tree it can't see. */
function artivio_ea_label( array $el ): string {
	$s = ( isset( $el['settings'] ) && is_array( $el['settings'] ) ) ? $el['settings'] : array();
	foreach ( array( 'title', 'heading', 'editor', 'text', 'title_text', 'button_text', 'html', 'caption', '_title' ) as $key ) {
		if ( ! empty( $s[ $key ] ) && is_string( $s[ $key ] ) ) {
			$plain = trim( wp_strip_all_tags( $s[ $key ] ) );
			if ( '' !== $plain ) {
				return mb_substr( $plain, 0, 80 );
			}
		}
	}
	return '';
}

/**
 * Compact recursive outline of a tree.
 *
 * Deliberately NOT the raw JSON: a real Elementor page is 50–500 KB of settings,
 * and handing that to a language model burns the context window before it can do
 * anything with it. The agent walks this outline, then pulls the ONE element it
 * needs in full via /elements/<id>.
 */
function artivio_ea_outline( array $tree, int $depth, int $max_depth ): array {
	$out = array();
	foreach ( $tree as $el ) {
		if ( ! is_array( $el ) ) {
			continue;
		}
		$node = array(
			'id'     => isset( $el['id'] ) ? (string) $el['id'] : '',
			'elType' => isset( $el['elType'] ) ? $el['elType'] : 'unknown',
		);
		if ( ! empty( $el['widgetType'] ) ) {
			$node['widgetType'] = $el['widgetType'];
		}
		$label = artivio_ea_label( $el );
		if ( '' !== $label ) {
			$node['label'] = $label;
		}
		$children = ( ! empty( $el['elements'] ) && is_array( $el['elements'] ) ) ? $el['elements'] : array();
		if ( $children ) {
			$node['childCount'] = count( $children );
			if ( $depth < $max_depth ) {
				$node['children'] = artivio_ea_outline( $children, $depth + 1, $max_depth );
			}
		}
		$out[] = $node;
	}
	return $out;
}

/* ══════════════════════════════════════════════════════════════════════════
 * Permissions
 * ══════════════════════════════════════════════════════════════════════════ */

function artivio_ea_can_edit(): bool {
	return current_user_can( 'edit_posts' );
}

/** Returns WP_Error unless the current user may edit this specific post. */
function artivio_ea_guard_post( int $post_id ) {
	$post = get_post( $post_id );
	if ( ! $post ) {
		return new WP_Error( 'artivio_ea_not_found', 'No post with that id.', array( 'status' => 404 ) );
	}
	if ( ! current_user_can( 'edit_post', $post_id ) ) {
		return new WP_Error( 'artivio_ea_forbidden', 'This user cannot edit that post.', array( 'status' => 403 ) );
	}
	return $post;
}

/* ══════════════════════════════════════════════════════════════════════════
 * Routes
 * ══════════════════════════════════════════════════════════════════════════ */

add_action( 'rest_api_init', 'artivio_ea_register_routes' );

function artivio_ea_register_routes() {
	$auth = 'artivio_ea_can_edit';

	register_rest_route(
		ARTIVIO_EA_NS,
		'/status',
		array(
			'methods'             => 'GET',
			'permission_callback' => $auth,
			'callback'            => 'artivio_ea_status',
		)
	);

	register_rest_route(
		ARTIVIO_EA_NS,
		'/documents',
		array(
			array(
				'methods'             => 'GET',
				'permission_callback' => $auth,
				'callback'            => 'artivio_ea_list_documents',
			),
			array(
				'methods'             => 'POST',
				'permission_callback' => $auth,
				'callback'            => 'artivio_ea_create_document',
			),
		)
	);

	register_rest_route(
		ARTIVIO_EA_NS,
		'/documents/(?P<id>\d+)/tree',
		array(
			array(
				'methods'             => 'GET',
				'permission_callback' => $auth,
				'callback'            => 'artivio_ea_get_full_tree',
			),
			array(
				'methods'             => 'PUT',
				'permission_callback' => $auth,
				'callback'            => 'artivio_ea_put_full_tree',
			),
		)
	);

	register_rest_route(
		ARTIVIO_EA_NS,
		'/documents/(?P<id>\d+)/outline',
		array(
			'methods'             => 'GET',
			'permission_callback' => $auth,
			'callback'            => 'artivio_ea_get_outline',
		)
	);

	register_rest_route(
		ARTIVIO_EA_NS,
		'/documents/(?P<id>\d+)/elements',
		array(
			'methods'             => 'POST',
			'permission_callback' => $auth,
			'callback'            => 'artivio_ea_add_element',
		)
	);

	register_rest_route(
		ARTIVIO_EA_NS,
		'/documents/(?P<id>\d+)/elements/(?P<el>[A-Za-z0-9_-]+)',
		array(
			array(
				'methods'             => 'GET',
				'permission_callback' => $auth,
				'callback'            => 'artivio_ea_get_element',
			),
			array(
				'methods'             => 'PATCH',
				'permission_callback' => $auth,
				'callback'            => 'artivio_ea_patch_element',
			),
			array(
				'methods'             => 'DELETE',
				'permission_callback' => $auth,
				'callback'            => 'artivio_ea_delete_element',
			),
		)
	);

	register_rest_route(
		ARTIVIO_EA_NS,
		'/documents/(?P<id>\d+)/elements/(?P<el>[A-Za-z0-9_-]+)/move',
		array(
			'methods'             => 'POST',
			'permission_callback' => $auth,
			'callback'            => 'artivio_ea_move_element',
		)
	);

	register_rest_route(
		ARTIVIO_EA_NS,
		'/documents/(?P<id>\d+)/elements/(?P<el>[A-Za-z0-9_-]+)/duplicate',
		array(
			'methods'             => 'POST',
			'permission_callback' => $auth,
			'callback'            => 'artivio_ea_duplicate_element',
		)
	);

	register_rest_route(
		ARTIVIO_EA_NS,
		'/widgets',
		array(
			'methods'             => 'GET',
			'permission_callback' => $auth,
			'callback'            => 'artivio_ea_list_widgets',
		)
	);

	register_rest_route(
		ARTIVIO_EA_NS,
		'/widgets/(?P<name>[A-Za-z0-9_-]+)/schema',
		array(
			'methods'             => 'GET',
			'permission_callback' => $auth,
			'callback'            => 'artivio_ea_widget_schema',
		)
	);

	register_rest_route(
		ARTIVIO_EA_NS,
		'/templates',
		array(
			'methods'             => 'GET',
			'permission_callback' => $auth,
			'callback'            => 'artivio_ea_list_templates',
		)
	);

	register_rest_route(
		ARTIVIO_EA_NS,
		'/documents/(?P<id>\d+)/apply-template',
		array(
			'methods'             => 'POST',
			'permission_callback' => $auth,
			'callback'            => 'artivio_ea_apply_template',
		)
	);

	register_rest_route(
		ARTIVIO_EA_NS,
		'/kit',
		array(
			array(
				'methods'             => 'GET',
				'permission_callback' => $auth,
				'callback'            => 'artivio_ea_get_kit',
			),
			array(
				'methods'             => 'PATCH',
				'permission_callback' => $auth,
				'callback'            => 'artivio_ea_patch_kit',
			),
		)
	);

	register_rest_route(
		ARTIVIO_EA_NS,
		'/flush-css',
		array(
			'methods'             => 'POST',
			'permission_callback' => $auth,
			'callback'            => 'artivio_ea_flush_route',
		)
	);
}

/* ══════════════════════════════════════════════════════════════════════════
 * Handlers
 * ══════════════════════════════════════════════════════════════════════════ */

function artivio_ea_status() {
	$user = wp_get_current_user();
	return array(
		'ok'                => true,
		'plugin'            => 'artivio-elementor-agent',
		'pluginVersion'     => ARTIVIO_EA_VERSION,
		'elementorActive'   => artivio_ea_elementor_active(),
		'elementor'         => defined( 'ELEMENTOR_VERSION' ) ? ELEMENTOR_VERSION : null,
		'elementorPro'      => defined( 'ELEMENTOR_PRO_VERSION' ) ? ELEMENTOR_PRO_VERSION : null,
		'wp'                => get_bloginfo( 'version' ),
		'php'               => PHP_VERSION,
		'activeKitId'       => (int) get_option( 'elementor_active_kit' ),
		'user'              => $user ? $user->user_login : null,
		'roles'             => $user ? array_values( (array) $user->roles ) : array(),
		'canUnfilteredHtml' => current_user_can( 'unfiltered_html' ),
		// How the credential actually reached PHP. `native` = this server
		// populates PHP_AUTH_USER itself (Apache/mod_php); `shim` = it does not
		// (CGI/FastCGI — LiteSpeed, PHP-FPM, most managed hosts) and this plugin
		// recovered it, meaning core WordPress would have treated every
		// authenticated request as anonymous without this plugin loaded,
		// including plain /wp/v2/ writes. Only these two can appear here: a
		// request with no usable credential never reaches this handler.
		'authSource'        => isset( $GLOBALS['artivio_ea_auth_source'] ) ? $GLOBALS['artivio_ea_auth_source'] : 'native',
	);
}

function artivio_ea_flush_route( WP_REST_Request $r ) {
	$post_id = (int) $r->get_param( 'id' );
	if ( $post_id > 0 ) {
		$guard = artivio_ea_guard_post( $post_id );
		if ( is_wp_error( $guard ) ) {
			return $guard;
		}
	}
	artivio_ea_flush_css( $post_id );
	return array(
		'flushed' => true,
		'postId'  => $post_id ?: null,
		'scope'   => $post_id ? 'post + site CSS cache' : 'site CSS cache',
	);
}

function artivio_ea_list_documents( WP_REST_Request $r ) {
	$type     = $r->get_param( 'type' ) ? (string) $r->get_param( 'type' ) : 'any';
	$search   = (string) $r->get_param( 'search' );
	$per_page = min( 100, max( 1, (int) ( $r->get_param( 'per_page' ) ?: 25 ) ) );

	$post_types = ( 'any' === $type ) ? array( 'page', 'post', 'elementor_library' ) : array( $type );

	$args = array(
		'post_type'      => $post_types,
		'post_status'    => array( 'publish', 'draft', 'pending', 'private', 'future' ),
		'posts_per_page' => $per_page,
		'orderby'        => 'modified',
		'order'          => 'DESC',
		'no_found_rows'  => true,
	);
	if ( '' !== $search ) {
		$args['s'] = $search;
	}

	$q    = new WP_Query( $args );
	$rows = array();
	foreach ( $q->posts as $p ) {
		$rows[] = array(
			'id'                 => $p->ID,
			'type'               => $p->post_type,
			'status'             => $p->post_status,
			'title'              => get_the_title( $p ),
			'slug'               => $p->post_name,
			'link'               => get_permalink( $p ),
			'modified'           => $p->post_modified_gmt,
			'builtWithElementor' => 'builder' === get_post_meta( $p->ID, '_elementor_edit_mode', true ),
			'templateType'       => get_post_meta( $p->ID, '_elementor_template_type', true ) ?: null,
		);
	}
	wp_reset_postdata();
	return array( 'documents' => $rows );
}

function artivio_ea_create_document( WP_REST_Request $r ) {
	$type = in_array( $r->get_param( 'type' ), array( 'page', 'post' ), true ) ? (string) $r->get_param( 'type' ) : 'page';
	$cap  = ( 'page' === $type ) ? 'edit_pages' : 'edit_posts';
	if ( ! current_user_can( $cap ) ) {
		return new WP_Error( 'artivio_ea_forbidden', "This user cannot create a {$type}.", array( 'status' => 403 ) );
	}

	$tree = $r->get_param( 'tree' );
	$tree = is_array( $tree ) ? $tree : array();

	$post_id = wp_insert_post(
		array(
			'post_title'   => (string) ( $r->get_param( 'title' ) ?: 'Untitled' ),
			'post_type'    => $type,
			'post_status'  => 'draft', // Draft-first, always. Publishing is a human decision.
			'post_content' => '',
		),
		true
	);
	if ( is_wp_error( $post_id ) ) {
		return $post_id;
	}

	$taken     = array();
	$normalised = array();
	foreach ( $tree as $el ) {
		if ( is_array( $el ) ) {
			$normalised[] = artivio_ea_reid( $el, $taken );
		}
	}
	artivio_ea_put_tree( (int) $post_id, $normalised );

	return array(
		'id'     => (int) $post_id,
		'status' => 'draft',
		'link'   => get_permalink( $post_id ),
		'note'   => 'Created as a DRAFT. Nothing is live until a human publishes it.',
	);
}

function artivio_ea_get_full_tree( WP_REST_Request $r ) {
	$post_id = (int) $r['id'];
	$guard   = artivio_ea_guard_post( $post_id );
	if ( is_wp_error( $guard ) ) {
		return $guard;
	}
	return array(
		'id'   => $post_id,
		'tree' => artivio_ea_get_tree( $post_id ),
	);
}

function artivio_ea_put_full_tree( WP_REST_Request $r ) {
	$post_id = (int) $r['id'];
	$guard   = artivio_ea_guard_post( $post_id );
	if ( is_wp_error( $guard ) ) {
		return $guard;
	}
	$tree = $r->get_param( 'tree' );
	if ( ! is_array( $tree ) ) {
		return new WP_Error( 'artivio_ea_bad_tree', '`tree` must be an array of Elementor elements.', array( 'status' => 400 ) );
	}

	$taken = array();
	artivio_ea_collect_ids( $tree, $taken );
	// An element written without an id is invisible to every other route in this
	// file, so anything arriving id-less gets one here rather than later.
	$tree = artivio_ea_fill_ids( $tree, $taken );

	artivio_ea_put_tree( $post_id, $tree );
	return array(
		'id'       => $post_id,
		'replaced' => true,
		'topLevel' => count( $tree ),
		'link'     => get_permalink( $post_id ),
	);
}

function artivio_ea_fill_ids( array $tree, array &$taken ): array {
	$out = array();
	foreach ( $tree as $el ) {
		if ( ! is_array( $el ) ) {
			continue;
		}
		if ( empty( $el['id'] ) ) {
			$el['id'] = artivio_ea_new_id( $taken );
		}
		if ( ! empty( $el['elements'] ) && is_array( $el['elements'] ) ) {
			$el['elements'] = artivio_ea_fill_ids( $el['elements'], $taken );
		}
		$out[] = $el;
	}
	return $out;
}

function artivio_ea_get_outline( WP_REST_Request $r ) {
	$post_id = (int) $r['id'];
	$guard   = artivio_ea_guard_post( $post_id );
	if ( is_wp_error( $guard ) ) {
		return $guard;
	}
	$depth = min( 12, max( 1, (int) ( $r->get_param( 'depth' ) ?: 6 ) ) );
	$tree  = artivio_ea_get_tree( $post_id );

	return array(
		'id'                 => $post_id,
		'title'              => get_the_title( $post_id ),
		'link'               => get_permalink( $post_id ),
		'builtWithElementor' => 'builder' === get_post_meta( $post_id, '_elementor_edit_mode', true ),
		'depth'              => $depth,
		'outline'            => artivio_ea_outline( $tree, 1, $depth ),
	);
}

function artivio_ea_get_element( WP_REST_Request $r ) {
	$post_id = (int) $r['id'];
	$guard   = artivio_ea_guard_post( $post_id );
	if ( is_wp_error( $guard ) ) {
		return $guard;
	}
	$tree = artivio_ea_get_tree( $post_id );
	$path = artivio_ea_path( $tree, (string) $r['el'] );
	if ( null === $path ) {
		return new WP_Error( 'artivio_ea_no_element', 'No element with that id on this page.', array( 'status' => 404 ) );
	}
	$el = artivio_ea_element_at( $tree, $path );
	return array(
		'id'         => $el['id'],
		'elType'     => $el['elType'] ?? null,
		'widgetType' => $el['widgetType'] ?? null,
		'settings'   => ( isset( $el['settings'] ) && is_array( $el['settings'] ) && $el['settings'] ) ? $el['settings'] : new stdClass(),
		'childCount' => ( isset( $el['elements'] ) && is_array( $el['elements'] ) ) ? count( $el['elements'] ) : 0,
		'depth'      => count( $path ),
	);
}

function artivio_ea_patch_element( WP_REST_Request $r ) {
	$post_id = (int) $r['id'];
	$guard   = artivio_ea_guard_post( $post_id );
	if ( is_wp_error( $guard ) ) {
		return $guard;
	}
	$settings = $r->get_param( 'settings' );
	if ( ! is_array( $settings ) ) {
		return new WP_Error( 'artivio_ea_bad_settings', '`settings` must be an object of control keys to merge.', array( 'status' => 400 ) );
	}
	$replace = filter_var( $r->get_param( 'replace' ), FILTER_VALIDATE_BOOLEAN );

	$tree = artivio_ea_get_tree( $post_id );
	$path = artivio_ea_path( $tree, (string) $r['el'] );
	if ( null === $path ) {
		return new WP_Error( 'artivio_ea_no_element', 'No element with that id on this page.', array( 'status' => 404 ) );
	}

	$el     = &artivio_ea_element_ref( $tree, $path );
	$before = ( isset( $el['settings'] ) && is_array( $el['settings'] ) ) ? $el['settings'] : array();
	// MERGE by default. A replace-by-default patch quietly wipes every control
	// the caller didn't happen to mention — spacing, responsive overrides,
	// motion effects — and the page ends up "almost right" in a way nobody can
	// diff afterwards.
	$el['settings'] = $replace ? $settings : array_replace( $before, $settings );
	unset( $el );

	artivio_ea_put_tree( $post_id, $tree );
	return array(
		'id'          => (string) $r['el'],
		'updated'     => true,
		'mode'        => $replace ? 'replace' : 'merge',
		'changedKeys' => array_keys( $settings ),
		'link'        => get_permalink( $post_id ),
	);
}

function artivio_ea_delete_element( WP_REST_Request $r ) {
	$post_id = (int) $r['id'];
	$guard   = artivio_ea_guard_post( $post_id );
	if ( is_wp_error( $guard ) ) {
		return $guard;
	}
	$tree = artivio_ea_get_tree( $post_id );
	$path = artivio_ea_path( $tree, (string) $r['el'] );
	if ( null === $path ) {
		return new WP_Error( 'artivio_ea_no_element', 'No element with that id on this page.', array( 'status' => 404 ) );
	}

	$siblings = &artivio_ea_siblings_ref( $tree, $path );
	array_splice( $siblings, $path[ count( $path ) - 1 ], 1 );
	unset( $siblings );

	artivio_ea_put_tree( $post_id, $tree );
	return array(
		'id'      => (string) $r['el'],
		'deleted' => true,
	);
}

function artivio_ea_add_element( WP_REST_Request $r ) {
	$post_id = (int) $r['id'];
	$guard   = artivio_ea_guard_post( $post_id );
	if ( is_wp_error( $guard ) ) {
		return $guard;
	}
	$element = $r->get_param( 'element' );
	if ( ! is_array( $element ) || empty( $element['elType'] ) ) {
		return new WP_Error( 'artivio_ea_bad_element', '`element` must be an Elementor element object with at least an `elType`.', array( 'status' => 400 ) );
	}
	$parent_id = $r->get_param( 'parentId' ) ? (string) $r->get_param( 'parentId' ) : '';
	$index     = ( null === $r->get_param( 'index' ) ) ? -1 : (int) $r->get_param( 'index' );

	$tree  = artivio_ea_get_tree( $post_id );
	$taken = array();
	artivio_ea_collect_ids( $tree, $taken );
	$element = artivio_ea_reid( $element, $taken );

	$parent_path = array();
	if ( '' !== $parent_id ) {
		$parent_path = artivio_ea_path( $tree, $parent_id );
		if ( null === $parent_path ) {
			return new WP_Error( 'artivio_ea_no_parent', 'No element with that parentId on this page.', array( 'status' => 404 ) );
		}
	}

	$children = &artivio_ea_children_ref( $tree, $parent_path );
	if ( $index < 0 || $index > count( $children ) ) {
		$children[] = $element;
		$at         = count( $children ) - 1;
	} else {
		array_splice( $children, $index, 0, array( $element ) );
		$at = $index;
	}
	unset( $children );

	artivio_ea_put_tree( $post_id, $tree );
	return array(
		'id'       => $element['id'],
		'added'    => true,
		'parentId' => $parent_id ?: null,
		'index'    => $at,
	);
}

function artivio_ea_move_element( WP_REST_Request $r ) {
	$post_id = (int) $r['id'];
	$guard   = artivio_ea_guard_post( $post_id );
	if ( is_wp_error( $guard ) ) {
		return $guard;
	}
	$el_id     = (string) $r['el'];
	$parent_id = $r->get_param( 'parentId' ) ? (string) $r->get_param( 'parentId' ) : '';
	$index     = ( null === $r->get_param( 'index' ) ) ? -1 : (int) $r->get_param( 'index' );

	$tree = artivio_ea_get_tree( $post_id );
	$path = artivio_ea_path( $tree, $el_id );
	if ( null === $path ) {
		return new WP_Error( 'artivio_ea_no_element', 'No element with that id on this page.', array( 'status' => 404 ) );
	}
	$moving = artivio_ea_element_at( $tree, $path );

	// Reject cycles BEFORE detaching anything. Moving an element into its own
	// descendant would otherwise strand the whole subtree, and the failure only
	// shows up later as a page that lost a section for no visible reason.
	$inside = array();
	artivio_ea_collect_ids( array( $moving ), $inside );
	if ( '' !== $parent_id && isset( $inside[ $parent_id ] ) ) {
		return new WP_Error( 'artivio_ea_bad_move', 'An element cannot be moved inside itself or its own children.', array( 'status' => 400 ) );
	}

	$parent_path = array();
	if ( '' !== $parent_id ) {
		$parent_path = artivio_ea_path( $tree, $parent_id );
		if ( null === $parent_path ) {
			return new WP_Error( 'artivio_ea_no_parent', 'No element with that parentId on this page — nothing was moved.', array( 'status' => 404 ) );
		}
	}

	// Detach, then re-resolve the destination: removing the element can shift
	// the destination's own index if they share an ancestor.
	$siblings = &artivio_ea_siblings_ref( $tree, $path );
	array_splice( $siblings, $path[ count( $path ) - 1 ], 1 );
	unset( $siblings );

	if ( '' !== $parent_id ) {
		$parent_path = artivio_ea_path( $tree, $parent_id );
		if ( null === $parent_path ) {
			// Cannot happen (the cycle check above rules it out), but restoring
			// beats leaving the caller with a silently deleted element.
			$restore = &artivio_ea_children_ref( $tree, array() );
			$restore[] = $moving;
			unset( $restore );
			artivio_ea_put_tree( $post_id, $tree );
			return new WP_Error( 'artivio_ea_no_parent', 'The destination disappeared during the move; the element was reattached at the end of the page.', array( 'status' => 409 ) );
		}
	}

	$children = &artivio_ea_children_ref( $tree, $parent_path );
	if ( $index < 0 || $index > count( $children ) ) {
		$children[] = $moving;
		$at         = count( $children ) - 1;
	} else {
		array_splice( $children, $index, 0, array( $moving ) );
		$at = $index;
	}
	unset( $children );

	artivio_ea_put_tree( $post_id, $tree );
	return array(
		'id'       => $el_id,
		'moved'    => true,
		'parentId' => $parent_id ?: null,
		'index'    => $at,
	);
}

function artivio_ea_duplicate_element( WP_REST_Request $r ) {
	$post_id = (int) $r['id'];
	$guard   = artivio_ea_guard_post( $post_id );
	if ( is_wp_error( $guard ) ) {
		return $guard;
	}
	$tree = artivio_ea_get_tree( $post_id );
	$path = artivio_ea_path( $tree, (string) $r['el'] );
	if ( null === $path ) {
		return new WP_Error( 'artivio_ea_no_element', 'No element with that id on this page.', array( 'status' => 404 ) );
	}
	$taken = array();
	artivio_ea_collect_ids( $tree, $taken );
	$copy = artivio_ea_reid( artivio_ea_element_at( $tree, $path ), $taken );

	$siblings = &artivio_ea_siblings_ref( $tree, $path );
	array_splice( $siblings, $path[ count( $path ) - 1 ] + 1, 0, array( $copy ) );
	unset( $siblings );

	artivio_ea_put_tree( $post_id, $tree );
	return array(
		'sourceId'   => (string) $r['el'],
		'id'         => $copy['id'],
		'duplicated' => true,
	);
}

/**
 * Every widget registered on THIS site, right now — core, Pro and any
 * third-party addon. Read at runtime on purpose: a hand-maintained list of
 * widget names goes stale the first time someone installs an addon, and the
 * agent then invents widget types that silently render as nothing.
 */
function artivio_ea_list_widgets() {
	if ( ! artivio_ea_elementor_active() ) {
		return new WP_Error( 'artivio_ea_no_elementor', 'Elementor is not active on this site.', array( 'status' => 409 ) );
	}
	$types = \Elementor\Plugin::$instance->widgets_manager->get_widget_types();
	$out   = array();
	foreach ( (array) $types as $name => $widget ) {
		$out[] = array(
			'name'       => $name,
			'title'      => method_exists( $widget, 'get_title' ) ? $widget->get_title() : $name,
			'categories' => method_exists( $widget, 'get_categories' ) ? $widget->get_categories() : array(),
		);
	}
	usort(
		$out,
		function ( $a, $b ) {
			return strcmp( $a['name'], $b['name'] );
		}
	);
	return array(
		'count'   => count( $out ),
		'widgets' => $out,
	);
}

function artivio_ea_widget_schema( WP_REST_Request $r ) {
	if ( ! artivio_ea_elementor_active() ) {
		return new WP_Error( 'artivio_ea_no_elementor', 'Elementor is not active on this site.', array( 'status' => 409 ) );
	}
	$name   = (string) $r['name'];
	$widget = \Elementor\Plugin::$instance->widgets_manager->get_widget_types( $name );
	if ( ! $widget ) {
		return new WP_Error( 'artivio_ea_no_widget', 'No widget registered under that name on this site. Call /widgets for the real list.', array( 'status' => 404 ) );
	}

	$controls = method_exists( $widget, 'get_controls' ) ? (array) $widget->get_controls() : array();
	$section  = null;
	$out      = array();
	$skip     = array( 'tab', 'divider', 'raw_html', 'heading', 'deprecated_notice', 'notice', 'alert' );

	foreach ( $controls as $key => $c ) {
		if ( ! is_array( $c ) ) {
			continue;
		}
		$type = isset( $c['type'] ) ? (string) $c['type'] : '';
		if ( 'section' === $type ) {
			$section = isset( $c['label'] ) ? wp_strip_all_tags( (string) $c['label'] ) : $key;
			continue;
		}
		if ( in_array( $type, $skip, true ) ) {
			continue;
		}
		$row = array(
			'key'     => $key,
			'type'    => $type,
			'label'   => isset( $c['label'] ) ? wp_strip_all_tags( (string) $c['label'] ) : null,
			'section' => $section,
		);
		if ( array_key_exists( 'default', $c ) ) {
			$row['default'] = $c['default'];
		}
		if ( ! empty( $c['options'] ) && is_array( $c['options'] ) ) {
			// The KEYS are what goes into `settings`; the labels are for humans.
			$row['options'] = array_slice( array_keys( $c['options'] ), 0, 60 );
		}
		if ( ! empty( $c['condition'] ) ) {
			$row['showWhen'] = $c['condition'];
		}
		if ( ! empty( $c['responsive'] ) ) {
			$row['responsive'] = true;
		}
		$out[] = $row;
	}

	return array(
		'widget'       => $name,
		'title'        => method_exists( $widget, 'get_title' ) ? $widget->get_title() : $name,
		'controlCount' => count( $out ),
		'controls'     => $out,
		'note'         => 'These `key` values go in an element\'s `settings`. Responsive controls also accept _tablet and _mobile suffixes, e.g. "align_tablet".',
	);
}

function artivio_ea_list_templates( WP_REST_Request $r ) {
	$q = new WP_Query(
		array(
			'post_type'      => 'elementor_library',
			'post_status'    => array( 'publish', 'draft', 'private' ),
			'posts_per_page' => min( 100, max( 1, (int) ( $r->get_param( 'per_page' ) ?: 50 ) ) ),
			'orderby'        => 'modified',
			'order'          => 'DESC',
			'no_found_rows'  => true,
		)
	);
	$rows = array();
	foreach ( $q->posts as $p ) {
		$rows[] = array(
			'id'           => $p->ID,
			'title'        => get_the_title( $p ),
			'templateType' => get_post_meta( $p->ID, '_elementor_template_type', true ) ?: null,
			'status'       => $p->post_status,
			'modified'     => $p->post_modified_gmt,
		);
	}
	wp_reset_postdata();
	return array( 'templates' => $rows );
}

function artivio_ea_apply_template( WP_REST_Request $r ) {
	$post_id = (int) $r['id'];
	$guard   = artivio_ea_guard_post( $post_id );
	if ( is_wp_error( $guard ) ) {
		return $guard;
	}
	$template_id = (int) $r->get_param( 'templateId' );
	$mode        = in_array( $r->get_param( 'mode' ), array( 'append', 'prepend', 'replace' ), true )
		? (string) $r->get_param( 'mode' )
		: 'append';

	if ( ! get_post( $template_id ) ) {
		return new WP_Error( 'artivio_ea_no_template', 'No template with that id.', array( 'status' => 404 ) );
	}
	$source = artivio_ea_get_tree( $template_id );
	if ( ! $source ) {
		return new WP_Error( 'artivio_ea_empty_template', 'That template has no Elementor content.', array( 'status' => 409 ) );
	}

	$tree  = artivio_ea_get_tree( $post_id );
	$taken = array();
	artivio_ea_collect_ids( $tree, $taken );
	// Fresh ids on every copied element. Reusing the template's ids would give
	// the page duplicate ids, and every id-addressed route after that becomes
	// ambiguous — it would edit whichever copy it happened to find first.
	$copied = array();
	foreach ( $source as $el ) {
		if ( is_array( $el ) ) {
			$copied[] = artivio_ea_reid( $el, $taken );
		}
	}

	if ( 'replace' === $mode ) {
		$tree = $copied;
	} elseif ( 'prepend' === $mode ) {
		$tree = array_merge( $copied, $tree );
	} else {
		$tree = array_merge( $tree, $copied );
	}

	artivio_ea_put_tree( $post_id, $tree );
	return array(
		'id'       => $post_id,
		'applied'  => $template_id,
		'mode'     => $mode,
		'added'    => count( $copied ),
		'topLevel' => count( $tree ),
	);
}

function artivio_ea_kit_id(): int {
	return (int) get_option( 'elementor_active_kit' );
}

function artivio_ea_get_kit() {
	$kit_id = artivio_ea_kit_id();
	if ( ! $kit_id ) {
		return new WP_Error( 'artivio_ea_no_kit', 'This site has no active Elementor kit.', array( 'status' => 409 ) );
	}
	$settings = get_post_meta( $kit_id, '_elementor_page_settings', true );
	$settings = is_array( $settings ) ? $settings : array();
	return array(
		'kitId'            => $kit_id,
		'systemColors'     => $settings['system_colors'] ?? array(),
		'customColors'     => $settings['custom_colors'] ?? array(),
		'systemTypography' => $settings['system_typography'] ?? array(),
		'customTypography' => $settings['custom_typography'] ?? array(),
		'containerWidth'   => $settings['container_width'] ?? null,
		'raw'              => $settings,
	);
}

function artivio_ea_patch_kit( WP_REST_Request $r ) {
	$kit_id = artivio_ea_kit_id();
	if ( ! $kit_id ) {
		return new WP_Error( 'artivio_ea_no_kit', 'This site has no active Elementor kit.', array( 'status' => 409 ) );
	}
	if ( ! current_user_can( 'edit_post', $kit_id ) ) {
		return new WP_Error( 'artivio_ea_forbidden', 'This user cannot edit the global kit.', array( 'status' => 403 ) );
	}
	$patch = $r->get_param( 'settings' );
	if ( ! is_array( $patch ) ) {
		return new WP_Error( 'artivio_ea_bad_settings', '`settings` must be an object, e.g. { "system_colors": [ { "_id": "primary", "title": "Primary", "color": "#123456" } ] }.', array( 'status' => 400 ) );
	}

	$current = get_post_meta( $kit_id, '_elementor_page_settings', true );
	$current = is_array( $current ) ? $current : array();
	$merged  = array_replace( $current, $patch );

	update_post_meta( $kit_id, '_elementor_page_settings', wp_slash( $merged ) );
	// The kit drives global CSS for the WHOLE site, so flushing the kit post
	// alone is not enough — every cached page still holds the old palette.
	// artivio_ea_flush_css() already calls files_manager->clear_cache(), which
	// is site-wide.
	artivio_ea_flush_css( $kit_id );

	return array(
		'kitId'       => $kit_id,
		'updated'     => true,
		'changedKeys' => array_keys( $patch ),
	);
}
