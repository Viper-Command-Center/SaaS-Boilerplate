/**
 * WordPress — built-in provider (per-site, bring-your-own credential).
 *
 * WordPress has no hosted MCP server, but every modern WP site already exposes
 * the REST API, and WP ships "Application Passwords" (Users → Profile →
 * Application Passwords) for exactly this: a revocable credential for an
 * external tool. So we talk to the site's REST API directly — no plugin for the
 * client to install, works on any self-hosted or managed WordPress.
 *
 * Per-connection config (stored on the mcp_connection, not the catalog):
 *   url        = the site, e.g. https://wellnesstrove.com
 *   credential = "username:application password"  (sealed in the vault)
 */

import type { BuiltinProvider } from '@/libs/plugins/types';

const MAX_BODY = 200_000;

function auth(credential: string): string {
  // credential is "user:application password" — WP wants HTTP Basic.
  return `Basic ${Buffer.from(credential.replace(/\s+/g, ' ').trim()).toString('base64')}`;
}

async function wp(
  siteUrl: string,
  credential: string,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const base = siteUrl.replace(/\/$/, '');
  const resp = await fetch(`${base}/wp-json/wp/v2${path}`, {
    ...init,
    headers: {
      'Authorization': auth(credential),
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  const text = await resp.text();
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const j = JSON.parse(text) as { message?: string; code?: string };
      msg = j.message ? `${j.message} (${j.code ?? resp.status})` : msg;
    } catch { /* keep the status */ }
    if (resp.status === 401 || resp.status === 403) {
      msg += ' — check the username and Application Password, and that the user can edit posts.';
    }
    throw new Error(`WordPress: ${msg}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function slim(items: unknown): unknown {
  if (!Array.isArray(items)) {
    return items;
  }
  return items.map((p: Record<string, any>) => ({
    id: p.id,
    status: p.status,
    slug: p.slug,
    link: p.link,
    title: p.title?.rendered ?? p.title,
    date: p.date,
    excerpt: typeof p.excerpt?.rendered === 'string'
      ? p.excerpt.rendered.replace(/<[^>]+>/g, '').slice(0, 160)
      : undefined,
  }));
}

export const wordpressProvider: BuiltinProvider = {
  slug: 'wordpress',
  name: 'WordPress',
  description: 'Read and publish posts and pages on a WordPress site — drafts, SEO content, updates. Uses the site\'s REST API with an Application Password; nothing to install on the site.',
  credentialLabel: 'WordPress username + Application Password, as "username:xxxx xxxx xxxx xxxx" (WP Admin → Users → Profile → Application Passwords)',
  perConnection: true, // each workspace supplies its own site + credential

  tools: [
    {
      name: 'list_posts',
      description: 'List posts on the WordPress site (newest first). Use status="draft" to see unpublished drafts.',
      input_schema: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          status: { type: 'string', description: 'publish | draft | any (default publish)' },
          per_page: { type: 'number', description: 'Max 50' },
        },
      },
    },
    {
      name: 'get_post',
      description: 'Fetch one post with its full HTML content, so you can rewrite or extend it.',
      input_schema: {
        type: 'object',
        properties: { id: { type: 'number' } },
        required: ['id'],
      },
    },
    {
      name: 'create_post',
      description: 'Create a blog post. Defaults to DRAFT — set status="publish" only when the human has approved publishing. Content is HTML.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          content: { type: 'string', description: 'HTML body' },
          excerpt: { type: 'string' },
          status: { type: 'string', description: 'draft (default) | publish' },
          categories: { type: 'array', items: { type: 'number' } },
          tags: { type: 'array', items: { type: 'number' } },
        },
        required: ['title', 'content'],
      },
    },
    {
      name: 'update_post',
      description: 'Update an existing post (title, content, excerpt or status). Read it first with get_post so you keep what should stay.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          title: { type: 'string' },
          content: { type: 'string' },
          excerpt: { type: 'string' },
          status: { type: 'string' },
        },
        required: ['id'],
      },
    },
    {
      name: 'list_pages',
      description: 'List the site\'s pages (home, services, about…).',
      input_schema: {
        type: 'object',
        properties: { search: { type: 'string' }, per_page: { type: 'number' } },
      },
    },
    {
      name: 'update_page',
      description: 'Update a page\'s title or HTML content — e.g. a homepage headline or a services description.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          title: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['id'],
      },
    },
    {
      name: 'list_categories',
      description: 'List post categories with their ids (needed when creating posts).',
      input_schema: { type: 'object', properties: {} },
    },
  ],

  call: async (tool, args, credential, siteUrl) => {
    if (!siteUrl) {
      throw new Error('No WordPress site URL configured for this connection.');
    }

    if (tool === 'list_posts') {
      const params = new URLSearchParams({
        per_page: String(Math.min(Number(args.per_page) || 10, 50)),
        status: String(args.status || 'publish'),
        ...(args.search ? { search: String(args.search) } : {}),
      });
      return JSON.stringify(slim(await wp(siteUrl, credential, `/posts?${params}`)));
    }

    if (tool === 'get_post') {
      const post = await wp(siteUrl, credential, `/posts/${Number(args.id)}?context=edit`) as Record<string, any>;
      return JSON.stringify({
        id: post.id,
        title: post.title?.raw ?? post.title?.rendered,
        status: post.status,
        link: post.link,
        content: String(post.content?.raw ?? post.content?.rendered ?? '').slice(0, MAX_BODY),
      });
    }

    if (tool === 'create_post') {
      const created = await wp(siteUrl, credential, '/posts', {
        method: 'POST',
        body: JSON.stringify({
          title: String(args.title ?? ''),
          content: String(args.content ?? ''),
          excerpt: args.excerpt ? String(args.excerpt) : undefined,
          status: String(args.status || 'draft'),
          categories: args.categories,
          tags: args.tags,
        }),
      }) as Record<string, any>;
      return JSON.stringify({
        id: created.id,
        status: created.status,
        link: created.link,
        note: created.status === 'draft'
          ? 'Saved as a DRAFT — nothing is live until it is published.'
          : 'Published live.',
      });
    }

    if (tool === 'update_post' || tool === 'update_page') {
      const type = tool === 'update_post' ? 'posts' : 'pages';
      const updated = await wp(siteUrl, credential, `/${type}/${Number(args.id)}`, {
        method: 'POST',
        body: JSON.stringify({
          ...(args.title !== undefined ? { title: String(args.title) } : {}),
          ...(args.content !== undefined ? { content: String(args.content) } : {}),
          ...(args.excerpt !== undefined ? { excerpt: String(args.excerpt) } : {}),
          ...(args.status !== undefined ? { status: String(args.status) } : {}),
        }),
      }) as Record<string, any>;
      return JSON.stringify({ id: updated.id, status: updated.status, link: updated.link, updated: true });
    }

    if (tool === 'list_pages') {
      const params = new URLSearchParams({
        per_page: String(Math.min(Number(args.per_page) || 20, 50)),
        ...(args.search ? { search: String(args.search) } : {}),
      });
      return JSON.stringify(slim(await wp(siteUrl, credential, `/pages?${params}`)));
    }

    if (tool === 'list_categories') {
      const cats = await wp(siteUrl, credential, '/categories?per_page=100') as Array<Record<string, any>>;
      return JSON.stringify(cats.map(c => ({ id: c.id, name: c.name, count: c.count })));
    }

    throw new Error(`Unknown WordPress tool: ${tool}`);
  },
};
