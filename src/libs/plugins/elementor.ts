/**
 * Elementor — built-in provider (per-site, bring-your-own credential).
 *
 * WHY THIS IS NOT LIKE THE WORDPRESS PROVIDER NEXT DOOR
 * Divi keeps its layout in `post_content`, which core WP REST already exposes —
 * that's why DiviOps works with nothing but a URL and an Application Password.
 * Elementor keeps the entire page in `_elementor_data`, a postmeta key whose
 * leading underscore makes it PROTECTED: core REST will not read it and will not
 * write it, on any site, ever, no matter what credential you hold. Through the
 * plain WordPress connection an Elementor page looks like an empty post.
 *
 * So this provider talks to a small companion plugin that has to be installed on
 * each client site: `wordpress-plugins/artivio-elementor-agent/`. It registers
 * routes under /wp-json/artivio-elementor/v1, authenticated by the SAME
 * Application Password the WordPress and DiviOps connections use.
 *
 * WHY BUILT-IN AND NOT STDIO (the DiviOps pattern)
 * stdio exists to host a THIRD-PARTY npm server whose schemas someone else
 * maintains — that's the whole return on a pinned dependency, a child process
 * and a pool slot. No Elementor server of that maturity exists, and every
 * candidate still needs a site-side plugin, so stdio would buy nothing and cost
 * a process. Same reasoning as "why not a custom Kie MCP server" (ADR #3b).
 *
 * Per-connection config (stored on the mcp_connection, not the catalog):
 *   url        = the site, e.g. https://clientsite.com
 *   credential = "username:application password"  (sealed in the vault)
 */

import type { BuiltinProvider } from '@/libs/plugins/types';

/** Element settings can legitimately be large; this is the per-response ceiling. */
const MAX_BODY = 160_000;
const TIMEOUT_MS = 45_000;

function auth(credential: string): string {
  // Same convention as the WordPress built-in: "user:application password".
  return `Basic ${Buffer.from(credential.replace(/\s+/g, ' ').trim()).toString('base64')}`;
}

/**
 * The companion plugin's own namespace. A 404 here almost always means the
 * plugin isn't installed rather than "no such page", so the error is rewritten
 * to say the thing an operator can act on — see `explain()`.
 */
async function ea(
  siteUrl: string,
  credential: string,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  return request(siteUrl, credential, `/artivio-elementor/v1${path}`, init);
}

/** Core WP REST — used only for publishing, which is not Elementor's business. */
async function core(
  siteUrl: string,
  credential: string,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  return request(siteUrl, credential, `/wp/v2${path}`, init);
}

async function request(
  siteUrl: string,
  credential: string,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const base = siteUrl.replace(/\/$/, '');
  let resp: Response;
  try {
    resp = await fetch(`${base}/wp-json${path}`, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'Authorization': auth(credential),
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new TypeError(`Elementor: could not reach ${base} — ${msg}`);
  }

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Elementor: ${explain(resp.status, text, path)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Turn a WordPress error body into something an operator can act on.
 *
 * The one that matters is `rest_no_route`. Without this branch the agent sees
 * "404" against a URL that plainly exists, decides the page id is wrong, and
 * burns a turn guessing — when the real answer is a plugin nobody installed.
 * Phase 24's lesson: when the platform is the thing that's missing, say so
 * instead of letting the agent take the blame.
 */
function explain(status: number, body: string, path: string): string {
  let code = '';
  let message = `HTTP ${status}`;
  try {
    const j = JSON.parse(body) as { message?: string; code?: string };
    code = j.code ?? '';
    if (j.message) {
      message = `${j.message}${code ? ` (${code})` : ''}`;
    }
  } catch { /* keep the status */ }

  if (status === 404 && (code === 'rest_no_route' || code === '')) {
    return `${message} — the artivio-elementor-agent plugin is not installed or not active on this site. Elementor layouts live in the protected \`_elementor_data\` postmeta, which core WordPress REST cannot expose, so this connection cannot work until that plugin is activated in wp-admin → Plugins. This is a one-time site setup step; nothing about the credential or the page id is wrong.`;
  }
  if (status === 401 || status === 403) {
    return `${message} — check the username and Application Password, and that the user has the Editor role on this site.`;
  }
  if (status === 409) {
    return `${message} — the site answered, so the plugin is installed; Elementor itself may be inactive or the site has no Elementor kit yet.`;
  }
  return `${message} (${path})`;
}

/** Keep a response inside the model's budget, and say so when it's cut. */
function bounded(value: unknown, hint: string): string {
  const json = JSON.stringify(value);
  if (json.length <= MAX_BODY) {
    return json;
  }
  return JSON.stringify({
    truncated: true,
    bytes: json.length,
    limit: MAX_BODY,
    hint,
    preview: `${json.slice(0, 2000)}…`,
  });
}

function requireId(args: Record<string, unknown>, key = 'page_id'): number {
  const id = Number(args[key]);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`Elementor: \`${key}\` must be a WordPress post id (a positive integer). Use list_elementor_pages to find it.`);
  }
  return id;
}

function requireElement(args: Record<string, unknown>): string {
  const el = String(args.element_id ?? '').trim();
  if (!el) {
    throw new Error('Elementor: `element_id` is required. Use get_page_outline to see the element ids on a page.');
  }
  return el;
}

export const elementorProvider: BuiltinProvider = {
  slug: 'elementor',
  name: 'Elementor',
  description:
    'Read and edit Elementor page layouts on a WordPress site — sections, containers and widgets, plus reusable templates and the global colour/font kit. Requires the artivio-elementor-agent companion plugin on the site (Elementor\'s layout data is not reachable through core WordPress REST).',
  credentialLabel:
    'WordPress username + Application Password, as "username:xxxx xxxx xxxx xxxx" (WP Admin → Users → Profile → Application Passwords). Use an Editor account, not an Administrator.',
  perConnection: true,
  // Phase 30.1: say what the target actually is. Here it IS a site URL, so
  // targetIsUrl stays at its default — but the labels still get spelled out
  // rather than inherited from whatever the form happens to hardcode.
  targetLabel: 'The WordPress site URL',
  targetPlaceholder: 'https://clientsite.com',

  tools: [
    {
      name: 'elementor_status',
      description: 'Check the site: is the artivio-elementor-agent plugin active, which Elementor version, is Pro installed, which global kit is active. Call this FIRST on a site you have not touched before — every other tool fails the same way if the plugin is missing.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'list_elementor_pages',
      description: 'List pages, posts and library templates on the site, newest-modified first, each flagged with whether it is built with Elementor.',
      input_schema: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          type: { type: 'string', description: 'page | post | elementor_library | any (default any)' },
          per_page: { type: 'number', description: 'Max 100, default 25' },
        },
      },
    },
    {
      name: 'get_page_outline',
      description: 'The structure of one page as a compact tree: element ids, element types, widget types and a short text label for each. This is the tool to reach for when finding what to edit — it is a fraction of the size of the raw layout.',
      input_schema: {
        type: 'object',
        properties: {
          page_id: { type: 'number' },
          depth: { type: 'number', description: 'How many levels deep, 1–12. Default 6.' },
        },
        required: ['page_id'],
      },
    },
    {
      name: 'get_element',
      description: 'Full settings for ONE element, found via get_page_outline. Read this before updating so you keep the settings you are not changing.',
      input_schema: {
        type: 'object',
        properties: {
          page_id: { type: 'number' },
          element_id: { type: 'string', description: 'The 7-character id from get_page_outline' },
        },
        required: ['page_id', 'element_id'],
      },
    },
    {
      name: 'update_element',
      description: 'Change settings on one element — text, colours, spacing, links. Settings are MERGED into what is already there, so send only the keys you are changing. Use get_widget_schema first if you are unsure what a control is called.',
      input_schema: {
        type: 'object',
        properties: {
          page_id: { type: 'number' },
          element_id: { type: 'string' },
          settings: { type: 'object', description: 'Control keys to set, e.g. { "title": "New headline", "align": "center" }' },
          replace: { type: 'boolean', description: 'Danger: true discards every setting not listed. Leave unset for a merge.' },
        },
        required: ['page_id', 'element_id', 'settings'],
      },
    },
    {
      name: 'add_element',
      description: 'Insert a new section, container or widget. Omit parent_id to add at the top level of the page. Ids are assigned by the site — never invent them.',
      input_schema: {
        type: 'object',
        properties: {
          page_id: { type: 'number' },
          parent_id: { type: 'string', description: 'Element id to nest inside. Omit for the top level of the page.' },
          index: { type: 'number', description: 'Position among siblings, 0-based. Omit to append.' },
          element: {
            type: 'object',
            description: 'e.g. { "elType": "widget", "widgetType": "heading", "settings": { "title": "Hello" } } or { "elType": "container", "settings": {}, "elements": [] }',
          },
        },
        required: ['page_id', 'element'],
      },
    },
    {
      name: 'move_element',
      description: 'Move an element to a different parent and/or position. Omit parent_id to move it to the top level of the page.',
      input_schema: {
        type: 'object',
        properties: {
          page_id: { type: 'number' },
          element_id: { type: 'string' },
          parent_id: { type: 'string' },
          index: { type: 'number', description: '0-based position among siblings. Omit to append.' },
        },
        required: ['page_id', 'element_id'],
      },
    },
    {
      name: 'duplicate_element',
      description: 'Copy an element (and everything inside it) directly after itself, with fresh ids throughout. The fast way to add a fourth card to a row of three.',
      input_schema: {
        type: 'object',
        properties: {
          page_id: { type: 'number' },
          element_id: { type: 'string' },
        },
        required: ['page_id', 'element_id'],
      },
    },
    {
      name: 'delete_element',
      description: 'Remove an element and everything inside it. There is no undo through this API — read it with get_element first if it may need to be restored.',
      input_schema: {
        type: 'object',
        properties: {
          page_id: { type: 'number' },
          element_id: { type: 'string' },
        },
        required: ['page_id', 'element_id'],
      },
    },
    {
      name: 'list_widgets',
      description: 'Every widget type registered on THIS site right now — core, Pro and any third-party addon. Use it instead of assuming a widget exists.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'get_widget_schema',
      description: 'The real control keys, types, defaults and allowed values for one widget type, read live from the site. Call this before writing settings for a widget you have not edited before — a guessed key is accepted silently and renders nothing.',
      input_schema: {
        type: 'object',
        properties: {
          widget: { type: 'string', description: 'A widget name from list_widgets, e.g. "heading", "button", "image"' },
        },
        required: ['widget'],
      },
    },
    {
      name: 'list_templates',
      description: 'Saved Elementor library templates on the site — sections, pages, headers, footers, popups.',
      input_schema: {
        type: 'object',
        properties: { per_page: { type: 'number', description: 'Max 100, default 50' } },
      },
    },
    {
      name: 'apply_template',
      description: 'Copy a saved template into a page. Defaults to appending it at the end; mode="replace" discards the page\'s current layout entirely.',
      input_schema: {
        type: 'object',
        properties: {
          page_id: { type: 'number' },
          template_id: { type: 'number' },
          mode: { type: 'string', description: 'append (default) | prepend | replace' },
        },
        required: ['page_id', 'template_id'],
      },
    },
    {
      name: 'get_global_styles',
      description: 'The site\'s Elementor global kit — system and custom colours, typography, container width. Read this before styling anything so new work matches the existing brand.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'update_global_styles',
      description: 'Change the global kit. This restyles EVERY page on the site at once, so treat it as a brand-level decision, not a page tweak.',
      input_schema: {
        type: 'object',
        properties: {
          settings: {
            type: 'object',
            description: 'Kit keys to merge, e.g. { "system_colors": [ { "_id": "primary", "title": "Primary", "color": "#1A73E8" } ] }. Read get_global_styles first and send the full array for any key you change.',
          },
        },
        required: ['settings'],
      },
    },
    {
      name: 'create_elementor_page',
      description: 'Create a new page built with Elementor. Always created as a DRAFT — a human publishes it. Pass `tree` to build the layout in one call instead of many add_element calls.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          type: { type: 'string', description: 'page (default) | post' },
          tree: {
            type: 'array',
            description: 'Top-level Elementor elements. Omit ids — the site assigns them.',
            items: { type: 'object' },
          },
        },
        required: ['title'],
      },
    },
    {
      name: 'get_page_tree',
      description: 'The complete raw Elementor layout for a page. Large — a real page runs to hundreds of KB. Prefer get_page_outline plus get_element; reach for this only when you need to rewrite the whole layout.',
      input_schema: {
        type: 'object',
        properties: { page_id: { type: 'number' } },
        required: ['page_id'],
      },
    },
    {
      name: 'set_page_tree',
      description: 'Replace a page\'s ENTIRE Elementor layout. Everything currently on the page is discarded. Use for building a page from scratch; for edits use update_element.',
      input_schema: {
        type: 'object',
        properties: {
          page_id: { type: 'number' },
          tree: { type: 'array', description: 'Top-level Elementor elements', items: { type: 'object' } },
        },
        required: ['page_id', 'tree'],
      },
    },
    {
      name: 'set_page_status',
      description: 'Publish or unpublish a page. Publishing puts work in front of the client\'s visitors — only do it when a human has said to.',
      input_schema: {
        type: 'object',
        properties: {
          page_id: { type: 'number' },
          status: { type: 'string', description: 'publish | draft | private' },
          type: { type: 'string', description: 'page (default) | post' },
        },
        required: ['page_id', 'status'],
      },
    },
  ],

  call: async (tool, args, credential, siteUrl): Promise<string> => {
    if (!siteUrl) {
      throw new Error('No WordPress site URL configured for this Elementor connection.');
    }
    const get = (path: string) => ea(siteUrl, credential, path);
    const send = (path: string, method: string, body: unknown) =>
      ea(siteUrl, credential, path, { method, body: JSON.stringify(body) });

    switch (tool) {
      case 'elementor_status': {
        const status = await get('/status') as Record<string, unknown>;
        return JSON.stringify({
          ...status,
          ready: Boolean(status.ok) && Boolean(status.elementorActive),
        });
      }

      case 'list_elementor_pages': {
        const params = new URLSearchParams({
          per_page: String(Math.min(Number(args.per_page) || 25, 100)),
          ...(args.type ? { type: String(args.type) } : {}),
          ...(args.search ? { search: String(args.search) } : {}),
        });
        return bounded(await get(`/documents?${params}`), 'Narrow it with `search`, or lower `per_page`.');
      }

      case 'get_page_outline': {
        const depth = Math.min(12, Math.max(1, Number(args.depth) || 6));
        return bounded(
          await get(`/documents/${requireId(args)}/outline?depth=${depth}`),
          'This page is very large — call it again with a smaller `depth`, then drill in.',
        );
      }

      case 'get_element':
        return bounded(
          await get(`/documents/${requireId(args)}/elements/${encodeURIComponent(requireElement(args))}`),
          'This element\'s settings are unusually large.',
        );

      case 'update_element': {
        if (typeof args.settings !== 'object' || args.settings === null || Array.isArray(args.settings)) {
          throw new TypeError('Elementor: `settings` must be an object of control keys, e.g. { "title": "New headline" }.');
        }
        return JSON.stringify(await send(
          `/documents/${requireId(args)}/elements/${encodeURIComponent(requireElement(args))}`,
          'PATCH',
          { settings: args.settings, replace: Boolean(args.replace) },
        ));
      }

      case 'add_element': {
        if (typeof args.element !== 'object' || args.element === null) {
          throw new TypeError('Elementor: `element` must be an Elementor element object with at least an `elType`.');
        }
        return JSON.stringify(await send(`/documents/${requireId(args)}/elements`, 'POST', {
          element: args.element,
          parentId: args.parent_id ? String(args.parent_id) : undefined,
          index: args.index === undefined ? undefined : Number(args.index),
        }));
      }

      case 'move_element':
        return JSON.stringify(await send(
          `/documents/${requireId(args)}/elements/${encodeURIComponent(requireElement(args))}/move`,
          'POST',
          {
            parentId: args.parent_id ? String(args.parent_id) : undefined,
            index: args.index === undefined ? undefined : Number(args.index),
          },
        ));

      case 'duplicate_element':
        return JSON.stringify(await send(
          `/documents/${requireId(args)}/elements/${encodeURIComponent(requireElement(args))}/duplicate`,
          'POST',
          {},
        ));

      case 'delete_element':
        return JSON.stringify(await ea(
          siteUrl,
          credential,
          `/documents/${requireId(args)}/elements/${encodeURIComponent(requireElement(args))}`,
          { method: 'DELETE' },
        ));

      case 'list_widgets':
        return bounded(await get('/widgets'), 'This site has an unusual number of widget addons.');

      case 'get_widget_schema': {
        const widget = String(args.widget ?? '').trim();
        if (!widget) {
          throw new Error('Elementor: `widget` is required — call list_widgets for the names this site actually has.');
        }
        return bounded(
          await get(`/widgets/${encodeURIComponent(widget)}/schema`),
          'This widget has a very large control set; the essential keys are in the preview.',
        );
      }

      case 'list_templates':
        return bounded(
          await get(`/templates?per_page=${Math.min(Number(args.per_page) || 50, 100)}`),
          'Lower `per_page`.',
        );

      case 'apply_template':
        return JSON.stringify(await send(`/documents/${requireId(args)}/apply-template`, 'POST', {
          templateId: requireId(args, 'template_id'),
          mode: args.mode ? String(args.mode) : 'append',
        }));

      case 'get_global_styles':
        return bounded(await get('/kit'), 'This kit is unusually large.');

      case 'update_global_styles': {
        if (typeof args.settings !== 'object' || args.settings === null || Array.isArray(args.settings)) {
          throw new TypeError('Elementor: `settings` must be an object of kit keys.');
        }
        const result = await send('/kit', 'PATCH', { settings: args.settings }) as Record<string, unknown>;
        return JSON.stringify({
          ...result,
          note: 'Global kit changed — this affects every page on the site. Elementor\'s CSS cache was flushed site-wide.',
        });
      }

      case 'create_elementor_page': {
        const created = await send('/documents', 'POST', {
          title: String(args.title ?? 'Untitled'),
          type: args.type === 'post' ? 'post' : 'page',
          tree: Array.isArray(args.tree) ? args.tree : [],
        }) as Record<string, unknown>;
        return JSON.stringify(created);
      }

      case 'get_page_tree':
        return bounded(
          await get(`/documents/${requireId(args)}/tree`),
          'This layout is too large to return whole. Use get_page_outline to navigate it and get_element to read one piece at a time.',
        );

      case 'set_page_tree': {
        if (!Array.isArray(args.tree)) {
          throw new TypeError('Elementor: `tree` must be an array of top-level Elementor elements.');
        }
        const replaced = await ea(siteUrl, credential, `/documents/${requireId(args)}/tree`, {
          method: 'PUT',
          body: JSON.stringify({ tree: args.tree }),
        }) as Record<string, unknown>;
        return JSON.stringify({
          ...replaced,
          note: 'The page\'s previous layout was discarded and cannot be recovered through this API.',
        });
      }

      case 'set_page_status': {
        const status = String(args.status ?? '');
        if (!['publish', 'draft', 'private'].includes(status)) {
          throw new Error('Elementor: `status` must be publish, draft or private.');
        }
        const type = args.type === 'post' ? 'posts' : 'pages';
        const updated = await core(siteUrl, credential, `/${type}/${requireId(args)}`, {
          method: 'POST',
          body: JSON.stringify({ status }),
        }) as Record<string, any>;
        return JSON.stringify({
          id: updated.id,
          status: updated.status,
          link: updated.link,
          note: updated.status === 'publish' ? 'This page is now LIVE.' : `Status set to ${updated.status}.`,
        });
      }

      default:
        throw new Error(`Unknown Elementor tool: ${tool}`);
    }
  },
};
