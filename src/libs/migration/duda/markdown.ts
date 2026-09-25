/**
 * Markdown builders for the Phase 1 reviewable file set (Phase 48, Part 1).
 *
 * Pure string functions — no I/O, no network — so they're trivially testable
 * and the extractor stays a thin orchestrator over them. Templates match the
 * design doc exactly (page_type stays "unknown"; classification is Phase 2).
 */

import type { ParsedBlock, ParsedLink } from '@/libs/migration/duda/htmlParser';

export type PageDoc = {
  sourcePath: string;
  targetSlug: string;
  title: string;
  seoTitle: string;
  seoDescription: string;
  blocks: ParsedBlock[];
  nav: ParsedLink[];
  /** src → local media path, so image blocks point at the downloaded file. */
  mediaMap: Map<string, { path: string; alt: string }>;
};

function yamlEscape(v: string): string {
  // Quote only when the value could confuse a YAML parser: empty, a leading
  // indicator char, a `key: value`-style colon, a trailing/leading space, a
  // comment marker, or a newline. Plain paths/slugs like `/about-us` are safe
  // unquoted (a mid-string hyphen and a leading slash are both fine).
  const needsQuote
    = v === ''
      || /^[-?:,[\]{}#&*!|>'"%@`]/.test(v)
      || /:\s/.test(v)
      || v.endsWith(':')
      || /\s#/.test(v)
      || /^\s|\s$/.test(v)
      || /[\n\r]/.test(v);
  if (needsQuote) {
    return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return v;
}

export function slugify(input: string): string {
  const s = input.trim().toLowerCase().replace(/^https?:\/\/[^/]+/i, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'page';
}

/** Render the block list to Markdown, resolving images to their local paths. */
function renderBlocks(doc: PageDoc): string {
  const out: string[] = [];
  for (const b of doc.blocks) {
    if (b.kind === 'heading') {
      // Body headings become H2/H3 under the page H1; clamp to a sane range.
      const level = Math.min(Math.max(b.level, 2), 4);
      out.push(`${'#'.repeat(level)} ${b.text}`);
    } else if (b.kind === 'paragraph') {
      out.push(b.text);
    } else if (b.kind === 'image') {
      const local = doc.mediaMap.get(b.src);
      const path = local?.path ?? b.src;
      const alt = local?.alt || b.alt || '';
      out.push(`**Image:** ${path} (alt: ${JSON.stringify(alt)})`);
    } else if (b.kind === 'link') {
      out.push(`**CTA:** ${JSON.stringify(b.text)} → ${b.href}`);
    }
  }
  return out.join('\n\n');
}

export function buildPageMarkdown(doc: PageDoc): string {
  const front = [
    '---',
    `source_path: ${yamlEscape(doc.sourcePath)}`,
    `target_slug: ${yamlEscape(doc.targetSlug)}`,
    'page_type: unknown       # classification happens in Phase 2 — leave as "unknown" here',
    `title: ${yamlEscape(doc.title)}`,
    `seo_title: ${yamlEscape(doc.seoTitle)}`,
    `seo_description: ${yamlEscape(doc.seoDescription)}`,
    'status: extracted',
    '---',
  ].join('\n');

  const navLines = doc.nav.length
    ? doc.nav.map(n => `- ${n.text || '(no label)'} → ${n.href}`).join('\n')
    : '_none detected_';

  return `${front}

# ${doc.title || doc.targetSlug}

${renderBlocks(doc) || '_No body content was extracted from the rendered page. A reviewer should check this page manually._'}

## Site navigation (from header/footer)
${navLines}

## Notes for rebuild
<!-- anything ambiguous the reviewer should resolve -->
`;
}

export type PostDoc = {
  date: string; // YYYY-MM-DD
  author: string;
  tags: string[];
  featuredImage: string; // local media path or ''
  title: string;
  bodyMarkdown: string;
};

export function buildPostMarkdown(doc: PostDoc): string {
  const front = [
    '---',
    `date: ${doc.date}`,
    `author: ${yamlEscape(doc.author)}`,
    `tags: [${doc.tags.map(t => yamlEscape(t)).join(', ')}]`,
    `featured_image: ${yamlEscape(doc.featuredImage)}`,
    'status: extracted',
    '---',
  ].join('\n');

  return `${front}

# ${doc.title}

${doc.bodyMarkdown}
`;
}

export type OverviewInput = {
  siteName: string;
  businessName: string;
  pages: Array<{ slug: string; title: string; sourcePath: string; status: string }>;
  posts: Array<{ date: string; title: string; file: string; status: string }>;
  mediaCount: number;
  collections: string[];
};

export function buildOverviewMarkdown(o: OverviewInput): string {
  const pageRows = o.pages.length
    ? o.pages.map(p => `| [${p.title || p.slug}](pages/${p.slug}.md) | \`${p.sourcePath}\` | ${p.status} |`).join('\n')
    : '| _no pages_ | | |';
  const postRows = o.posts.length
    ? o.posts.map(p => `| ${p.date} | [${p.title}](posts/${p.file}) | ${p.status} |`).join('\n')
    : '| _no blog posts_ | | |';
  const collectionsLine = o.collections.length
    ? o.collections.map(c => `\`${c}\``).join(', ')
    : '_none_';

  return `# Migration overview — ${o.businessName || o.siteName}

Source Duda site: \`${o.siteName}\`
Media files downloaded: **${o.mediaCount}**
Collections: ${collectionsLine}

Design files: [current design](design/current-design.md) · [new design brief](design/new-design-brief.md)

## Pages
| Page | Source path | Status |
| --- | --- | --- |
${pageRows}

## Blog posts (by date)
| Date | Post | Status |
| --- | --- | --- |
${postRows}

## Review status
- [ ] Pages reviewed
- [ ] Blog posts reviewed
- [ ] Images reviewed
- [ ] Current design documented
- [ ] New design approved
`;
}

export type CurrentDesignInput = {
  businessName: string;
  businessDescription: string;
  category: string;
  address: string;
  phones: string[];
  emails: string[];
  socials: Array<{ network: string; url: string }>;
  logos: string[]; // urls/paths
  colors: Array<{ label: string; value: string; role?: string }>;
  fonts: string[];
};

export function buildCurrentDesignMarkdown(d: CurrentDesignInput): string {
  const colorRows = d.colors.length
    ? d.colors.map(c => `| ${c.label || '(unlabelled)'} | \`${c.value}\` | ${c.role ?? '_TODO: which role — CTA / heading / background?_'} |`).join('\n')
    : '| _none extracted_ | | |';
  const logoLines = d.logos.length ? d.logos.map(l => `- ${l}`).join('\n') : '- _none found_';
  const fontLine = d.fonts.length ? d.fonts.join(', ') : '_none extracted_';
  const socialLines = d.socials.length ? d.socials.map(s => `- ${s.network}: ${s.url}`).join('\n') : '- _none_';

  return `# Current design — ${d.businessName}

_Auto-extracted fields are filled in below. Sections marked **TODO (human)** need a
judgement call during review — the extractor deliberately does not guess at
subjective brand characterisations._

## Business info (from Content Library)
- **Name:** ${d.businessName || '_unknown_'}
- **Description:** ${d.businessDescription || '_unknown_'}
- **Category:** ${d.category || '_unknown_'}
- **Address:** ${d.address || '_unknown_'}
- **Phones:** ${d.phones.join(', ') || '_none_'}
- **Emails:** ${d.emails.join(', ') || '_none_'}

### Social accounts
${socialLines}

## Logo & marks
${logoLines}
<!-- TODO (human): note which variant (full-colour / reversed / favicon) appears where. -->

## Color palette (from get_site_theme — exact values, not eyeballed)
| Label | Value | Role |
| --- | --- | --- |
${colorRows}

## Typography
- **Font families:** ${fontLine}
- **TODO (human):** heading vs body personality (modern serif, friendly sans…).

## Imagery style — **TODO (human)**
<!-- real photos vs stock, warm vs cool, people-forward vs place-forward -->

## Voice & tone — **TODO (human)**
<!-- paste a representative copy sample; formal vs warm/conversational -->

## Recurring signature elements — **TODO (human)**
<!-- nav labels regulars would miss (e.g. "Sermons"/"Give"), service-times widget, etc. -->

## Required footer/legal marks — **TODO (human)**
<!-- affiliation badges, copyright text, accreditation marks -->

## Non-visual continuity items — **TODO (human)**
<!-- analytics IDs, tracking pixels, embedded widgets to re-add -->
`;
}

/** The new-design brief is a placeholder skeleton in Part 1 (filled in Phase 2). */
export function buildNewDesignBriefSkeleton(): string {
  return `# New design brief

> **Placeholder — Phase 2 / dashboard work.** This file is created empty by
> Phase 1 extraction so the folder structure is complete. It is filled in during
> review via the new-design questionnaire and the Divi draft-mockup flow; the
> extraction code does not populate it.

## Forced-choice questionnaire
_TODO (Phase 2 / dashboard): modern-minimal vs warm-traditional, bold vs muted
colour, photo-heavy vs icon/illustration-heavy, spacious vs content-dense, plus
"anything from the old site that must not change"._

## Reference URLs / images (optional)
_TODO_

## Approved Divi draft
_TODO (Phase 3): link to the approved unpublished draft page on the destination site._
`;
}
