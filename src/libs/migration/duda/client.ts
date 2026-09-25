/**
 * Duda REST (Partner) API client — Phase 48, Part 1.
 *
 * ⚠️ This is NOT the Duda hosted MCP (`https://mcp.duda.co/mcp`, an MCP access
 * token) that the plugin catalog registers. The migration needs Duda's REST
 * Partner API (`https://api.duda.co/api/…`), which uses HTTP BASIC auth with an
 * API `username:password` pair — a different credential entirely. See
 * https://developer.duda.co — "Authentication & Security".
 *
 * Per-tenant credentials live in the `credentials` table under provider
 * `duda-api` (vault-sealed `cipher` = "user:pass"), the same pattern every
 * other per-workspace credential uses. `DUDA_API_USER` / `DUDA_API_PASS` env
 * vars are accepted as a dev/single-tenant fallback so extraction can be
 * exercised without seeding a credential row.
 *
 * Only the READ endpoints Phase 1 needs are implemented. Nothing here writes to
 * Duda — extraction is strictly read-only against the source site.
 */

import { and, eq, isNull, or } from 'drizzle-orm';
import { db } from '@/libs/DB';
import { openSecret } from '@/libs/vault';
import { credentials } from '@/models/Schema';

const DUDA_API_BASE = process.env.DUDA_API_BASE?.replace(/\/+$/, '') || 'https://api.duda.co/api';

/** The migration crawler's identity — descriptive, with a reference, never a browser UA. */
export const MIGRATION_USER_AGENT
  = 'ArtivioMigrationBot/1.0 (+https://artivio.ai; Duda→WordPress migration; contact support@artivio.ai)';

export type DudaCredential = { user: string; pass: string };

export class DudaApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'DudaApiError';
    this.status = status;
  }
}

/**
 * Resolve this tenant's Duda REST credential. Prefers a `credentials` row
 * (provider `duda-api`); falls back to a platform-level row (tenantId NULL) and
 * finally to env vars. Returns null when nothing is configured — the caller
 * turns that into a clear "connect Duda first" job failure.
 */
export async function resolveDudaCredential(tenantId: string): Promise<DudaCredential | null> {
  const rows = await db
    .select()
    .from(credentials)
    .where(and(
      eq(credentials.provider, 'duda-api'),
      or(eq(credentials.tenantId, tenantId), isNull(credentials.tenantId)),
    ));
  // A workspace-owned credential wins over a shared platform one.
  const row = rows.find(r => r.tenantId === tenantId) ?? rows[0];
  if (row) {
    try {
      const raw = openSecret(row.cipher);
      const idx = raw.indexOf(':');
      if (idx > 0) {
        return { user: raw.slice(0, idx), pass: raw.slice(idx + 1) };
      }
    } catch {
      // vault not configured or key rotated — fall through to env
    }
  }
  const user = process.env.DUDA_API_USER;
  const pass = process.env.DUDA_API_PASS;
  if (user && pass) {
    return { user, pass };
  }
  return null;
}

export class DudaClient {
  private authHeader: string;

  constructor(cred: DudaCredential) {
    this.authHeader = `Basic ${Buffer.from(`${cred.user}:${cred.pass}`, 'utf8').toString('base64')}`;
  }

  private async get<T>(path: string): Promise<T> {
    const url = `${DUDA_API_BASE}${path}`;
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': this.authHeader,
        'Accept': 'application/json',
        'User-Agent': MIGRATION_USER_AGENT,
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
      const body = (await resp.text().catch(() => '')).slice(0, 300);
      throw new DudaApiError(`Duda API ${resp.status} on ${path}: ${body}`, resp.status);
    }
    return resp.json() as Promise<T>;
  }

  /** Site details — canonical/preview URL + publish + store/booking status. */
  getSiteDetails(siteName: string): Promise<DudaSiteDetails> {
    return this.get<DudaSiteDetails>(`/sites/multiscreen/${encodeURIComponent(siteName)}`);
  }

  /** Page inventory (metadata only — no body content for classic sites). */
  listPages(siteName: string): Promise<DudaPage[]> {
    return this.get<DudaPage[]>(`/sites/multiscreen/${encodeURIComponent(siteName)}/pages`);
  }

  /** Global palette + typography, for the current-design doc. */
  getSiteTheme(siteName: string): Promise<DudaSiteTheme> {
    return this.get<DudaSiteTheme>(`/sites/multiscreen/${encodeURIComponent(siteName)}/theme`);
  }

  /** Business info: name, description, logo, hours, address, socials. */
  getContentLibrary(siteName: string): Promise<DudaContentLibrary> {
    return this.get<DudaContentLibrary>(`/sites/multiscreen/${encodeURIComponent(siteName)}/content`);
  }

  /** Navigation tree (used once, for the site nav in each page file). */
  getNavigation(siteName: string): Promise<DudaNavItem[]> {
    return this.get<DudaNavItem[]>(`/sites/multiscreen/${encodeURIComponent(siteName)}/navigation`);
  }

  /** Blog post ids + metadata (paginated by the caller if needed). */
  listBlogPosts(siteName: string): Promise<DudaBlogPostSummary[]> {
    return this.get<DudaBlogPostSummary[]>(`/sites/multiscreen/${encodeURIComponent(siteName)}/blog/posts`);
  }

  /** A single blog post WITH full body content (blogs, unlike pages, expose it). */
  getBlogPost(siteName: string, postId: string): Promise<DudaBlogPost> {
    return this.get<DudaBlogPost>(`/sites/multiscreen/${encodeURIComponent(siteName)}/blog/posts/${encodeURIComponent(postId)}`);
  }

  /** All collections on the site (names + schema; rows via getCollection). */
  listCollections(siteName: string): Promise<DudaCollectionSummary[]> {
    return this.get<DudaCollectionSummary[]>(`/sites/multiscreen/${encodeURIComponent(siteName)}/collection`);
  }

  /** One collection with its field values / rows. */
  getCollection(siteName: string, collectionName: string): Promise<DudaCollection> {
    return this.get<DudaCollection>(`/sites/multiscreen/${encodeURIComponent(siteName)}/collection/${encodeURIComponent(collectionName)}`);
  }
}

// ─── Response shapes ─────────────────────────────────────────────────────────
// Deliberately loose: Duda's API is stable but adds fields, and we only read a
// known subset. Everything the extractor reads is optional-guarded.

export type DudaSiteDetails = {
  site_name?: string;
  site_domain?: string;
  canonical_url?: string;
  preview_site_url?: string;
  publish_status?: string; // PUBLISHED | NOT_PUBLISHED_YET | UNPUBLISHED
  store_status?: string; // NONE | …
  booking?: { status?: string };
  [k: string]: unknown;
};

export type DudaPage = {
  uuid?: string;
  title?: string;
  path?: string;
  seo?: { title?: string; description?: string; no_index?: boolean };
  [k: string]: unknown;
};

export type DudaSiteTheme = {
  colors?: Array<{ label?: string; value?: string; role?: string }>;
  fonts?: unknown;
  typography?: unknown;
  buttons?: unknown;
  [k: string]: unknown;
};

export type DudaContentLibrary = {
  business_data?: {
    name?: string;
    description?: string;
    category?: string;
    logo_url?: string;
    phone_number?: string;
    phones?: Array<{ number?: string; label?: string }>;
    emails?: Array<{ address?: string; label?: string }>;
    address?: unknown;
    social_accounts?: Record<string, string>;
    business_hours?: unknown;
  };
  [k: string]: unknown;
};

export type DudaNavItem = {
  title?: string;
  label?: string;
  path?: string;
  pageId?: string;
  children?: DudaNavItem[];
  [k: string]: unknown;
};

export type DudaBlogPostSummary = {
  id?: string;
  post_id?: string;
  title?: string;
  slug?: string;
  status?: string;
  [k: string]: unknown;
};

export type DudaBlogPost = {
  id?: string;
  post_id?: string;
  title?: string;
  slug?: string;
  content?: string; // HTML body
  html?: string;
  author?: string;
  tags?: string[];
  categories?: string[];
  featured_image?: string | { url?: string; alt?: string };
  publish_date?: string;
  published_date?: string;
  created_date?: string;
  [k: string]: unknown;
};

export type DudaCollectionSummary = {
  name?: string;
  [k: string]: unknown;
};

export type DudaCollection = {
  name?: string;
  fields?: Array<{ name?: string; type?: string }>;
  values?: Array<Record<string, unknown>>;
  data?: Array<Record<string, unknown>>;
  [k: string]: unknown;
};
