/**
 * Find the installable WordPress plugin inside a zip.
 *
 * Premium plugins are rarely shipped as the plugin itself: an Envato /
 * ThemePunch download is a PACKAGE zip (docs, licence, `revslider.zip` inside).
 * `wp plugin install package.zip` reports "No valid plugins were found" — true,
 * and useless. Seen live 2026-09-07 (Slider Revolution on
 * build.churchwebglobal.com). This walks one level of nested zips and returns
 * the bytes WP-CLI can actually install, with the plugin header it found.
 */

import JSZip from 'jszip';

export type PluginZipInfo = {
  /** Bytes of the zip that contains a real plugin (may be a nested zip). */
  bytes: Buffer;
  /** Directory the plugin lives in inside that zip ('' when the main file is at the root). */
  dir: string;
  /** Value of the `Plugin Name:` header. */
  pluginName: string;
  /** Path of the nested zip that was unwrapped, when one was. */
  nestedFrom?: string;
};

const HEADER_RE = /^[ \t/*#@]*Plugin Name:[ \t]*([^\r\n]+)/im;
const MAX_HEADER_BYTES = 8_192;

async function findPluginIn(zip: JSZip): Promise<{ dir: string; pluginName: string } | null> {
  const files = Object.values(zip.files).filter(f => !f.dir && /\.php$/i.test(f.name));
  // Depth ≤ 1 only: WordPress reads headers from the plugin's top-level files.
  const candidates = files.filter(f => f.name.split('/').length <= 2).sort((a, b) => a.name.length - b.name.length);
  for (const f of candidates) {
    const head = (await f.async('nodebuffer')).subarray(0, MAX_HEADER_BYTES).toString('utf8');
    const m = HEADER_RE.exec(head);
    if (m?.[1]) {
      const parts = f.name.split('/');
      return { dir: parts.length === 2 ? parts[0]! : '', pluginName: m[1].trim() };
    }
  }
  return null;
}

export async function pickPluginZip(bytes: Buffer): Promise<PluginZipInfo> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new Error('The file is not a zip archive. Plugins install from a .zip.');
  }
  const direct = await findPluginIn(zip);
  if (direct) {
    return { bytes, ...direct };
  }
  const nested = Object.values(zip.files).filter(f => !f.dir && /\.zip$/i.test(f.name));
  const tried: string[] = [];
  for (const entry of nested) {
    const inner = await entry.async('nodebuffer');
    let innerZip: JSZip;
    try {
      innerZip = await JSZip.loadAsync(inner);
    } catch {
      continue;
    }
    tried.push(entry.name);
    const found = await findPluginIn(innerZip);
    if (found) {
      return { bytes: inner, ...found, nestedFrom: entry.name };
    }
  }
  const top = Object.keys(zip.files).slice(0, 12).join(', ');
  throw new Error(
    `No WordPress plugin found in this zip: no top-level .php file carries a "Plugin Name:" header${tried.length ? `, and none of the nested zips (${tried.join(', ')}) does either` : ''}. Contents start: ${top}. If this is a theme, use wp_cli ["theme","install",…] instead; if it is a documentation bundle, ask the human for the plugin zip itself.`,
  );
}
