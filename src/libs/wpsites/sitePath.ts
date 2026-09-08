/**
 * Where an agent may write on a WordPress host (Phase 41).
 *
 * `wp eval` / `eval-file` stay denied: a shared-hosting SSH login is
 * account-wide, so PHP execution is a shell over every site on the account.
 * A FILE under wp-content is a much smaller surface — it is what a plugin
 * install already does — and it is what an autonomous build actually needs
 * (an mu-plugin with three add_filter lines; Theo, BBI, 2026-09-08).
 *
 * Rules, all enforced before anything touches the host:
 *   - relative to the site root; must resolve under wp-content/
 *   - only these subtrees: mu-plugins/, plugins/, themes/, languages/
 *   - no traversal, no absolute paths, no hidden files, no .htaccess/.user.ini
 *   - only text-ish extensions (php, css, js, json, txt, md, html, po, pot, svg)
 *   - wp-config.php and index.php at any root are never writable
 */

const ALLOWED_ROOTS = ['mu-plugins', 'plugins', 'themes', 'languages'] as const;
const ALLOWED_EXT = /\.(?:php|css|js|mjs|json|txt|md|html|htm|po|pot|svg|xml|csv)$/i;
const FORBIDDEN_NAMES = new Set(['.htaccess', '.user.ini', 'php.ini', 'wp-config.php', '.env']);

export type SitePath = { rel: string; abs: string; isPhp: boolean };

/**
 * Validate a path the agent supplied and pin it under the site's wp-content.
 * Returns the normalised relative path (always starting "wp-content/") and the
 * absolute host path. Throws a plain message otherwise.
 */
export function resolveSitePath(siteRoot: string, raw: unknown): SitePath {
  let p = String(raw ?? '').trim().replace(/\\/g, '/');
  if (!p) {
    throw new Error('path is required, e.g. "wp-content/mu-plugins/site-fixes.php".');
  }
  if (p.startsWith('/') || /^[a-z]:/i.test(p)) {
    throw new Error(`path must be relative to the site root (got "${p.slice(0, 60)}"), e.g. "wp-content/mu-plugins/site-fixes.php".`);
  }
  p = p.replace(/^\.\//, '');
  const parts = p.split('/').filter(Boolean);
  if (parts.some(s => s === '..' || s === '.')) {
    throw new Error('path may not contain "." or ".." segments.');
  }
  if (parts.some(s => s.startsWith('.'))) {
    throw new Error('hidden files (a name starting with ".") cannot be written.');
  }
  if (parts.length < 3 || parts[0] !== 'wp-content') {
    throw new Error(`only files under wp-content/{${ALLOWED_ROOTS.join('|')}}/ can be written (got "${p.slice(0, 80)}"). For code that must run on every load use wp-content/mu-plugins/<name>.php.`);
  }
  if (!(ALLOWED_ROOTS as readonly string[]).includes(parts[1]!)) {
    throw new Error(`wp-content/${parts[1]} is not writable; allowed: ${ALLOWED_ROOTS.map(r => `wp-content/${r}/`).join(', ')}.`);
  }
  const name = parts[parts.length - 1]!;
  if (FORBIDDEN_NAMES.has(name.toLowerCase())) {
    throw new Error(`"${name}" is never written by the platform.`);
  }
  if (!ALLOWED_EXT.test(name)) {
    throw new Error(`"${name}": only text files are written (php, css, js, json, txt, md, html, svg, po/pot, xml, csv). Binary assets go through wp_upload_media.`);
  }
  if (parts.some(s => s.length > 120) || p.length > 400) {
    throw new Error('path is too long.');
  }
  const rel = parts.join('/');
  const root = siteRoot.replace(/\/+$/, '');
  return { rel, abs: `${root}/${rel}`, isPhp: /\.php$/i.test(name) };
}

export const MAX_SITE_FILE_BYTES = 512 * 1024;
