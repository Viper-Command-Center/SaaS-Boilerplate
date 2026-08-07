<?php
/**
 * Plugin Name:  Artivio WP Agent (base)
 * Plugin URI:   https://artivio.io
 * Description:  Builder-agnostic base plugin for Artivio. Repairs WordPress Application Passwords on CGI/FastCGI hosts, exposes a self-diagnosing auth check, reports what a site actually runs, and reads/writes SEO fields for Rank Math or Yoast. Install on every client WordPress site regardless of page builder.
 * Version:      1.0.0
 * Requires PHP: 7.4
 * Author:       Artivio
 * License:      GPL-2.0-or-later
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS SEPARATELY
 *
 * All of this was written inside artivio-elementor-agent, where it did not
 * belong. None of it is about Elementor:
 *
 *   · the Application Password repair is about PHP running as CGI/FastCGI
 *   · /authcheck answers "did my credential authenticate, and if not why"
 *   · Rank Math and Yoast store SEO in postmeta no matter what draws the page
 *
 * Leaving it there meant a Divi site — or a plain WordPress site, or a Bricks
 * site — would hit the exact silent auth failure that cost an afternoon on the
 * first Elementor install, with no diagnostic available, because the only copy
 * lived in a plugin nobody would install on a site with no Elementor.
 *
 * Install this on EVERY client site. Builder-specific plugins sit alongside it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * COEXISTENCE
 *
 * artivio-elementor-agent 1.1.0+ carries its own copy of the auth shim. If both
 * are active, whichever loads first does the repair and the other must not
 * report a misleading result — see artivio_wp_bootstrap_basic_auth().
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'ARTIVIO_WP_VERSION', '1.0.0' );
define( 'ARTIVIO_WP_NS', 'artivio/v1' );

/* ══════════════════════════════════════════════════════════════════════════
 * Application Password repair
 *
 * WordPress authenticates Application Passwords in
 * wp_authenticate_application_password(), which reads ONLY
 * $_SERVER['PHP_AUTH_USER'] and $_SERVER['PHP_AUTH_PW']. Apache with mod_php
 * fills those in. **PHP as CGI/FastCGI — LiteSpeed, PHP-FPM, most managed
 * hosts — does not.**
 *
 * The .htaccess line WordPress ships,
 *   RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]
 * only copies the header into an environment variable. Core never reads it
 * back, so the credential reaches the server, sits in $_SERVER, and is ignored.
 *
 * The failure is silent and badly misleading: the request is processed as
 * ANONYMOUS. Public reads keep working, so an integration looks healthy, while
 * anything needing auth returns "You are not currently logged in." That reads
 * like a wrong password and is not one.
 *
 * 🔒 THIS GRANTS NOTHING. It re-exposes to PHP a header the client already
 * sent, in the form PHP would have provided natively. WordPress still validates
 * the credential and a wrong one still fails. Only when PHP_AUTH_USER is
 * absent, and only for `Basic`.
 * ══════════════════════════════════════════════════════════════════════════ */

if ( ! function_exists( 'artivio_wp_bootstrap_basic_auth' ) ) {
	function artivio_wp_bootstrap_basic_auth(): void {
		/**
		 * Four states, because two collapse the cases that need opposite
		 * responses: "PHP handled it natively" and "no Authorization header
		 * arrived at all" are not the same event, and calling both `native`
		 * sends whoever is debugging to the wrong layer.
		 */
		$GLOBALS['artivio_auth_source'] = 'absent';

		/**
		 * If artivio-elementor-agent already ran ITS shim this request, adopt
		 * that verdict verbatim. Re-deriving it here would see the PHP_AUTH_USER
		 * the other plugin just set and report `native` — turning a correct
		 * "this server needed repair" into a confident lie, on the one field
		 * whose entire job is telling the truth about that.
		 */
		if ( isset( $GLOBALS['artivio_ea_auth_source'] ) ) {
			$GLOBALS['artivio_auth_source'] = (string) $GLOBALS['artivio_ea_auth_source'];
			return;
		}

		if ( ! empty( $_SERVER['PHP_AUTH_USER'] ) ) {
			$GLOBALS['artivio_auth_source'] = 'native';
			return;
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
			$GLOBALS['artivio_auth_source'] = 'unusable';
			return;
		}

		$decoded = base64_decode( substr( $header, 6 ), true ); // phpcs:ignore
		if ( false === $decoded || false === strpos( $decoded, ':' ) ) {
			$GLOBALS['artivio_auth_source'] = 'unusable';
			return;
		}

		// Split at the FIRST colon: application passwords contain spaces but
		// never a colon, and a WordPress username cannot contain one either.
		list( $user, $pass ) = explode( ':', $decoded, 2 );
		if ( '' === $user ) {
			$GLOBALS['artivio_auth_source'] = 'unusable';
			return;
		}

		$_SERVER['PHP_AUTH_USER']       = $user;
		$_SERVER['PHP_AUTH_PW']         = $pass;
		$GLOBALS['artivio_auth_source'] = 'shim';
	}
}

// File scope: WordPress resolves the current user lazily, after plugins load,
// so this is early enough for core REST auth and for every plugin's routes.
artivio_wp_bootstrap_basic_auth();

/* ══════════════════════════════════════════════════════════════════════════
 * Helpers
 * ══════════════════════════════════════════════════════════════════════════ */

function artivio_wp_auth_source(): string {
	return isset( $GLOBALS['artivio_auth_source'] ) ? (string) $GLOBALS['artivio_auth_source'] : 'absent';
}

function artivio_wp_can_edit(): bool {
	return current_user_can( 'edit_posts' );
}

function artivio_wp_guard_post( int $post_id ) {
	if ( ! get_post( $post_id ) ) {
		return new WP_Error( 'artivio_wp_not_found', 'No post with that id.', array( 'status' => 404 ) );
	}
	if ( ! current_user_can( 'edit_post', $post_id ) ) {
		return new WP_Error( 'artivio_wp_forbidden', 'This user cannot edit that post.', array( 'status' => 403 ) );
	}
	return true;
}

/* ══════════════════════════════════════════════════════════════════════════
 * SEO (Rank Math / Yoast)
 *
 * Builder-agnostic by nature — both store their fields in postmeta, and core
 * WP REST does not reliably expose those keys. The API here is deliberately
 * plugin-NEUTRAL: callers send `title`, `description`, `focusKeyword`… and this
 * maps them onto whichever plugin the site runs. An agent should not have to
 * know that Rank Math spells it `rank_math_description` and Yoast spells it
 * `_yoast_wpseo_metadesc`; that is exactly the per-site detail it gets wrong.
 * ══════════════════════════════════════════════════════════════════════════ */

function artivio_wp_seo_plugin(): string {
	if ( defined( 'RANK_MATH_VERSION' ) || class_exists( 'RankMath' ) ) {
		return 'rankmath';
	}
	if ( defined( 'WPSEO_VERSION' ) || class_exists( 'WPSEO_Options' ) ) {
		return 'yoast';
	}
	return 'none';
}

function artivio_wp_seo_map( string $which ): array {
	if ( 'rankmath' === $which ) {
		return array(
			'title'              => 'rank_math_title',
			'description'        => 'rank_math_description',
			'focusKeyword'       => 'rank_math_focus_keyword',
			'canonical'          => 'rank_math_canonical_url',
			'breadcrumbTitle'    => 'rank_math_breadcrumb_title',
			'ogTitle'            => 'rank_math_facebook_title',
			'ogDescription'      => 'rank_math_facebook_description',
			'ogImage'            => 'rank_math_facebook_image',
			'twitterTitle'       => 'rank_math_twitter_title',
			'twitterDescription' => 'rank_math_twitter_description',
			'twitterImage'       => 'rank_math_twitter_image',
		);
	}
	if ( 'yoast' === $which ) {
		return array(
			'title'              => '_yoast_wpseo_title',
			'description'        => '_yoast_wpseo_metadesc',
			'focusKeyword'       => '_yoast_wpseo_focuskw',
			'canonical'          => '_yoast_wpseo_canonical',
			'breadcrumbTitle'    => '_yoast_wpseo_bctitle',
			'ogTitle'            => '_yoast_wpseo_opengraph-title',
			'ogDescription'      => '_yoast_wpseo_opengraph-description',
			'ogImage'            => '_yoast_wpseo_opengraph-image',
			'twitterTitle'       => '_yoast_wpseo_twitter-title',
			'twitterDescription' => '_yoast_wpseo_twitter-description',
			'twitterImage'       => '_yoast_wpseo_twitter-image',
		);
	}
	return array();
}

function artivio_wp_seo_url_fields(): array {
	return array( 'canonical', 'ogImage', 'twitterImage' );
}

/** Google truncates around here. We REPORT rather than truncate: silently
 *  cutting a client's meta description is worse than a long one. */
function artivio_wp_seo_limits(): array {
	return array(
		'title'       => 60,
		'description' => 155,
	);
}

function artivio_wp_seo_read( int $post_id, string $which ): array {
	$out = array();
	foreach ( artivio_wp_seo_map( $which ) as $field => $key ) {
		$out[ $field ] = get_post_meta( $post_id, $key, true );
	}
	if ( 'rankmath' === $which ) {
		$robots          = get_post_meta( $post_id, 'rank_math_robots', true );
		$robots          = is_array( $robots ) ? $robots : array();
		$out['noindex']  = in_array( 'noindex', $robots, true );
		$out['nofollow'] = in_array( 'nofollow', $robots, true );
	} elseif ( 'yoast' === $which ) {
		$out['noindex']  = '1' === (string) get_post_meta( $post_id, '_yoast_wpseo_meta-robots-noindex', true );
		$out['nofollow'] = '1' === (string) get_post_meta( $post_id, '_yoast_wpseo_meta-robots-nofollow', true );
	}
	return $out;
}

function artivio_wp_get_seo( WP_REST_Request $r ) {
	$post_id = (int) $r['id'];
	$guard   = artivio_wp_guard_post( $post_id );
	if ( is_wp_error( $guard ) ) {
		return $guard;
	}
	$which = artivio_wp_seo_plugin();
	if ( 'none' === $which ) {
		return new WP_Error( 'artivio_wp_no_seo_plugin', 'No supported SEO plugin is active. This route supports Rank Math and Yoast.', array( 'status' => 409 ) );
	}
	$values = artivio_wp_seo_read( $post_id, $which );
	return array(
		'id'        => $post_id,
		'seoPlugin' => $which,
		'fields'    => $values,
		'lengths'   => array(
			'title'       => mb_strlen( (string) ( $values['title'] ?? '' ) ),
			'description' => mb_strlen( (string) ( $values['description'] ?? '' ) ),
		),
		'limits'    => artivio_wp_seo_limits(),
		'postTitle' => get_the_title( $post_id ),
		'link'      => get_permalink( $post_id ),
		'note'      => 'An EMPTY title or description does not mean nothing is output — it means the SEO plugin falls back to its own template. Setting a value overrides that template for this page only.',
	);
}

function artivio_wp_patch_seo( WP_REST_Request $r ) {
	$post_id = (int) $r['id'];
	$guard   = artivio_wp_guard_post( $post_id );
	if ( is_wp_error( $guard ) ) {
		return $guard;
	}
	$which = artivio_wp_seo_plugin();
	if ( 'none' === $which ) {
		return new WP_Error( 'artivio_wp_no_seo_plugin', 'No supported SEO plugin is active. This route supports Rank Math and Yoast.', array( 'status' => 409 ) );
	}

	$map     = artivio_wp_seo_map( $which );
	$urls    = artivio_wp_seo_url_fields();
	$limits  = artivio_wp_seo_limits();
	$changed = array();
	$cleared = array();
	$warn    = array();
	$unknown = array();

	$params = $r->get_params();
	foreach ( $params as $field => $value ) {
		if ( in_array( $field, array( 'id', 'noindex', 'nofollow' ), true ) ) {
			continue;
		}
		if ( ! isset( $map[ $field ] ) ) {
			// Silently ignoring an unrecognised field is how a caller ends up
			// believing it set something it did not.
			$unknown[] = $field;
			continue;
		}
		$key = $map[ $field ];

		if ( null === $value || '' === $value ) {
			delete_post_meta( $post_id, $key );
			$cleared[] = $field;
			continue;
		}

		$clean = in_array( $field, $urls, true )
			? esc_url_raw( (string) $value )
			: sanitize_text_field( (string) $value );

		if ( isset( $limits[ $field ] ) && mb_strlen( $clean ) > $limits[ $field ] ) {
			$warn[] = sprintf(
				'%s is %d characters; Google typically truncates beyond about %d. Saved as supplied.',
				$field,
				mb_strlen( $clean ),
				$limits[ $field ]
			);
		}

		update_post_meta( $post_id, $key, wp_slash( $clean ) );
		$changed[] = $field;
	}

	if ( array_key_exists( 'noindex', $params ) || array_key_exists( 'nofollow', $params ) ) {
		$current  = artivio_wp_seo_read( $post_id, $which );
		$noindex  = array_key_exists( 'noindex', $params )
			? filter_var( $params['noindex'], FILTER_VALIDATE_BOOLEAN )
			: (bool) ( $current['noindex'] ?? false );
		$nofollow = array_key_exists( 'nofollow', $params )
			? filter_var( $params['nofollow'], FILTER_VALIDATE_BOOLEAN )
			: (bool) ( $current['nofollow'] ?? false );

		if ( 'rankmath' === $which ) {
			$robots = array( $noindex ? 'noindex' : 'index', $nofollow ? 'nofollow' : 'follow' );
			update_post_meta( $post_id, 'rank_math_robots', wp_slash( $robots ) );
		} else {
			// Yoast: '1' = noindex, '2' = index.
			update_post_meta( $post_id, '_yoast_wpseo_meta-robots-noindex', $noindex ? '1' : '2' );
			update_post_meta( $post_id, '_yoast_wpseo_meta-robots-nofollow', $nofollow ? '1' : '0' );
		}
		$changed[] = 'robots';
	}

	clean_post_cache( $post_id );

	return array(
		'id'            => $post_id,
		'seoPlugin'     => $which,
		'changed'       => $changed,
		'cleared'       => $cleared,
		'ignoredFields' => $unknown,
		'warnings'      => $warn,
		'fields'        => artivio_wp_seo_read( $post_id, $which ),
		'link'          => get_permalink( $post_id ),
	);
}

/* ══════════════════════════════════════════════════════════════════════════
 * Routes
 * ══════════════════════════════════════════════════════════════════════════ */

add_action( 'rest_api_init', 'artivio_wp_register_routes' );

function artivio_wp_register_routes() {
	/**
	 * The only UNAUTHENTICATED route, and it exists because every other route
	 * requires auth — so when auth is what's broken, none of them can say why.
	 * They can only 401, which looks identical whether the password was wrong or
	 * the header never arrived. Those need opposite fixes: one is a two-second
	 * change in a settings panel, the other is a hosting ticket.
	 *
	 * 🔒 Discloses nothing to an anonymous caller: no username, no roles, no
	 * site detail beyond the plugin version. Identity is returned ONLY when the
	 * request authenticated — and a caller that authenticated already holds the
	 * credential. It never echoes the credential back in any form.
	 */
	register_rest_route(
		ARTIVIO_WP_NS,
		'/authcheck',
		array(
			'methods'             => 'GET',
			'permission_callback' => '__return_true',
			'callback'            => 'artivio_wp_authcheck',
		)
	);

	register_rest_route(
		ARTIVIO_WP_NS,
		'/site',
		array(
			'methods'             => 'GET',
			'permission_callback' => 'artivio_wp_can_edit',
			'callback'            => 'artivio_wp_site',
		)
	);

	register_rest_route(
		ARTIVIO_WP_NS,
		'/documents/(?P<id>\d+)/seo',
		array(
			array(
				'methods'             => 'GET',
				'permission_callback' => 'artivio_wp_can_edit',
				'callback'            => 'artivio_wp_get_seo',
			),
			array(
				'methods'             => 'PATCH',
				'permission_callback' => 'artivio_wp_can_edit',
				'callback'            => 'artivio_wp_patch_seo',
			),
		)
	);
}

function artivio_wp_authcheck() {
	$source = artivio_wp_auth_source();
	$user   = wp_get_current_user();
	$authed = ( $user instanceof WP_User ) && $user->ID > 0;

	$supplied = isset( $_SERVER['PHP_AUTH_USER'] ) ? (string) $_SERVER['PHP_AUTH_USER'] : '';
	$secret   = isset( $_SERVER['PHP_AUTH_PW'] ) ? (string) $_SERVER['PHP_AUTH_PW'] : '';

	$ssl       = is_ssl();
	$forwarded = isset( $_SERVER['HTTP_X_FORWARDED_PROTO'] ) ? (string) $_SERVER['HTTP_X_FORWARDED_PROTO'] : '';
	$available = function_exists( 'wp_is_application_passwords_available' )
		? (bool) wp_is_application_passwords_available()
		: null;
	$in_use = class_exists( 'WP_Application_Passwords' ) && method_exists( 'WP_Application_Passwords', 'is_in_use' )
		? (bool) WP_Application_Passwords::is_in_use()
		: null;

	/**
	 * Ask WordPress itself rather than guessing. Re-running the
	 * application-password authenticator returns core's OWN error code, which
	 * names the actual cause — wrong username, wrong password, disabled for the
	 * site, disabled for that user. It is the same evaluation WordPress already
	 * performed for this request, so it grants nothing and reveals nothing a
	 * caller holding the credential could not learn by retrying.
	 */
	$core_reason = '';
	if ( ! $authed && '' !== $supplied && '' !== $secret && function_exists( 'wp_authenticate_application_password' ) ) {
		$attempt = wp_authenticate_application_password( null, $supplied, $secret );
		if ( is_wp_error( $attempt ) ) {
			$core_reason = $attempt->get_error_code() . ': ' . wp_strip_all_tags( (string) $attempt->get_error_message() );
		} elseif ( $attempt instanceof WP_User ) {
			$core_reason = 'unexpected — the credential VALIDATES when re-tested, so something else in the request rejected it (a security plugin, or a filter on determine_current_user).';
		} else {
			$core_reason = 'WordPress declined to evaluate the application password at all: neither a user nor an error, which means application passwords are unavailable here (see isSsl / appPasswordsAvailable) or a filter disabled them.';
		}
	}

	if ( $authed ) {
		$verdict = 'The credential AUTHENTICATED. If a tool still fails, the problem is that route or that user\'s capabilities, not the credential.';
	} elseif ( 'absent' === $source ) {
		$verdict = 'NO Authorization header reached PHP. The credential was never seen by WordPress, so this is not a wrong password and changing it will not help. Something between the client and PHP removed it — a proxy or CDN, or a server running PHP as CGI/FastCGI. This plugin repairs the CGI/FastCGI case automatically, so seeing "absent" means the header did not arrive at all: add "CGIPassAuth On" to .htaccess (Apache 2.4.13+ / LiteSpeed), or ask the host to forward the Authorization header.';
	} elseif ( 'unusable' === $source ) {
		$verdict = 'An Authorization header arrived but was not a decodable HTTP Basic credential. Artivio sends Basic, so something in front of this site is rewriting the header.';
	} elseif ( false === $available ) {
		$verdict = sprintf(
			'Application Passwords are UNAVAILABLE on this site, so WordPress refused to evaluate the credential at all — no password will work until this is fixed. WordPress gates them on HTTPS: is_ssl() reports %s%s. If the site is served over HTTPS but is_ssl() is false, a reverse proxy or CDN is terminating TLS and PHP cannot see it; the standard fix is to set $_SERVER[\'HTTPS\'] = \'on\' in wp-config.php when HTTP_X_FORWARDED_PROTO is https. A security plugin filtering wp_is_application_passwords_available does the same thing.',
			$ssl ? 'true' : 'false',
			'' !== $forwarded ? sprintf( ' while X-Forwarded-Proto is "%s"', $forwarded ) : ''
		);
	} elseif ( '' !== $core_reason ) {
		$verdict = sprintf(
			'A Basic credential reached WordPress and WordPress rejected it. Core\'s own reason: %s — for the username "%s" that was sent.',
			$core_reason,
			$supplied
		);
		/**
		 * The commonest mismatch of all, and WordPress's own UI causes it: the
		 * "New Application Password Name" field is a LABEL, shown in the Name
		 * column of that table. It looks like a username and is not one. People
		 * type that label as the username, get `invalid_username`, reasonably
		 * conclude the password is wrong, generate another, name it the same
		 * thing, and repeat.
		 */
		if ( 0 === strpos( $core_reason, 'invalid_username' ) ) {
			$verdict .= ' ⚠ Common cause: in WordPress, "New Application Password Name" is only a LABEL for the credential — it is NOT a username. The username is the account\'s login, shown in the Username column of Users → All Users, or that account\'s email address.';
		}
	} else {
		$verdict = sprintf(
			'A Basic credential reached WordPress for username "%s" and was rejected, but core reported no specific reason. Check the username matches the account the Application Password belongs to, and that it has not been revoked.',
			$supplied
		);
	}

	return array(
		'plugin'                => 'artivio-wp-agent',
		'pluginVersion'         => ARTIVIO_WP_VERSION,
		'authSource'            => $source,
		'authenticated'         => $authed,
		// Echoing back the username the CALLER sent is not disclosure — they
		// sent it — and it is the fastest way to catch the commonest fault:
		// the wrong username stored at the other end. The password is never
		// echoed in any form.
		'receivedUsername'      => '' !== $supplied ? $supplied : null,
		'isSsl'                 => $ssl,
		'forwardedProto'        => '' !== $forwarded ? $forwarded : null,
		'appPasswordsAvailable' => $available,
		'appPasswordsInUse'     => $in_use,
		'coreAuthError'         => '' !== $core_reason ? $core_reason : null,
		'user'                  => $authed ? $user->user_login : null,
		'roles'                 => $authed ? array_values( (array) $user->roles ) : array(),
		'canEditPosts'          => $authed ? current_user_can( 'edit_posts' ) : false,
		'verdict'               => $verdict,
	);
}

/**
 * What is this site, actually?
 *
 * Onboarding a new client used to mean guessing which builder and which SEO
 * plugin were in play, and guessing wrong is expensive: editing an Elementor
 * page through the plain WordPress tools succeeds and changes nothing. One call
 * answers it. Builder detection reads each plugin's own version constant, and
 * the REST namespace list shows which agent plugins are actually installed —
 * both read at runtime, so a site that changes tells the truth next call.
 */
function artivio_wp_site() {
	$user  = wp_get_current_user();
	$theme = wp_get_theme();

	$namespaces = array();
	if ( function_exists( 'rest_get_server' ) ) {
		$server = rest_get_server();
		if ( $server && method_exists( $server, 'get_namespaces' ) ) {
			$namespaces = array_values( (array) $server->get_namespaces() );
		}
	}

	$builders = array();
	if ( defined( 'ELEMENTOR_VERSION' ) ) {
		$builders['elementor'] = ELEMENTOR_VERSION;
	}
	if ( defined( 'ELEMENTOR_PRO_VERSION' ) ) {
		$builders['elementorPro'] = ELEMENTOR_PRO_VERSION;
	}
	if ( defined( 'ET_BUILDER_VERSION' ) ) {
		$builders['divi'] = ET_BUILDER_VERSION;
	}
	if ( defined( 'ET_CORE_VERSION' ) ) {
		$builders['diviCore'] = ET_CORE_VERSION;
	}
	if ( defined( 'BRICKS_VERSION' ) ) {
		$builders['bricks'] = BRICKS_VERSION;
	}
	if ( defined( 'FL_BUILDER_VERSION' ) ) {
		$builders['beaverBuilder'] = FL_BUILDER_VERSION;
	}

	return array(
		'plugin'        => 'artivio-wp-agent',
		'pluginVersion' => ARTIVIO_WP_VERSION,
		'wp'            => get_bloginfo( 'version' ),
		'php'           => PHP_VERSION,
		'siteUrl'       => get_site_url(),
		'isSsl'         => is_ssl(),
		'authSource'    => artivio_wp_auth_source(),
		'theme'         => array(
			'name'     => $theme ? $theme->get( 'Name' ) : null,
			'version'  => $theme ? $theme->get( 'Version' ) : null,
			'template' => $theme ? $theme->get_template() : null,
		),
		'builders'      => $builders,
		'seoPlugin'     => artivio_wp_seo_plugin(),
		// Which agent plugins are reachable. artivio-elementor/v1 means the
		// Elementor agent is active; diviops/v1 means the DiviOps agent is.
		'restNamespaces' => array_slice( $namespaces, 0, 40 ),
		'user'          => $user ? $user->user_login : null,
		'roles'         => $user ? array_values( (array) $user->roles ) : array(),
		'note'          => 'Use `builders` to decide which connection edits layouts on this site. A page built with a builder cannot be edited through post_content — that write succeeds and changes nothing visible.',
	);
}

/**
 * Explain a 401/403 on OUR routes, in the response body.
 *
 * A rejected request never reaches a handler, so /site cannot report the one
 * case that most needs reporting: an Authorization header that never arrived.
 * WordPress renders that as `rest_forbidden` — indistinguishable from a wrong
 * password, which is exactly the confusion this plugin exists to end.
 */
function artivio_wp_annotate_auth_failure( $response, $server, $request ) {
	unset( $server );
	if ( ! ( $response instanceof WP_REST_Response ) || ! ( $request instanceof WP_REST_Request ) ) {
		return $response;
	}
	if ( 0 !== strpos( ltrim( (string) $request->get_route(), '/' ), 'artivio/' ) ) {
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

	$source = artivio_wp_auth_source();
	$hints  = array(
		'absent'   => 'PHP received NO Authorization header for this request. The credential was never seen, so this is not a wrong password. Something upstream removed it — a proxy, CDN, or a server passing PHP as CGI/FastCGI. Add "CGIPassAuth On" to .htaccess (Apache 2.4.13+ / LiteSpeed), or ask the host to forward the Authorization header.',
		'unusable' => 'An Authorization header arrived but was not a decodable HTTP Basic credential. Something in front of this site is rewriting it.',
		'native'   => 'The credential reached WordPress and WordPress rejected it. Wrong or revoked username/Application Password, or the user lacks edit_posts. Call /artivio/v1/authcheck for core\'s own reason.',
		'shim'     => 'The credential reached WordPress and WordPress rejected it. Wrong or revoked username/Application Password, or the user lacks edit_posts. Call /artivio/v1/authcheck for core\'s own reason.',
	);

	$data['artivioDiagnostic'] = array(
		'authSource' => $source,
		'hint'       => isset( $hints[ $source ] ) ? $hints[ $source ] : $hints['absent'],
	);
	$response->set_data( $data );
	return $response;
}
add_filter( 'rest_post_dispatch', 'artivio_wp_annotate_auth_failure', 10, 3 );
