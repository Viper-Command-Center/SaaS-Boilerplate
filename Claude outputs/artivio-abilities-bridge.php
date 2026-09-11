<?php
/**
 * Plugin Name:  Artivio Abilities Bridge
 * Plugin URI:   https://artivio.io
 * Description:  Registers WordPress Abilities API abilities for the plugins on the Gutenberg/Kadence build line that don't ship their own agent abilities — SEOPress content fields, Contact Form 7 form creation, The Events Calendar one-off events, and a LiteSpeed cache purge — so the WordPress MCP Adapter (or any other Abilities-API consumer) can expose them to Noah. Deliberately does NOT register ACF abilities (ACF ≥ 6.8 ships its own via the Abilities API — a second registration under a different plugin would just create two competing sources of truth). This plugin only REGISTERS abilities; it does not speak MCP itself and does nothing without the MCP Adapter (or equivalent) active.
 * Version:      1.0.0
 * Requires PHP: 7.4
 * Requires at least: 6.9
 * Author:       Artivio
 * License:      GPL-2.0-or-later
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THESE FOUR AND NOT MORE
 *
 * Kadence block content and AIOS are deliberately absent:
 *   · Kadence content already round-trips through core `wp/v2/posts`
 *     (`content.raw`/`content.rendered`) — wrapping that in a bespoke ability
 *     would duplicate a path that already works and give Noah a second,
 *     slightly different way to do the same write.
 *   · AIOS is security config. Nothing here exposes it — see the connector
 *     playbook's standing rule that table-prefix and similar security
 *     settings are human-only, in-person actions.
 *
 * SEOPress's noindex/nofollow fields are also deliberately absent — see the
 * comment on artivio_ab_seo_set_execute() below.
 *
 * WHY THIS REUSES artivio-wp-agent FOR SEO INSTEAD OF DUPLICATING IT
 *
 * artivio-wp-agent (base) already owns the Rank Math / Yoast / SEOPress field
 * map and the character-limit warnings behind its REST route
 * (/artivio/v1/documents/{id}/seo). Re-implementing that mapping here would
 * give the two plugins their own copies to drift out of sync. Instead, when
 * artivio-wp-agent is active, these abilities call its functions directly
 * (they're plain global functions, not a class) and return exactly what that
 * REST route returns. Install artivio-wp-agent alongside this plugin — the
 * SEO abilities return a 424 explaining that if it's missing.
 * ─────────────────────────────────────────────────────────────────────────────
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'ARTIVIO_AB_VERSION', '1.0.0' );
define( 'ARTIVIO_AB_NS', 'artivio-abilities/v1' );

add_action( 'wp_abilities_api_init', 'artivio_ab_register_abilities' );

/**
 * If this fires on a WordPress older than 6.9 (no Abilities API) or before
 * the API has loaded for any other reason, wp_register_ability() will not
 * exist. Rather than fatal, the whole registration step is skipped — this
 * plugin becomes inert instead of breaking the site.
 */
function artivio_ab_register_abilities() {
	if ( ! function_exists( 'wp_register_ability' ) ) {
		return;
	}
	artivio_ab_register_seo_abilities();
	artivio_ab_register_cf7_abilities();
	artivio_ab_register_events_abilities();
	artivio_ab_register_cache_abilities();
}

/* ══════════════════════════════════════════════════════════════════════════
 * Shared helpers
 * ══════════════════════════════════════════════════════════════════════════ */

function artivio_ab_can_edit_post_input( $input ): bool {
	$post_id = (int) ( is_array( $input ) ? ( $input['postId'] ?? 0 ) : 0 );
	return $post_id > 0 && current_user_can( 'edit_post', $post_id );
}

function artivio_ab_can_edit_posts(): bool {
	return current_user_can( 'edit_posts' );
}

function artivio_ab_valid_mysql_datetime( string $value ): bool {
	$d = DateTime::createFromFormat( 'Y-m-d H:i:s', $value );
	return $d instanceof DateTime && $d->format( 'Y-m-d H:i:s' ) === $value;
}

/* ══════════════════════════════════════════════════════════════════════════
 * SEO — thin wrapper over artivio-wp-agent's Rank Math / Yoast / SEOPress map
 * ══════════════════════════════════════════════════════════════════════════ */

function artivio_ab_register_seo_abilities() {
	wp_register_ability(
		'artivio/seo-get',
		array(
			'label'               => 'Get SEO fields for a post',
			'description'         => 'Reads title, description, focus keyword and related fields for a post/page from whichever supported SEO plugin the site runs (Rank Math, Yoast, or SEOPress). Requires artivio-wp-agent (base) to also be active.',
			'category'            => 'content',
			'input_schema'        => array(
				'type'                 => 'object',
				'properties'           => array(
					'postId' => array(
						'type'        => 'integer',
						'description' => 'Post or page ID.',
					),
				),
				'required'             => array( 'postId' ),
				'additionalProperties' => false,
			),
			'output_schema'       => array(
				'type'       => 'object',
				'properties' => array(
					'seoPlugin' => array( 'type' => 'string' ),
					'fields'    => array( 'type' => 'object' ),
				),
			),
			'execute_callback'    => 'artivio_ab_seo_get_execute',
			'permission_callback' => 'artivio_ab_can_edit_post_input',
		)
	);

	wp_register_ability(
		'artivio/seo-set',
		array(
			'label'               => 'Set SEO fields for a post',
			'description'         => 'Writes title, description, focus keyword and related fields for a post/page to whichever supported SEO plugin the site runs. On SEOPress sites, noindex/nofollow are refused rather than written (unconfirmed value semantics — see plugin source comments) — everything else writes normally. Requires artivio-wp-agent (base) to also be active.',
			'category'            => 'content',
			'input_schema'        => array(
				'type'                 => 'object',
				'properties'           => array(
					'postId'       => array( 'type' => 'integer' ),
					'title'        => array( 'type' => 'string' ),
					'description'  => array( 'type' => 'string' ),
					'focusKeyword' => array( 'type' => 'string' ),
					'canonical'    => array( 'type' => 'string' ),
					'noindex'      => array( 'type' => 'boolean' ),
					'nofollow'     => array( 'type' => 'boolean' ),
				),
				'required'             => array( 'postId' ),
				'additionalProperties' => false,
			),
			'output_schema'       => array(
				'type'       => 'object',
				'properties' => array(
					'seoPlugin' => array( 'type' => 'string' ),
					'changed'   => array(
						'type'  => 'array',
						'items' => array( 'type' => 'string' ),
					),
					'warnings'  => array(
						'type'  => 'array',
						'items' => array( 'type' => 'string' ),
					),
				),
			),
			'execute_callback'    => 'artivio_ab_seo_set_execute',
			'permission_callback' => 'artivio_ab_can_edit_post_input',
		)
	);
}

function artivio_ab_seo_get_execute( $input ) {
	if ( ! function_exists( 'artivio_wp_seo_plugin' ) || ! function_exists( 'artivio_wp_guard_post' ) ) {
		return new WP_Error(
			'artivio_ab_missing_base',
			'Artivio WP Agent (base) is not active. Install it alongside this plugin — it owns the SEO field map these abilities reuse.',
			array( 'status' => 424 )
		);
	}
	$post_id = (int) ( $input['postId'] ?? 0 );
	$guard   = artivio_wp_guard_post( $post_id );
	if ( is_wp_error( $guard ) ) {
		return $guard;
	}
	$which = artivio_wp_seo_plugin();
	if ( 'none' === $which ) {
		return artivio_wp_seo_none_error();
	}
	return array(
		'seoPlugin' => $which,
		'fields'    => artivio_wp_seo_read( $post_id, $which ),
	);
}

/**
 * Reuses artivio_wp_patch_seo() from artivio-wp-agent by constructing the
 * WP_REST_Request it expects — this is the same validated write path the
 * REST route uses (sanitisation, char-limit warnings, the SEOPress
 * noindex/nofollow refusal, unknown-field reporting), not a second
 * implementation of it.
 */
function artivio_ab_seo_set_execute( $input ) {
	if ( ! function_exists( 'artivio_wp_patch_seo' ) ) {
		return new WP_Error(
			'artivio_ab_missing_base',
			'Artivio WP Agent (base) is not active. Install it alongside this plugin — it owns the SEO write path these abilities reuse.',
			array( 'status' => 424 )
		);
	}
	$post_id = (int) ( $input['postId'] ?? 0 );
	$request = new WP_REST_Request( 'PATCH' );
	$request->set_param( 'id', $post_id );
	foreach ( $input as $key => $value ) {
		if ( 'postId' === $key ) {
			continue;
		}
		$request->set_param( $key, $value );
	}
	return artivio_wp_patch_seo( $request );
}

/* ══════════════════════════════════════════════════════════════════════════
 * Contact Form 7 — form creation
 *
 * CF7 has no REST API and no WP-CLI commands (confirmed 2026-09-11). The only
 * safe programmatic path is CF7's own WPCF7_ContactForm class — the same one
 * its "Add New" admin screen uses (WPCF7_ContactForm::get_template() to build
 * a form pre-filled with CF7's defaults, set_properties()/set_title() to
 * override them, save() to persist). Never write wpcf7_contact_form postmeta
 * directly — the _form/_mail/_mail_2/_messages/_additional_settings shape
 * is undocumented and not a stable contract to hand-construct.
 * ══════════════════════════════════════════════════════════════════════════ */

function artivio_ab_register_cf7_abilities() {
	wp_register_ability(
		'artivio/cf7-create-form',
		array(
			'label'               => 'Create a Contact Form 7 form',
			'description'         => 'Creates a new Contact Form 7 form from field-tag markup and mail settings, via WPCF7_ContactForm (the same class CF7\'s own "Add New" screen uses) — not raw postmeta.',
			'category'            => 'content',
			'input_schema'        => array(
				'type'                 => 'object',
				'properties'           => array(
					'title'           => array(
						'type'        => 'string',
						'description' => 'Form title, shown in wp-admin only — not on the front end.',
					),
					'formTemplate'    => array(
						'type'        => 'string',
						'description' => 'CF7 form-tag markup, e.g. "<label>Name [text* your-name]</label>\n<label>Email [email* your-email]</label>\n[submit \"Send\"]".',
					),
					'mailTo'          => array(
						'type'        => 'string',
						'description' => 'Recipient email address for the notification mail.',
					),
					'mailSubject'     => array( 'type' => 'string' ),
					'thankYouMessage' => array(
						'type'        => 'string',
						'description' => 'Shown on successful submission. Omit to keep CF7\'s default.',
					),
				),
				'required'             => array( 'title', 'formTemplate', 'mailTo' ),
				'additionalProperties' => false,
			),
			'output_schema'       => array(
				'type'       => 'object',
				'properties' => array(
					'formId'    => array( 'type' => 'integer' ),
					'shortcode' => array(
						'type'        => 'string',
						'description' => 'Paste this into a Kadence block or any post_content to embed the form.',
					),
				),
			),
			'execute_callback'    => 'artivio_ab_cf7_create_execute',
			'permission_callback' => 'artivio_ab_can_edit_posts',
		)
	);
}

function artivio_ab_cf7_create_execute( $input ) {
	if ( ! class_exists( 'WPCF7_ContactForm' ) ) {
		return new WP_Error( 'artivio_ab_no_cf7', 'Contact Form 7 is not active.', array( 'status' => 424 ) );
	}

	$title    = sanitize_text_field( (string) ( $input['title'] ?? '' ) );
	$template = (string) ( $input['formTemplate'] ?? '' );
	$mail_to  = sanitize_email( (string) ( $input['mailTo'] ?? '' ) );

	if ( '' === $title || '' === trim( $template ) || ! is_email( $mail_to ) ) {
		return new WP_Error(
			'artivio_ab_cf7_bad_input',
			'title, formTemplate, and a valid mailTo are all required.',
			array( 'status' => 400 )
		);
	}

	// get_template() returns a new form pre-filled with CF7's own defaults
	// (default messages, a sane mail_2 skeleton, etc.) with the title already
	// set — starting from that instead of an empty object means every field
	// this ability doesn't touch still has a sensible value.
	$form = WPCF7_ContactForm::get_template( array( 'title' => $title ) );
	if ( ! ( $form instanceof WPCF7_ContactForm ) ) {
		return new WP_Error( 'artivio_ab_cf7_template_failed', 'WPCF7_ContactForm::get_template() did not return a form.', array( 'status' => 500 ) );
	}

	$properties                        = $form->get_properties();
	$properties['form']                = $template;
	$properties['mail']['subject']     = sanitize_text_field( (string) ( $input['mailSubject'] ?? ( $title . ' — new submission' ) ) );
	$properties['mail']['recipient']   = $mail_to;
	$properties['mail']['sender']      = '[_site_title] <wordpress@' . (string) wp_parse_url( home_url(), PHP_URL_HOST ) . '>';
	$properties['mail']['additional_headers'] = 'Reply-To: [your-email]';
	if ( ! empty( $input['thankYouMessage'] ) ) {
		$properties['messages']['mail_sent_ok'] = sanitize_text_field( (string) $input['thankYouMessage'] );
	}

	$form->set_properties( $properties );
	$form->set_title( $title );
	$form_id = $form->save();

	if ( ! $form_id ) {
		return new WP_Error( 'artivio_ab_cf7_save_failed', 'WPCF7_ContactForm::save() did not return an ID.', array( 'status' => 500 ) );
	}

	return array(
		'formId'    => (int) $form_id,
		'shortcode' => '[contact-form-7 id="' . (int) $form_id . '" title="' . esc_attr( $title ) . '"]',
	);
}

/* ══════════════════════════════════════════════════════════════════════════
 * The Events Calendar — one-off events only
 *
 * Uses TEC's own tribe_create_event() (confirmed 2026-09-11 against TEC's
 * tech docs) rather than hand-writing _EventStartDate/_EventEndDate/
 * _EventAllDay postmeta directly — it validates and normalises dates the way
 * TEC's own admin screen does. Venue/Organizer linkage still goes through
 * the (previously confirmed) _EventVenueID/_EventOrganizerID meta keys
 * afterward, since tribe_create_event()'s own Venue/Organizer array
 * shape was not independently confirmed here.
 *
 * Recurrence is refused, not attempted: it isn't in the input schema at all
 * (additionalProperties: false rejects it outright), matching the standing
 * playbook rule that Events Calendar Pro's _EventRecurrence rule format is
 * not safe to hand-construct — set a recurring pattern up once via wp-admin.
 * ══════════════════════════════════════════════════════════════════════════ */

function artivio_ab_register_events_abilities() {
	wp_register_ability(
		'artivio/event-create',
		array(
			'label'               => 'Create a one-off Events Calendar event',
			'description'         => 'Creates a single, non-recurring Event in The Events Calendar. Recurring events are not supported by this ability — set up a recurring pattern once via wp-admin instead.',
			'category'            => 'content',
			'input_schema'        => array(
				'type'                 => 'object',
				'properties'           => array(
					'title'         => array( 'type' => 'string' ),
					'description'   => array( 'type' => 'string' ),
					'startDateTime' => array(
						'type'        => 'string',
						'description' => 'MySQL datetime, e.g. "2026-10-04 10:00:00".',
					),
					'endDateTime'   => array(
						'type'        => 'string',
						'description' => 'MySQL datetime, same format as startDateTime.',
					),
					'allDay'        => array( 'type' => 'boolean' ),
					'venueId'       => array(
						'type'        => 'integer',
						'description' => 'ID of an existing tribe_venue post.',
					),
					'organizerId'   => array(
						'type'        => 'integer',
						'description' => 'ID of an existing tribe_organizer post.',
					),
					'status'        => array(
						'type' => 'string',
						'enum' => array( 'publish', 'draft' ),
					),
				),
				'required'             => array( 'title', 'startDateTime', 'endDateTime' ),
				'additionalProperties' => false,
			),
			'output_schema'       => array(
				'type'       => 'object',
				'properties' => array(
					'eventId' => array( 'type' => 'integer' ),
					'link'    => array( 'type' => 'string' ),
					'note'    => array( 'type' => 'string' ),
				),
			),
			'execute_callback'    => 'artivio_ab_event_create_execute',
			'permission_callback' => 'artivio_ab_can_edit_posts',
		)
	);
}

function artivio_ab_event_create_execute( $input ) {
	if ( ! function_exists( 'tribe_create_event' ) ) {
		return new WP_Error( 'artivio_ab_no_events_calendar', 'The Events Calendar is not active.', array( 'status' => 424 ) );
	}

	$title = sanitize_text_field( (string) ( $input['title'] ?? '' ) );
	$start = (string) ( $input['startDateTime'] ?? '' );
	$end   = (string) ( $input['endDateTime'] ?? '' );

	if ( '' === $title || ! artivio_ab_valid_mysql_datetime( $start ) || ! artivio_ab_valid_mysql_datetime( $end ) ) {
		return new WP_Error(
			'artivio_ab_event_bad_input',
			'title, startDateTime and endDateTime ("Y-m-d H:i:s") are all required, and the dates must be valid.',
			array( 'status' => 400 )
		);
	}

	$event_id = tribe_create_event(
		array(
			'post_title'     => $title,
			'post_content'   => wp_kses_post( (string) ( $input['description'] ?? '' ) ),
			'post_status'    => ( isset( $input['status'] ) && 'draft' === $input['status'] ) ? 'draft' : 'publish',
			'EventStartDate' => $start,
			'EventEndDate'   => $end,
			'EventAllDay'    => ! empty( $input['allDay'] ),
		)
	);

	if ( ! $event_id ) {
		return new WP_Error( 'artivio_ab_event_create_failed', 'tribe_create_event() returned false.', array( 'status' => 500 ) );
	}

	if ( ! empty( $input['venueId'] ) ) {
		update_post_meta( $event_id, '_EventVenueID', (int) $input['venueId'] );
	}
	if ( ! empty( $input['organizerId'] ) ) {
		update_post_meta( $event_id, '_EventOrganizerID', (int) $input['organizerId'] );
	}

	return array(
		'eventId' => (int) $event_id,
		'link'    => (string) get_permalink( $event_id ),
		'note'    => 'Verify it appears via GET /wp-json/tribe/events/v1/events/' . (int) $event_id . ' before relying on it in a calendar view — the post existing does not guarantee the calendar query picked it up immediately.',
	);
}

/* ══════════════════════════════════════════════════════════════════════════
 * LiteSpeed Cache — purge after a bulk write
 *
 * Detection uses has_action() on LiteSpeed's own purge hooks rather than a
 * guessed version constant/class name — it stays correct across LiteSpeed
 * Cache versions without needing to track their internals, and do_action()
 * on a hook nobody listens to is already a harmless no-op.
 * ══════════════════════════════════════════════════════════════════════════ */

function artivio_ab_register_cache_abilities() {
	wp_register_ability(
		'artivio/cache-purge',
		array(
			'label'               => 'Purge LiteSpeed cache',
			'description'         => 'Purges the LiteSpeed page cache for one post (default) or the whole site, after a bulk content write. Returns litespeedActive: false harmlessly if LiteSpeed Cache is not active — nothing else in this ability requires it.',
			'category'            => 'infrastructure',
			'input_schema'        => array(
				'type'                 => 'object',
				'properties'           => array(
					'postId'   => array(
						'type'        => 'integer',
						'description' => 'Purge just this post\'s cached pages. Omit and set purgeAll instead to purge the whole site.',
					),
					'purgeAll' => array( 'type' => 'boolean' ),
				),
				'additionalProperties' => false,
			),
			'output_schema'       => array(
				'type'       => 'object',
				'properties' => array(
					'purged'          => array( 'type' => 'string' ),
					'litespeedActive' => array( 'type' => 'boolean' ),
				),
			),
			'execute_callback'    => 'artivio_ab_cache_purge_execute',
			'permission_callback' => 'artivio_ab_can_edit_posts',
		)
	);
}

function artivio_ab_cache_purge_execute( $input ) {
	$active = has_action( 'litespeed_purge_all' ) || has_action( 'litespeed_purge_post' );
	if ( ! $active ) {
		return array(
			'purged'          => 'none — no LiteSpeed purge hook is registered (LiteSpeed Cache is not active on this site).',
			'litespeedActive' => false,
		);
	}

	if ( ! empty( $input['purgeAll'] ) ) {
		do_action( 'litespeed_purge_all', 'artivio-abilities-bridge' );
		return array( 'purged' => 'all', 'litespeedActive' => true );
	}

	$post_id = (int) ( $input['postId'] ?? 0 );
	if ( $post_id > 0 ) {
		if ( ! get_post( $post_id ) ) {
			return new WP_Error( 'artivio_ab_not_found', 'No post with that id.', array( 'status' => 404 ) );
		}
		do_action( 'litespeed_purge_post', $post_id );
		return array( 'purged' => 'post ' . $post_id, 'litespeedActive' => true );
	}

	return new WP_Error( 'artivio_ab_cache_bad_input', 'Provide postId, or purgeAll: true.', array( 'status' => 400 ) );
}

/* ══════════════════════════════════════════════════════════════════════════
 * Status route — which of the four ability groups are actually usable here,
 * checked the same way discovery.ts's health check reads a site: from the
 * outside, at request time, not assumed from what's supposed to be installed.
 * ══════════════════════════════════════════════════════════════════════════ */

add_action( 'rest_api_init', 'artivio_ab_register_routes' );

function artivio_ab_register_routes() {
	register_rest_route(
		ARTIVIO_AB_NS,
		'/status',
		array(
			'methods'             => 'GET',
			'permission_callback' => 'artivio_ab_can_edit_posts',
			'callback'            => 'artivio_ab_status',
		)
	);
}

function artivio_ab_status() {
	return array(
		'plugin'            => 'artivio-abilities-bridge',
		'pluginVersion'     => ARTIVIO_AB_VERSION,
		'abilitiesApiReady' => function_exists( 'wp_register_ability' ),
		'groups'            => array(
			'seo'    => array(
				'abilities'       => array( 'artivio/seo-get', 'artivio/seo-set' ),
				'baseAgentActive' => function_exists( 'artivio_wp_seo_plugin' ),
				'seoPlugin'       => function_exists( 'artivio_wp_seo_plugin' ) ? artivio_wp_seo_plugin() : 'unknown — artivio-wp-agent not active',
			),
			'cf7'    => array(
				'abilities' => array( 'artivio/cf7-create-form' ),
				'active'    => class_exists( 'WPCF7_ContactForm' ),
			),
			'events' => array(
				'abilities' => array( 'artivio/event-create' ),
				'active'    => function_exists( 'tribe_create_event' ),
			),
			'cache'  => array(
				'abilities' => array( 'artivio/cache-purge' ),
				'active'    => has_action( 'litespeed_purge_all' ) || has_action( 'litespeed_purge_post' ),
			),
		),
		'note'              => 'A group with active/baseAgentActive: false means its ability is registered but will return a 424 when called — that plugin is not active on this site.',
	);
}
