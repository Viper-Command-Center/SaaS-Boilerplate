<?php
/**
 * Plugin Name:  Artivio Website Assistant
 * Plugin URI:   https://artivio.ai
 * Description:  A chat panel inside wp-admin where the site owner asks for changes in plain words and the Artivio AI employee makes them on this site. Pairs with Artivio → Tools → WordPress Sites → Site chat.
 * Version:      1.0.3
 * Author:       Artivio
 * Author URI:   https://artivio.ai
 * License:      GPL-2.0-or-later
 * Text Domain:  artivio-site-chat
 * Requires at least: 6.5
 * Requires PHP: 7.4
 *
 * How it works
 * ────────────
 * The site never talks to an AI model itself. The browser talks to THIS plugin
 * (WordPress REST, nonce + capability), and the plugin forwards to Artivio with
 * the site's chat token (Authorization: Bearer asc_…). Artivio runs its agent
 * pinned to this one site and answers asynchronously; the panel polls for the
 * transcript. The token never reaches the browser; the user's identity
 * (id, display name, role) is asserted by WordPress, not typed by anyone.
 *
 * Capability: `artivio_site_chat`. Granted to administrator + editor on
 * activation; give it to any role with your role manager (Adminify, Members…).
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'ARTIVIO_SITE_CHAT_VERSION', '1.0.3' );
define( 'ARTIVIO_SITE_CHAT_FILE', __FILE__ );
define( 'ARTIVIO_SITE_CHAT_CAP', 'artivio_site_chat' );
define( 'ARTIVIO_SITE_CHAT_OPTION', 'artivio_site_chat' );

final class Artivio_Site_Chat {

	/** @var Artivio_Site_Chat|null */
	private static $instance = null;

	public static function instance(): Artivio_Site_Chat {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	private function __construct() {
		register_activation_hook( ARTIVIO_SITE_CHAT_FILE, array( $this, 'activate' ) );
		add_action( 'admin_menu', array( $this, 'admin_menu' ), 5 );
		add_action( 'admin_init', array( $this, 'register_settings' ) );
		add_action( 'admin_enqueue_scripts', array( $this, 'enqueue' ) );
		add_action( 'rest_api_init', array( $this, 'rest_routes' ) );
		add_action( 'wp_dashboard_setup', array( $this, 'dashboard_widget' ) );
		add_action( 'admin_bar_menu', array( $this, 'admin_bar' ), 90 );
		add_action( 'load-index.php', array( $this, 'maybe_redirect_dashboard' ) );
		add_filter( 'plugin_action_links_' . plugin_basename( ARTIVIO_SITE_CHAT_FILE ), array( $this, 'action_links' ) );
	}

	// ─── Options ────────────────────────────────────────────────────────────

	public static function defaults(): array {
		return array(
			'artivio_url'       => 'https://artivio.ai',
			'token'             => '',
			'menu_label'        => 'Website Assistant',
			'assistant_first'   => 0, // send non-admins straight to the assistant instead of the WP dashboard
			'show_widget'       => 1,
			'welcome'           => "Hi! Tell me what you'd like changed on your website — a new event, a service time, a typo, a new page. I'll do it and show you where to look.",
			'suggestions'       => "Update this Sunday's service time\nAdd an upcoming event\nFix a typo on the About page\nChange the homepage photo",
		);
	}

	public static function options(): array {
		$saved = get_option( ARTIVIO_SITE_CHAT_OPTION, array() );
		return array_merge( self::defaults(), is_array( $saved ) ? $saved : array() );
	}

	public function activate(): void {
		foreach ( array( 'administrator', 'editor' ) as $role_name ) {
			$role = get_role( $role_name );
			if ( $role ) {
				$role->add_cap( ARTIVIO_SITE_CHAT_CAP );
			}
		}
		if ( ! get_option( ARTIVIO_SITE_CHAT_OPTION ) ) {
			add_option( ARTIVIO_SITE_CHAT_OPTION, self::defaults(), '', false );
		}
	}

	public function action_links( array $links ): array {
		array_unshift( $links, '<a href="' . esc_url( admin_url( 'admin.php?page=artivio-site-chat-settings' ) ) . '">' . esc_html__( 'Settings', 'artivio-site-chat' ) . '</a>' );
		return $links;
	}

	private function connected(): bool {
		$o = self::options();
		return '' !== trim( (string) $o['token'] ) && '' !== trim( (string) $o['artivio_url'] );
	}

	// ─── Admin UI ───────────────────────────────────────────────────────────

	public function admin_menu(): void {
		$o = self::options();
		add_menu_page(
			$o['menu_label'],
			$o['menu_label'],
			ARTIVIO_SITE_CHAT_CAP,
			'artivio-site-chat',
			array( $this, 'render_chat_page' ),
			'dashicons-format-chat',
			2
		);
		add_submenu_page(
			'artivio-site-chat',
			__( 'Assistant settings', 'artivio-site-chat' ),
			__( 'Settings', 'artivio-site-chat' ),
			'manage_options',
			'artivio-site-chat-settings',
			array( $this, 'render_settings_page' )
		);
	}

	public function admin_bar( $bar ): void {
		if ( ! current_user_can( ARTIVIO_SITE_CHAT_CAP ) ) {
			return;
		}
		$o = self::options();
		$bar->add_node(
			array(
				'id'    => 'artivio-site-chat',
				'title' => '<span class="ab-icon dashicons dashicons-format-chat" style="top:2px"></span>' . esc_html( $o['menu_label'] ),
				'href'  => admin_url( 'admin.php?page=artivio-site-chat' ),
			)
		);
	}

	/** Assistant-first mode: a non-admin landing on the WP dashboard goes to the chat. */
	public function maybe_redirect_dashboard(): void {
		$o = self::options();
		if ( empty( $o['assistant_first'] ) || current_user_can( 'manage_options' ) || ! current_user_can( ARTIVIO_SITE_CHAT_CAP ) ) {
			return;
		}
		wp_safe_redirect( admin_url( 'admin.php?page=artivio-site-chat' ) );
		exit;
	}

	public function dashboard_widget(): void {
		$o = self::options();
		if ( empty( $o['show_widget'] ) || ! current_user_can( ARTIVIO_SITE_CHAT_CAP ) ) {
			return;
		}
		wp_add_dashboard_widget(
			'artivio_site_chat_widget',
			esc_html( $o['menu_label'] ),
			function () use ( $o ) {
				echo '<p>' . esc_html( $o['welcome'] ) . '</p>';
				echo '<p><a class="button button-primary" href="' . esc_url( admin_url( 'admin.php?page=artivio-site-chat' ) ) . '">' . esc_html__( 'Open the assistant', 'artivio-site-chat' ) . '</a></p>';
			}
		);
	}

	public function enqueue( string $hook ): void {
		if ( 'toplevel_page_artivio-site-chat' !== $hook ) {
			return;
		}
		$base = plugin_dir_url( ARTIVIO_SITE_CHAT_FILE );
		wp_enqueue_style( 'artivio-site-chat', $base . 'assets/chat.css', array(), ARTIVIO_SITE_CHAT_VERSION );
		wp_enqueue_script( 'artivio-site-chat', $base . 'assets/chat.js', array( 'wp-api-fetch' ), ARTIVIO_SITE_CHAT_VERSION, true );
		$user = wp_get_current_user();
		$o    = self::options();
		wp_localize_script(
			'artivio-site-chat',
			'ArtivioSiteChat',
			array(
				'restBase'    => esc_url_raw( rest_url( 'artivio-chat/v1' ) ),
				'nonce'       => wp_create_nonce( 'wp_rest' ),
				'connected'   => $this->connected(),
				'userName'    => $user->display_name,
				'welcome'     => $o['welcome'],
				'suggestions' => array_values( array_filter( array_map( 'trim', explode( "\n", (string) $o['suggestions'] ) ) ) ),
				'siteUrl'     => home_url( '/' ),
				'settingsUrl' => current_user_can( 'manage_options' ) ? admin_url( 'admin.php?page=artivio-site-chat-settings' ) : '',
			)
		);
	}

	public function render_chat_page(): void {
		if ( ! current_user_can( ARTIVIO_SITE_CHAT_CAP ) ) {
			wp_die( esc_html__( 'You do not have access to the assistant.', 'artivio-site-chat' ) );
		}
		echo '<div class="wrap artivio-chat-wrap"><div id="artivio-site-chat" class="artivio-chat" data-loading="1">';
		if ( ! $this->connected() ) {
			echo '<div class="notice notice-warning inline"><p>' . esc_html__( 'The assistant is not connected yet.', 'artivio-site-chat' );
			if ( current_user_can( 'manage_options' ) ) {
				echo ' <a href="' . esc_url( admin_url( 'admin.php?page=artivio-site-chat-settings' ) ) . '">' . esc_html__( 'Paste the site token from Artivio.', 'artivio-site-chat' ) . '</a>';
			}
			echo '</p></div>';
		}
		echo '</div></div>';
	}

	// ─── Settings ───────────────────────────────────────────────────────────

	public function register_settings(): void {
		register_setting(
			'artivio_site_chat',
			ARTIVIO_SITE_CHAT_OPTION,
			array(
				'type'              => 'array',
				'sanitize_callback' => array( $this, 'sanitize_options' ),
			)
		);
	}

	public function sanitize_options( $input ): array {
		$current = self::options();
		$input   = is_array( $input ) ? $input : array();
		$out     = $current;

		$out['artivio_url'] = untrailingslashit( esc_url_raw( trim( (string) ( $input['artivio_url'] ?? $current['artivio_url'] ) ) ) );
		// Blank token field = keep the stored one (the field never echoes the value).
		$token = trim( (string) ( $input['token'] ?? '' ) );
		if ( '' !== $token ) {
			$out['token'] = preg_replace( '/[^A-Za-z0-9_\-]/', '', $token );
		}
		if ( ! empty( $input['clear_token'] ) ) {
			$out['token'] = '';
		}
		$out['menu_label']      = sanitize_text_field( (string) ( $input['menu_label'] ?? $current['menu_label'] ) ) ?: 'Website Assistant';
		$out['assistant_first'] = empty( $input['assistant_first'] ) ? 0 : 1;
		$out['show_widget']     = empty( $input['show_widget'] ) ? 0 : 1;
		$out['welcome']         = sanitize_textarea_field( (string) ( $input['welcome'] ?? $current['welcome'] ) );
		$out['suggestions']     = sanitize_textarea_field( (string) ( $input['suggestions'] ?? $current['suggestions'] ) );
		return $out;
	}

	public function render_settings_page(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'Insufficient permissions.', 'artivio-site-chat' ) );
		}
		$o      = self::options();
		$status = $this->connected() ? $this->probe() : null;
		?>
		<div class="wrap">
			<h1><?php esc_html_e( 'Website Assistant — settings', 'artivio-site-chat' ); ?></h1>
			<?php if ( null !== $status ) : ?>
				<?php if ( ! empty( $status['ok'] ) ) : ?>
					<div class="notice notice-success inline"><p>
						<?php
						printf(
							/* translators: 1: assistant name 2: provider 3: site label */
							esc_html__( 'Connected. Assistant: %1$s (by %2$s). Artivio knows this site as "%3$s". Layout editing: %4$s.', 'artivio-site-chat' ),
							esc_html( $status['agent'] ),
							esc_html( $status['provider'] ),
							esc_html( $status['label'] ),
							$status['layout'] ? esc_html__( 'yes', 'artivio-site-chat' ) : esc_html__( 'content only', 'artivio-site-chat' )
						);
						?>
					</p></div>
				<?php else : ?>
					<div class="notice notice-error inline"><p><?php echo esc_html( $status['error'] ); ?></p></div>
				<?php endif; ?>
			<?php endif; ?>
			<form method="post" action="options.php">
				<?php settings_fields( 'artivio_site_chat' ); ?>
				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><label for="asc-url"><?php esc_html_e( 'Artivio URL', 'artivio-site-chat' ); ?></label></th>
						<td><input id="asc-url" name="<?php echo esc_attr( ARTIVIO_SITE_CHAT_OPTION ); ?>[artivio_url]" type="url" class="regular-text" value="<?php echo esc_attr( $o['artivio_url'] ); ?>"></td>
					</tr>
					<tr>
						<th scope="row"><label for="asc-token"><?php esc_html_e( 'Site token', 'artivio-site-chat' ); ?></label></th>
						<td>
							<input id="asc-token" name="<?php echo esc_attr( ARTIVIO_SITE_CHAT_OPTION ); ?>[token]" type="password" class="regular-text" autocomplete="off" placeholder="<?php echo $o['token'] ? esc_attr__( '•••••••• (stored — paste a new one to replace)', 'artivio-site-chat' ) : 'asc_…'; ?>">
							<p class="description"><?php esc_html_e( 'From Artivio → Tools → WordPress Sites → this site → Site chat → "Enable + issue token". Shown once there; stored here; never sent to the browser.', 'artivio-site-chat' ); ?></p>
							<?php if ( $o['token'] ) : ?>
								<label><input type="checkbox" name="<?php echo esc_attr( ARTIVIO_SITE_CHAT_OPTION ); ?>[clear_token]" value="1"> <?php esc_html_e( 'Remove the stored token', 'artivio-site-chat' ); ?></label>
							<?php endif; ?>
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="asc-label"><?php esc_html_e( 'Menu label', 'artivio-site-chat' ); ?></label></th>
						<td><input id="asc-label" name="<?php echo esc_attr( ARTIVIO_SITE_CHAT_OPTION ); ?>[menu_label]" type="text" class="regular-text" value="<?php echo esc_attr( $o['menu_label'] ); ?>"></td>
					</tr>
					<tr>
						<th scope="row"><?php esc_html_e( 'Behaviour', 'artivio-site-chat' ); ?></th>
						<td>
							<label><input type="checkbox" name="<?php echo esc_attr( ARTIVIO_SITE_CHAT_OPTION ); ?>[assistant_first]" value="1" <?php checked( $o['assistant_first'] ); ?>> <?php esc_html_e( 'Assistant-first: users who are not administrators land on the assistant instead of the WordPress dashboard', 'artivio-site-chat' ); ?></label><br>
							<label><input type="checkbox" name="<?php echo esc_attr( ARTIVIO_SITE_CHAT_OPTION ); ?>[show_widget]" value="1" <?php checked( $o['show_widget'] ); ?>> <?php esc_html_e( 'Show a dashboard widget with a shortcut', 'artivio-site-chat' ); ?></label>
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="asc-welcome"><?php esc_html_e( 'Welcome message', 'artivio-site-chat' ); ?></label></th>
						<td><textarea id="asc-welcome" name="<?php echo esc_attr( ARTIVIO_SITE_CHAT_OPTION ); ?>[welcome]" class="large-text" rows="3"><?php echo esc_textarea( $o['welcome'] ); ?></textarea></td>
					</tr>
					<tr>
						<th scope="row"><label for="asc-sugg"><?php esc_html_e( 'Suggestion chips (one per line)', 'artivio-site-chat' ); ?></label></th>
						<td><textarea id="asc-sugg" name="<?php echo esc_attr( ARTIVIO_SITE_CHAT_OPTION ); ?>[suggestions]" class="large-text" rows="4"><?php echo esc_textarea( $o['suggestions'] ); ?></textarea></td>
					</tr>
				</table>
				<?php submit_button(); ?>
			</form>
			<h2><?php esc_html_e( 'Who can use it', 'artivio-site-chat' ); ?></h2>
			<p><?php esc_html_e( 'Any user with the "artivio_site_chat" capability (administrators and editors by default). Grant or remove it per role with your role manager (Adminify → Role Manager, Members, User Role Editor).', 'artivio-site-chat' ); ?></p>
		</div>
		<?php
	}

	// ─── Artivio transport ──────────────────────────────────────────────────

	private function artivio( string $method, string $path, $body = null, int $timeout = 20 ) {
		$o   = self::options();
		$url = $o['artivio_url'] . '/api/site-chat/' . ltrim( $path, '/' );
		$args = array(
			'method'  => $method,
			'timeout' => $timeout,
			'headers' => array(
				'Authorization' => 'Bearer ' . $o['token'],
				'Accept'        => 'application/json',
				'User-Agent'    => 'artivio-site-chat/' . ARTIVIO_SITE_CHAT_VERSION . ' (' . home_url() . ')',
			),
		);
		if ( null !== $body ) {
			$args['headers']['Content-Type'] = 'application/json';
			$args['body']                    = wp_json_encode( $body );
		}
		$res = wp_remote_request( $url, $args );
		if ( is_wp_error( $res ) ) {
			return new WP_Error( 'artivio_unreachable', $res->get_error_message(), array( 'status' => 502 ) );
		}
		$code = (int) wp_remote_retrieve_response_code( $res );
		$json = json_decode( (string) wp_remote_retrieve_body( $res ), true );
		if ( $code >= 400 ) {
			$msg = is_array( $json ) && ! empty( $json['error'] ) ? (string) $json['error'] : 'Artivio answered HTTP ' . $code;
			return new WP_Error( 'artivio_error', $msg, array( 'status' => $code ) );
		}
		return is_array( $json ) ? $json : array();
	}

	/** Settings-page connectivity probe. */
	private function probe(): array {
		$r = $this->artivio( 'GET', 'config', null, 15 );
		if ( is_wp_error( $r ) ) {
			return array( 'ok' => false, 'error' => $r->get_error_message() );
		}
		return array(
			'ok'       => true,
			'agent'    => (string) ( $r['agent']['name'] ?? 'Assistant' ),
			'provider' => (string) ( $r['provider'] ?? 'Artivio' ),
			'label'    => (string) ( $r['site']['label'] ?? '' ),
			'layout'   => ! empty( $r['site']['layoutEditing'] ),
		);
	}

	private function current_speaker(): array {
		$u = wp_get_current_user();
		return array(
			'id'   => (string) $u->ID,
			'name' => $u->display_name,
			'role' => (string) ( $u->roles[0] ?? 'editor' ),
		);
	}

	// ─── REST proxy (browser → this plugin → Artivio) ───────────────────────

	public function rest_routes(): void {
		$perm = function () {
			return current_user_can( ARTIVIO_SITE_CHAT_CAP );
		};
		register_rest_route( 'artivio-chat/v1', '/config', array( 'methods' => 'GET', 'callback' => array( $this, 'rest_config' ), 'permission_callback' => $perm ) );
		register_rest_route( 'artivio-chat/v1', '/messages', array( 'methods' => 'GET', 'callback' => array( $this, 'rest_messages' ), 'permission_callback' => $perm ) );
		register_rest_route( 'artivio-chat/v1', '/send', array( 'methods' => 'POST', 'callback' => array( $this, 'rest_send' ), 'permission_callback' => $perm ) );
		register_rest_route( 'artivio-chat/v1', '/stop', array( 'methods' => 'POST', 'callback' => array( $this, 'rest_stop' ), 'permission_callback' => $perm ) );
		register_rest_route( 'artivio-chat/v1', '/reset', array( 'methods' => 'POST', 'callback' => array( $this, 'rest_reset' ), 'permission_callback' => $perm ) );
	}

	public function rest_config() {
		if ( ! $this->connected() ) {
			return new WP_Error( 'not_connected', 'The assistant is not connected yet.', array( 'status' => 409 ) );
		}
		$r = $this->artivio( 'GET', 'config', null, 15 );
		return is_wp_error( $r ) ? $r : rest_ensure_response( $r );
	}

	public function rest_messages() {
		if ( ! $this->connected() ) {
			return new WP_Error( 'not_connected', 'The assistant is not connected yet.', array( 'status' => 409 ) );
		}
		$s = $this->current_speaker();
		$r = $this->artivio( 'GET', 'messages?' . http_build_query( array( 'user' => $s['id'], 'name' => $s['name'], 'role' => $s['role'] ) ), null, 15 );
		return is_wp_error( $r ) ? $r : rest_ensure_response( $r );
	}

	public function rest_send( WP_REST_Request $req ) {
		if ( ! $this->connected() ) {
			return new WP_Error( 'not_connected', 'The assistant is not connected yet.', array( 'status' => 409 ) );
		}
		$message = trim( (string) $req->get_param( 'message' ) );
		if ( '' === $message ) {
			return new WP_Error( 'empty', 'Say what you would like changed.', array( 'status' => 400 ) );
		}
		if ( strlen( $message ) > 16000 ) {
			return new WP_Error( 'too_long', 'That message is too long — split it up.', array( 'status' => 400 ) );
		}
		$r = $this->artivio( 'POST', 'messages', array( 'user' => $this->current_speaker(), 'message' => $message ), 25 );
		return is_wp_error( $r ) ? $r : rest_ensure_response( $r );
	}

	public function rest_stop() {
		$r = $this->artivio( 'POST', 'stop', array( 'user' => $this->current_speaker() ), 15 );
		return is_wp_error( $r ) ? $r : rest_ensure_response( $r );
	}

	/** "Start new conversation" — archives the speaker's current thread on Artivio so the next message opens a fresh one. */
	public function rest_reset() {
		$r = $this->artivio( 'POST', 'reset', array( 'user' => $this->current_speaker() ), 15 );
		return is_wp_error( $r ) ? $r : rest_ensure_response( $r );
	}
}

Artivio_Site_Chat::instance();
