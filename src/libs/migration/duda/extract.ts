/**
 * Phase 1 extraction: Duda → a reviewable Markdown file set (Phase 48, Part 1).
 *
 * Given a `migration_jobs` row, this runs the full extract and writes progress
 * into `migration_items` as it goes — one row per page, blog post, collection
 * row and media file. On success the job moves to `awaiting_review`; on a
 * back-off (429/503) or hard error it moves to `failed` with the reason.
 *
 * Ordering matters: pages are fetched from their published live URLs (classic
 * Duda has no content API), which is the only part that touches the customer's
 * host — so it runs under the PoliteCrawler. Blog/collections/theme/content are
 * clean API reads.
 */

import type { DudaBlogPost, DudaClient, DudaContentLibrary, DudaNavItem, DudaPage, DudaSiteTheme } from '@/libs/migration/duda/client';
import type { MigrationJob } from '@/libs/migration/store';
import { CrawlBackoffError, PoliteCrawler } from '@/libs/migration/duda/crawl';
import { htmlToMarkdown, parsePageHtml } from '@/libs/migration/duda/htmlParser';
import {
  buildCurrentDesignMarkdown,
  buildNewDesignBriefSkeleton,
  buildOverviewMarkdown,
  buildPageMarkdown,
  buildPostMarkdown,
  slugify,
} from '@/libs/migration/duda/markdown';
import { mediaFilename, writeMedia, writeText } from '@/libs/migration/duda/storage';
import { setJobPhase, setJobStatus, upsertItem } from '@/libs/migration/store';

/** src → { path, alt } for images already downloaded this run (hash dedup). */
type MediaMap = Map<string, { path: string; alt: string }>;

type MediaManifestEntry = { sourceUrl: string; localFile: string; suggestedAlt: string };

function pickPublishBaseUrl(details: { canonical_url?: string; preview_site_url?: string; publish_status?: string; site_domain?: string }): string | null {
  const status = (details.publish_status ?? '').toUpperCase();
  if (status === 'PUBLISHED' && details.canonical_url) {
    return details.canonical_url.replace(/\/+$/, '');
  }
  // Unpublished sites: the preview URL carries its own signed token — use as-is.
  if (details.preview_site_url) {
    return details.preview_site_url;
  }
  if (details.canonical_url) {
    return details.canonical_url.replace(/\/+$/, '');
  }
  if (details.site_domain) {
    return `https://${details.site_domain.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
  }
  return null;
}

function pageUrlFor(baseUrl: string, path: string): string {
  const clean = (path ?? '').replace(/^\/+/, '');
  if (!clean || clean === 'home' || clean === 'index') {
    return baseUrl;
  }
  try {
    return new URL(clean, `${baseUrl}/`).toString();
  } catch {
    return `${baseUrl}/${clean}`;
  }
}

function postDate(p: DudaBlogPost): string {
  const raw = p.publish_date || p.published_date || p.created_date || '';
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  return m ? m[1]! : new Date().toISOString().slice(0, 10);
}

function featuredImageUrl(p: DudaBlogPost): string {
  if (typeof p.featured_image === 'string') {
    return p.featured_image;
  }
  return p.featured_image?.url ?? '';
}

/** Download one image, dedup by content hash, record a migration_item + manifest row. */
async function ingestImage(args: {
  jobId: string;
  tenantId: string;
  crawler: PoliteCrawler;
  url: string;
  alt: string;
  mediaMap: MediaMap;
  manifest: MediaManifestEntry[];
}): Promise<string | null> {
  const { jobId, tenantId, crawler, url, alt, mediaMap, manifest } = args;
  const existing = mediaMap.get(url);
  if (existing) {
    return existing.path;
  }
  const res = await crawler.fetchBytes(url);
  if (!res.ok) {
    await upsertItem({ jobId, itemType: 'media', sourceRef: url, status: 'failed', error: res.reason });
    return null;
  }
  // Skip non-images defensively (a mis-tagged link, an SVG sprite sheet, etc.).
  if (!/^image\//i.test(res.contentType) && !/\.(?:jpe?g|png|gif|webp|svg|avif)(?:\?|#|$)/i.test(url)) {
    await upsertItem({ jobId, itemType: 'media', sourceRef: url, status: 'failed', error: `not an image (${res.contentType})` });
    return null;
  }
  const filename = mediaFilename(res.bytes, res.contentType, url);
  const path = await writeMedia(tenantId, jobId, filename, res.bytes, res.contentType);
  const suggestedAlt = alt || slugify(filename.replace(/\.[a-z0-9]+$/i, '')).replace(/-/g, ' ');
  mediaMap.set(url, { path, alt });
  // Dedup manifest by local file (many source URLs can map to one hashed file).
  if (!manifest.some(e => e.localFile === path && e.sourceUrl === url)) {
    manifest.push({ sourceUrl: url, localFile: path, suggestedAlt });
  }
  await upsertItem({ jobId, itemType: 'media', sourceRef: url, status: 'extracted', filePath: path });
  return path;
}

function themeColors(theme: DudaSiteTheme): Array<{ label: string; value: string; role?: string }> {
  return (theme.colors ?? [])
    .filter(c => c && (c.value || c.label))
    .map(c => ({ label: c.label ?? '', value: c.value ?? '', role: c.role }));
}

function themeFonts(theme: DudaSiteTheme): string[] {
  const fonts = new Set<string>();
  const walk = (v: unknown) => {
    if (!v || typeof v !== 'object') {
      return;
    }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (/font.?family/i.test(k) && typeof val === 'string') {
        fonts.add(val);
      } else if (typeof val === 'object') {
        walk(val);
      }
    }
  };
  walk(theme.typography);
  walk(theme.fonts);
  return [...fonts];
}

function navLinksFrom(nav: DudaNavItem[]): Array<{ text: string; href: string }> {
  const out: Array<{ text: string; href: string }> = [];
  const walk = (items: DudaNavItem[]) => {
    for (const it of items ?? []) {
      const text = it.title || it.label || '';
      const href = it.path ? `/${String(it.path).replace(/^\/+/, '')}` : '';
      if (text) {
        out.push({ text, href });
      }
      if (it.children?.length) {
        walk(it.children);
      }
    }
  };
  walk(nav);
  return out;
}

function businessFields(lib: DudaContentLibrary) {
  const b = lib.business_data ?? {};
  const phones = (b.phones ?? []).map(p => p.number ?? '').filter(Boolean);
  if (b.phone_number) {
    phones.unshift(b.phone_number);
  }
  const emails = (b.emails ?? []).map(e => e.address ?? '').filter(Boolean);
  const socials = Object.entries(b.social_accounts ?? {}).map(([network, url]) => ({ network, url: String(url) }));
  const address = typeof b.address === 'string' ? b.address : (b.address ? JSON.stringify(b.address) : '');
  return {
    name: b.name ?? '',
    description: b.description ?? '',
    category: b.category ?? '',
    address,
    phones: [...new Set(phones)],
    emails,
    socials,
    logos: b.logo_url ? [b.logo_url] : [],
  };
}

/**
 * Run the whole of Phase 1 for a job. Persists its own outcome (status +
 * per-item rows); safe to call from `after()`.
 */
export async function runExtraction(job: MigrationJob, client: DudaClient): Promise<void> {
  const { id: jobId, tenantId, sourceSiteId: siteName } = job;
  const crawler = new PoliteCrawler();
  const mediaMap: MediaMap = new Map();
  const manifest: MediaManifestEntry[] = [];

  try {
    await setJobStatus(jobId, 'extracting', { currentPhase: 'reading site metadata' });
    const details = await client.getSiteDetails(siteName);
    const baseUrl = pickPublishBaseUrl(details);

    const [theme, contentLib, nav] = await Promise.all([
      client.getSiteTheme(siteName).catch(() => ({} as DudaSiteTheme)),
      client.getContentLibrary(siteName).catch(() => ({} as DudaContentLibrary)),
      client.getNavigation(siteName).catch(() => [] as DudaNavItem[]),
    ]);
    const biz = businessFields(contentLib);
    const siteNav = navLinksFrom(nav);

    // ── Pages: live-URL crawl + parse (the only part touching the customer host) ──
    await setJobPhase(jobId, 'extracting pages');
    const pages = await client.listPages(siteName).catch(() => [] as DudaPage[]);
    const usedSlugs = new Set<string>();
    const pageIndex: Array<{ slug: string; title: string; sourcePath: string; status: string }> = [];

    for (const page of pages) {
      const sourcePath = `/${String(page.path ?? '').replace(/^\/+/, '')}`;
      const sourceRef = page.uuid || sourcePath;
      let slug = slugify(page.path || page.title || 'page');
      while (usedSlugs.has(slug)) {
        slug = `${slug}-2`;
      }
      usedSlugs.add(slug);

      if (!baseUrl) {
        await upsertItem({ jobId, itemType: 'page', sourceRef, status: 'failed', error: 'no published/preview URL for the site' });
        pageIndex.push({ slug, title: page.title ?? slug, sourcePath, status: 'failed' });
        continue;
      }

      const url = pageUrlFor(baseUrl, page.path ?? '');
      const res = await crawler.fetchHtml(url);
      if (!res.ok) {
        await upsertItem({ jobId, itemType: 'page', sourceRef, status: 'failed', error: `fetch ${url}: ${res.reason}` });
        pageIndex.push({ slug, title: page.title ?? slug, sourcePath, status: 'failed' });
        continue;
      }

      const parsed = parsePageHtml(res.html, url);
      for (const img of parsed.images) {
        await ingestImage({ jobId, tenantId, crawler, url: img.src, alt: img.alt, mediaMap, manifest });
      }

      const md = buildPageMarkdown({
        sourcePath,
        targetSlug: slug,
        title: page.title || parsed.title || slug,
        seoTitle: page.seo?.title ?? parsed.title ?? '',
        seoDescription: page.seo?.description ?? parsed.metaDescription ?? '',
        blocks: parsed.blocks,
        nav: siteNav.length ? siteNav : parsed.nav,
        mediaMap,
      });
      const filePath = await writeText(tenantId, jobId, `pages/${slug}.md`, md);
      await upsertItem({ jobId, itemType: 'page', sourceRef, status: 'extracted', filePath });
      pageIndex.push({ slug, title: page.title ?? slug, sourcePath, status: 'extracted' });
    }

    // ── Blog posts: clean API content ──
    await setJobPhase(jobId, 'extracting blog posts');
    const postIndex: Array<{ date: string; title: string; file: string; status: string }> = [];
    const summaries = await client.listBlogPosts(siteName).catch(() => []);
    for (const s of summaries) {
      const postId = s.post_id || s.id || '';
      if (!postId) {
        continue;
      }
      try {
        const post = await client.getBlogPost(siteName, postId);
        const date = postDate(post);
        const slug = slugify(post.slug || post.title || postId);
        const file = `${date}-${slug}.md`;
        const feat = featuredImageUrl(post);
        let featPath = '';
        if (feat) {
          featPath = (await ingestImage({ jobId, tenantId, crawler, url: feat, alt: post.title ?? '', mediaMap, manifest })) ?? '';
        }
        const md = buildPostMarkdown({
          date,
          author: post.author ?? '',
          tags: post.tags ?? post.categories ?? [],
          featuredImage: featPath,
          title: post.title ?? slug,
          bodyMarkdown: htmlToMarkdown(post.content || post.html || ''),
        });
        const filePath = await writeText(tenantId, jobId, `posts/${file}`, md);
        await upsertItem({ jobId, itemType: 'post', sourceRef: postId, status: 'extracted', filePath });
        postIndex.push({ date, title: post.title ?? slug, file, status: 'extracted' });
      } catch (err) {
        await upsertItem({ jobId, itemType: 'post', sourceRef: postId, status: 'failed', error: err instanceof Error ? err.message : String(err) });
      }
    }

    // ── Collections: structured data referenced by later phases ──
    await setJobPhase(jobId, 'extracting collections');
    const collectionNames: string[] = [];
    const cols = await client.listCollections(siteName).catch(() => []);
    for (const c of cols) {
      const name = c.name ?? '';
      if (!name) {
        continue;
      }
      try {
        const detail = await client.getCollection(siteName, name);
        const rows = detail.values ?? detail.data ?? [];
        await writeText(tenantId, jobId, `collections/${slugify(name)}.json`, JSON.stringify(detail, null, 2), 'application/json');
        collectionNames.push(name);
        for (let i = 0; i < rows.length; i++) {
          await upsertItem({ jobId, itemType: 'collection_row', sourceRef: `${name}#${i}`, status: 'extracted', filePath: `collections/${slugify(name)}.json` });
        }
      } catch (err) {
        await upsertItem({ jobId, itemType: 'collection_row', sourceRef: name, status: 'failed', error: err instanceof Error ? err.message : String(err) });
      }
    }

    // ── Logos also become managed media ──
    for (const logo of biz.logos) {
      await ingestImage({ jobId, tenantId, crawler, url: logo, alt: `${biz.name} logo`, mediaMap, manifest });
    }
    const logoPaths = biz.logos.map(l => mediaMap.get(l)?.path ?? l);

    // ── Design docs + media manifest + overview ──
    await setJobPhase(jobId, 'writing design docs + overview');
    await writeText(tenantId, jobId, 'design/current-design.md', buildCurrentDesignMarkdown({
      businessName: biz.name || siteName,
      businessDescription: biz.description,
      category: biz.category,
      address: biz.address,
      phones: biz.phones,
      emails: biz.emails,
      socials: biz.socials,
      logos: logoPaths,
      colors: themeColors(theme),
      fonts: themeFonts(theme),
    }));
    await writeText(tenantId, jobId, 'design/new-design-brief.md', buildNewDesignBriefSkeleton());
    await writeText(tenantId, jobId, 'media/manifest.json', JSON.stringify(manifest, null, 2), 'application/json');
    await writeText(tenantId, jobId, '00-overview.md', buildOverviewMarkdown({
      siteName,
      businessName: biz.name,
      pages: pageIndex,
      posts: postIndex.sort((a, b) => a.date.localeCompare(b.date)),
      mediaCount: manifest.length,
      collections: collectionNames,
    }));

    await setJobStatus(jobId, 'awaiting_review', { currentPhase: 'extraction complete — awaiting human review', error: null });
  } catch (err) {
    const reason = err instanceof CrawlBackoffError
      ? err.message
      : (err instanceof Error ? err.message : String(err));
    await setJobStatus(jobId, 'failed', { currentPhase: 'extraction failed', error: reason });
  }
}
