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
    let code = '';
    let detail = '';
    try {
      const j = JSON.parse(text) as { message?: string; code?: string };
      code = j.code ?? '';
      detail = j.message ?? '';
    } catch { /* body wasn't JSON — the status alone carries the meaning */ }

    /**
     * 🔴 THE NUMERIC STATUS MUST SURVIVE INTO THE MESSAGE.
     *
     * `classifyToolError()` reads this string and recognises a client-fixable
     * fault by matching `\b401\b`, `\b403\b`, `\b404\b`, "not found",
     * "unauthorized"… This function used to REPLACE `HTTP 404` with
     * WordPress's own prose whenever the body carried a message — and
     * WordPress's prose for a wrong id is "Invalid post ID.", which matches
     * none of those patterns. So calling update_post with a PAGE id was
     * classified `platform`, escalated to the operator as an Artivio bug, and
     * the client was told "you don't need to do anything" about a one-word
     * fix. Identical defect, and identical fix, to elementor.ts's explain().
     */
    let msg = `HTTP ${resp.status}${code ? ` ${code}` : ''}${detail ? ` — ${detail}` : ''}`;

    if (resp.status === 401 || resp.status === 403) {
      msg += ' — check the username and Application Password, and that the user can edit posts.';
    }

    /**
     * The commonest id fault here is not an id fault at all. WordPress keeps
     * posts and pages in SEPARATE REST collections, so a perfectly valid page
     * id returns "Invalid post ID" from /posts. Nothing in that message hints
     * at the actual fix, so the caller re-verifies an id that was right all
     * along — which is exactly what happened on the True Therapy homepage.
     */
    if (code === 'rest_post_invalid_id' || /invalid post id/i.test(detail)) {
      const usedPages = path.startsWith('/pages');
      msg += ` — posts and pages are SEPARATE collections in WordPress, and this call hit /${usedPages ? 'pages' : 'posts'}. If the id came from list_pages, use update_page; if it came from list_posts, use update_post. The id itself is probably fine.`;
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

  guidance: `WordPress connection:
- Posts and pages are SEPARATE REST collections. A valid page id passed to update_post returns "Invalid post ID" — the id is fine, the tool is wrong. Ids from list_pages go to update_page; ids from list_posts go to update_post.
- If this site ALSO has an Elementor connection, any page whose builtWithElementor is true must be edited through the Elementor tools. update_page writes post_content, and Elementor renders from its own stored layout and ignores post_content — so the call succeeds, the result looks clean, and the live page does not change.
- create_post makes a BLOG POST and cannot make a page. For a page use create_page — or, if the site has an Elementor connection and the page needs a designed layout, create_elementor_page there. Check the "type" field in the result; it states what was actually created.
- To remove something, use trash_content. WordPress has no "trash" STATUS — passing status="trash" to an update returns a 400. Nothing here can permanently delete; trashed items stay recoverable.
- create_post and create_page default to draft. Publishing is a human decision; do not set status="publish" unless someone asked for it in this conversation.`,

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
      description: 'Create a blog POST — a dated entry that appears in the blog feed. This cannot create a page: for a page use create_page, or create_elementor_page if the site has an Elementor connection and the page needs a built layout. Defaults to DRAFT; set status="publish" only when a human has approved publishing. Content is HTML.',
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
      /**
       * Added because its absence was invisible. create_post is the only
       * creation tool a model sees when it wants "a new page", so it used that,
       * got a 200 and a real id back, and produced a blog post on a client site
       * — with nothing anywhere in the result saying otherwise. A separate tool
       * beats a `type` argument on create_post: an argument can be forgotten and
       * silently defaults to the wrong thing, which is the same failure again.
       */
      name: 'create_page',
      description: 'Create a PAGE — a standalone page like About, Services or a landing page, not part of the blog feed. Defaults to DRAFT; set status="publish" only when a human has approved publishing. Content is HTML. If the site has an Elementor connection and this page needs a designed layout rather than plain HTML, use create_elementor_page there instead — a page created here renders its HTML through the theme, not through Elementor.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          content: { type: 'string', description: 'HTML body' },
          excerpt: { type: 'string' },
          status: { type: 'string', description: 'draft (default) | publish' },
          slug: { type: 'string', description: 'URL slug. Keep it short — "get-started" beats a full sentence.' },
          parent: { type: 'number', description: 'Parent page id, for a nested URL.' },
        },
        required: ['title', 'content'],
      },
    },
    {
      /**
       * WordPress has no "trash" STATUS — trashing is a DELETE, and passing
       * status:"trash" to the update endpoint returns a 400 that reads like a
       * platform fault. Without this tool the agent had no correct move at all,
       * so it kept trying the wrong one.
       */
      name: 'trash_content',
      description: 'Move a post or page to the WordPress trash. Reversible — the item stays in Trash until someone empties it, and nothing here can permanently delete. Use this instead of trying to set status="trash", which WordPress rejects: trashing is a delete operation, not a status change.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          type: { type: 'string', description: 'page | post (default post). Must match where the id came from — posts and pages are separate collections.' },
        },
        required: ['id'],
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

    if (tool === 'create_post' || tool === 'create_page') {
      const isPage = tool === 'create_page';
      const created = await wp(siteUrl, credential, isPage ? '/pages' : '/posts', {
        method: 'POST',
        body: JSON.stringify({
          title: String(args.title ?? ''),
          content: String(args.content ?? ''),
          excerpt: args.excerpt ? String(args.excerpt) : undefined,
          status: String(args.status || 'draft'),
          ...(isPage
            ? {
                ...(args.slug ? { slug: String(args.slug) } : {}),
                ...(args.parent ? { parent: Number(args.parent) } : {}),
              }
            : { categories: args.categories, tags: args.tags }),
        }),
      }) as Record<string, any>;
      return JSON.stringify({
        id: created.id,
        // State the type back explicitly. The whole failure this fixes was a
        // result that looked like a success and never mentioned it had made
        // the wrong KIND of thing.
        type: isPage ? 'page' : 'post',
        status: created.status,
        slug: created.slug,
        link: created.link,
        note: created.status === 'draft'
          ? `Saved as a DRAFT ${isPage ? 'page' : 'post'} — nothing is live until it is published.`
          : `Published live as a ${isPage ? 'page' : 'post'}.`,
      });
    }

    if (tool === 'trash_content') {
      const type = String(args.type ?? 'post').toLowerCase() === 'page' ? 'pages' : 'posts';
      // No `force` parameter is exposed anywhere: WordPress permanently deletes
      // on force=true, and an agent should not hold that. Trash is reversible;
      // emptying it is a human decision made in wp-admin.
      const trashed = await wp(siteUrl, credential, `/${type}/${Number(args.id)}`, {
        method: 'DELETE',
      }) as Record<string, any>;
      return JSON.stringify({
        id: Number(args.id),
        type: type === 'pages' ? 'page' : 'post',
        trashed: true,
        status: trashed?.status ?? trashed?.previous?.status ?? 'trash',
        note: 'Moved to Trash and recoverable from WordPress Admin → Trash. Not permanently deleted.',
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
