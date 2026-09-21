# Artivio Website Assistant (artivio-site-chat)

A chat panel inside wp-admin. The site owner says what they want changed; the
Artivio AI employee (Noah, Theo, …) makes the change on **this site** and
reports back. The site's team never needs an Artivio login.

## How it fits
- **Artivio** runs the agent. The site is registered under Tools → WordPress
  Sites in the agency's workspace; Site chat is switched on per site and a
  **site token** is issued there (shown once).
- **This plugin** stores that token and proxies the chat: browser → WordPress
  REST (nonce + capability) → Artivio `/api/site-chat/*` with the token. The
  token never reaches the browser. WordPress asserts who is speaking (user id,
  display name, role); Artivio keeps one conversation per site user.
- **What the assistant can do from here**: content (pages, posts, custom
  types), media uploads, SEO fields, cache flush, the site's own builder
  abilities, and the page-builder connection Artivio has bound to this site
  (DiviOps / Elementor). It cannot reach other sites, WP-CLI, plugin installs,
  file writes, billing, email or anything else on the agency's workspace —
  that is enforced on the Artivio side, not by this plugin.
- Turns are asynchronous: the panel polls every 2 s while the agent works, so
  a refresh never loses a change in progress.

## Install
1. Upload the zip via Plugins → Add New → Upload, activate.
2. In Artivio: Tools → WordPress Sites → the site → **Site chat → Enable +
   issue token**. Copy the Artivio URL + token.
3. WP Admin → Website Assistant → Settings: paste both, Save. The settings page
   shows "Connected. Assistant: Noah …" when the token works.
4. Optional: tick **Assistant-first** so editors land on the chat instead of
   the WordPress dashboard.

## Capability
`artivio_site_chat` — granted to administrator and editor on activation. Manage
per role with Adminify → Role Manager (or Members / User Role Editor).

## With Adminify (recommended for client sites)
- Menu Editor: hide everything except **Website Assistant** (and Media, if you
  want them uploading files themselves) for the client role.
- White Label: your logo, login page, colours; rename "WordPress" to your brand.
- Role Manager: keep `artivio_site_chat` on the client role; remove `edit_theme_options`,
  `install_plugins`, `activate_plugins`, `update_core` — the assistant does not
  need any of them and neither does the client.
- The menu item is registered at position 2 with `dashicons-format-chat` so it
  sits directly under Dashboard; Adminify's menu editor can move/rename it.

## Limits and honesty
- Daily request cap per site is set in Artivio (default 60/day). The panel shows
  the cap message when reached.
- Anything the assistant could not do is said in the reply; it never claims a
  change it did not make (Artivio checks every reply for that).
- Site-wide operations (plugin installs, search-replace, snapshots) are done by
  the agency from Artivio, on request.
