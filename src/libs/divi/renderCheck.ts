/**
 * Post-write render check (Phase 47).
 *
 * After a page or section write succeeds, render the SAVED page through
 * DiviOps' own `diviops_render_preview` (works for drafts — no public URL
 * needed) and append a short, factual summary to the tool result: how many
 * modules actually rendered, how many images, which images point off-site,
 * which columns came out empty. The model reports that, not what it sent.
 *
 * This is what stops "the page rendered cleanly" being said about a page that
 * fetched as a 404. It is advisory (the write already happened) and it never
 * throws — a failed render is reported as such.
 */

const PAGE_WRITES = new Set([
  'diviops_page_create',
  'diviops_page_update_content',
  'diviops_section_append',
  'diviops_section_replace',
  'diviops_section_remove',
  'diviops_module_update',
  'diviops_module_move',
  'diviops_module_clone',
]);

function pageIdFrom(toolName: string, args: Record<string, unknown>, resultText: string): number | null {
  for (const k of ['page_id', 'post_id', 'id']) {
    const v = args[k];
    if (typeof v === 'number' && Number.isFinite(v)) {
      return v;
    }
    if (typeof v === 'string' && /^\d+$/.test(v)) {
      return Number(v);
    }
  }
  if (toolName === 'diviops_page_create') {
    try {
      const j = JSON.parse(resultText) as { data?: Record<string, unknown> };
      const d = j.data ?? {};
      for (const k of ['id', 'post_id', 'page_id']) {
        const v = d[k];
        if (typeof v === 'number') {
          return v;
        }
        if (typeof v === 'string' && /^\d+$/.test(v)) {
          return Number(v);
        }
      }
    } catch {
      const m = /"(?:post_id|page_id|id)"\s*:\s*"?(\d+)/.exec(resultText);
      if (m) {
        return Number(m[1]);
      }
    }
  }
  return null;
}

function htmlFrom(resultText: string): string | null {
  try {
    const j = JSON.parse(resultText) as { ok?: boolean; data?: Record<string, unknown>; error?: { message?: string } };
    if (j.ok === false) {
      return null;
    }
    const d = j.data ?? {};
    for (const k of ['html', 'rendered', 'content', 'output']) {
      if (typeof d[k] === 'string') {
        return d[k] as string;
      }
    }
    return typeof j === 'string' ? j : null;
  } catch {
    return /<[a-z][\s\S]*>/i.test(resultText) ? resultText : null;
  }
}

/** Exported for tests: summarise rendered HTML. */
export function summariseRender(html: string, siteHost?: string): string {
  const modules = (html.match(/class="[^"]*\bet_pb_module\b/g) ?? []).length;
  const sections = (html.match(/class="[^"]*\bet_pb_section\b/g) ?? []).length;
  const imgs = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map(m => m[1]!);
  const offsite = imgs.filter((u) => {
    try {
      const h = new URL(u, siteHost ? `https://${siteHost}` : undefined).hostname.replace(/^www\./, '');
      return siteHost ? h !== siteHost.replace(/^www\./, '') : false;
    } catch {
      return false;
    }
  });
  // A column whose markup holds no module at all.
  const emptyColumns = [...html.matchAll(/<div class="[^"]*\bet_pb_column\b[^"]*"[^>]*>([\s\S]*?)(?=<div class="[^"]*\bet_pb_column\b|<\/div>\s*<\/div>\s*<div class="[^"]*\bet_pb_section\b|$)/g)]
    .filter(m => !/\bet_pb_module\b/.test(m[1] ?? ''))
    .length;
  const codeModules = (html.match(/\bet_pb_code\b/g) ?? []).length;
  const parts = [`${sections} section(s), ${modules} module(s) rendered`, `${imgs.length} image(s)`];
  if (offsite.length > 0) {
    parts.push(`${offsite.length} image(s) NOT hosted on the site: ${offsite.slice(0, 3).join(', ')}`);
  }
  if (emptyColumns > 0) {
    parts.push(`${emptyColumns} empty column(s)`);
  }
  if (codeModules > 0) {
    parts.push(`${codeModules} Code module(s)`);
  }
  if (modules === 0) {
    parts.push('NOTHING rendered — the markup was accepted but Divi produced no modules; do not report success');
  }
  return parts.join(' · ');
}

export async function diviRenderCheck(
  toolName: string,
  args: Record<string, unknown>,
  resultText: string,
  callTool: (name: string, a: Record<string, unknown>) => Promise<string>,
  ctx: { target: string },
): Promise<string | undefined> {
  if (!PAGE_WRITES.has(toolName) || args.dry_run) {
    return undefined;
  }
  const pageId = pageIdFrom(toolName, args, resultText);
  if (pageId === null) {
    return undefined;
  }
  try {
    const raw = await callTool('diviops_render_preview', { page_id: pageId });
    const html = htmlFrom(raw);
    if (!html) {
      return `[render check] page ${pageId} could not be rendered: ${raw.slice(0, 200)}. Do not report the page as verified — call diviops_render_preview {page_id: ${pageId}} yourself, or tell the owner to open the preview.`;
    }
    let siteHost: string | undefined;
    try {
      siteHost = new URL(ctx.target).hostname;
    } catch {
      siteHost = undefined;
    }
    return `[render check] saved page ${pageId} renders as: ${summariseRender(html, siteHost)}. This is the site's actual output; report it as such (drafts have no public URL — fetch_url on a draft returns the 404 page).`;
  } catch (err) {
    return `[render check] page ${pageId}: render failed (${err instanceof Error ? err.message.slice(0, 160) : 'error'}). Do not report the page as verified.`;
  }
}
