/**
 * A minimal, dependency-free HTML → structure parser for Phase 1 page
 * extraction (Phase 48, Part 1).
 *
 * We are NOT reconstructing a DOM or preserving Duda's markup (that markup means
 * nothing in WordPress — see the Divi migration playbook). We only need the
 * human-reviewable essentials: the page's headings and paragraph text in order,
 * the images (src + alt), the links/CTAs, and the site nav (once, from the
 * header/footer). A tolerant regex/stack walk is enough and keeps us to the
 * repo's no-new-deps rule; `parse5` in the tree is a dev-only transitive dep.
 */

export type ParsedImage = { src: string; alt: string };
export type ParsedLink = { text: string; href: string };
export type ParsedBlock
  = | { kind: 'heading'; level: number; text: string }
    | { kind: 'paragraph'; text: string }
    | { kind: 'image'; src: string; alt: string }
    | { kind: 'link'; text: string; href: string };

export type ParsedPage = {
  title: string;
  metaDescription: string;
  blocks: ParsedBlock[];
  images: ParsedImage[];
  links: ParsedLink[];
  /** Nav labels+hrefs found in <nav>/header/footer, deduped. */
  nav: ParsedLink[];
};

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, '\'')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)));
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function attr(tag: string, name: string): string {
  const m = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '') : '';
}

/** Remove chrome we never want in body text. */
function stripNonContent(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

function absolutise(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

function extractLinks(html: string, base: string): ParsedLink[] {
  const out: ParsedLink[] = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(html))) {
    const href = absolutise(attr(m[1] ?? '', 'href'), base);
    const text = stripTags(m[2] ?? '');
    if (href) {
      out.push({ text, href });
    }
  }
  return out;
}

/** Return the inner HTML of each occurrence of the given block tags. */
function matchRegions(html: string, tags: string[]): string[] {
  const regions: string[] = [];
  for (const tag of tags) {
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
    let m: RegExpExecArray | null;
    // eslint-disable-next-line no-cond-assign
    while ((m = re.exec(html))) {
      regions.push(m[1] ?? '');
    }
  }
  return regions;
}

/**
 * Turn a blog post's HTML body into readable Markdown-ish text. Blog content
 * comes clean from the Duda API (no scraping), so this is a light conversion,
 * not a full crawl-parse: headings, paragraphs, list items and links, with tags
 * otherwise stripped. Good enough to be human-reviewable and Phase-2-consumable.
 */
export function htmlToMarkdown(html: string): string {
  let s = stripNonContent(html);
  s = s
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl, inner) => `\n\n${'#'.repeat(Math.min(Number(lvl) + 1, 6))} ${stripTags(inner)}\n\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => `\n- ${stripTags(inner)}`)
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_, a, inner) => {
      const href = attr(a, 'href');
      const text = stripTags(inner);
      return href ? `[${text}](${href})` : text;
    })
    .replace(/<\/(p|div|section|br)[^>]*>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n');
  return stripTags(s).length === 0 ? '' : decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\n{3,}/g, '\n\n').trim();
}

/** Parse rendered page HTML into the small reviewable structure Phase 1 needs. */
export function parsePageHtml(rawHtml: string, pageUrl: string): ParsedPage {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(rawHtml);
  const title = titleMatch ? stripTags(titleMatch[1] ?? '') : '';

  const descMatch = /<meta[^>]+name\s*=\s*["']description["'][^>]*>/i.exec(rawHtml);
  const metaDescription = descMatch ? attr(descMatch[0], 'content') : '';

  // Nav comes from <nav>, <header> and <footer> regions — collected once.
  const nav: ParsedLink[] = [];
  const seenNav = new Set<string>();
  for (const region of matchRegions(rawHtml, ['nav', 'header', 'footer'])) {
    for (const link of extractLinks(region, pageUrl)) {
      const key = `${link.text}|${link.href}`;
      if (link.text && !seenNav.has(key)) {
        seenNav.add(key);
        nav.push(link);
      }
    }
  }

  // Body = document minus header/footer/nav chrome and minus script/style.
  let body = stripNonContent(rawHtml);
  body = body
    .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, ' ');

  const images: ParsedImage[] = [];
  const links: ParsedLink[] = [];
  const seenImg = new Set<string>();

  // Collect each block-level element WITH its document position, then emit in
  // order. Separate patterns per tag are more reliable than one combined regex:
  // paired tags (h1-6/p/a) need their real closing tag to capture inner text,
  // while <img> is a void element with no inner.
  const found: Array<{ at: number; block: ParsedBlock }> = [];

  const pairRe = /<(h[1-6]|p|a)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = pairRe.exec(body))) {
    const tag = (m[1] ?? '').toLowerCase();
    const attrs = m[2] ?? '';
    const text = stripTags(m[3] ?? '');
    if (/^h[1-6]$/.test(tag)) {
      if (text) {
        found.push({ at: m.index, block: { kind: 'heading', level: Number(tag[1]), text } });
      }
    } else if (tag === 'p') {
      if (text) {
        found.push({ at: m.index, block: { kind: 'paragraph', text } });
      }
    } else {
      const href = absolutise(attr(attrs, 'href'), pageUrl);
      if (href && text) {
        links.push({ text, href });
        found.push({ at: m.index, block: { kind: 'link', text, href } });
      }
    }
  }

  const imgRe = /<img\b([^>]*)>/gi;
  // eslint-disable-next-line no-cond-assign
  while ((m = imgRe.exec(body))) {
    const attrs = m[1] ?? '';
    const src = absolutise(attr(attrs, 'src') || attr(attrs, 'data-src'), pageUrl);
    const alt = attr(attrs, 'alt');
    if (src && !seenImg.has(src)) {
      seenImg.add(src);
      images.push({ src, alt });
      found.push({ at: m.index, block: { kind: 'image', src, alt } });
    }
  }

  found.sort((a, b) => a.at - b.at);
  const blocks: ParsedBlock[] = found.map(f => f.block);

  // Backstop: images outside the body region (e.g. a header logo) still get
  // downloaded, even though they don't appear as body blocks.
  for (const imgTag of rawHtml.match(/<img\b[^>]*>/gi) ?? []) {
    const src = absolutise(attr(imgTag, 'src') || attr(imgTag, 'data-src'), pageUrl);
    const alt = attr(imgTag, 'alt');
    if (src && !seenImg.has(src)) {
      seenImg.add(src);
      images.push({ src, alt });
    }
  }

  return { title, metaDescription, blocks, images, links, nav };
}
