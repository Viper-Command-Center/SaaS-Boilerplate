/**
 * Registry of built-in providers (services with no hosted MCP server).
 * Adding one = write an adapter here; it appears in the admin catalog's
 * provider dropdown immediately.
 */

import type { BuiltinProvider } from '@/libs/plugins/types';
import { agentcoreBrowserProvider } from '@/libs/plugins/agentcoreBrowser';
import { cloudflareAnalyticsProvider } from '@/libs/plugins/cloudflareAnalytics';
import { cloudflareDnsProvider } from '@/libs/plugins/cloudflareDns';
import { dataforseoProvider } from '@/libs/plugins/dataforseo';
import { elementorProvider } from '@/libs/plugins/elementor';
import { githubProvider } from '@/libs/plugins/github';
import { googleAnalyticsProvider } from '@/libs/plugins/googleAnalytics';
import { heygenProvider } from '@/libs/plugins/heygen';
import { kieProvider } from '@/libs/plugins/kie';
import { postgresProvider } from '@/libs/plugins/postgres';
import { postmarkProvider } from '@/libs/plugins/postmark';
import { smartermailProvider } from '@/libs/plugins/smartermail';
import { whmcsProvider } from '@/libs/plugins/whmcs';
import { wordpressProvider } from '@/libs/plugins/wordpress';

export const BUILTIN_PROVIDERS: Record<string, BuiltinProvider> = {
  [kieProvider.slug]: kieProvider,
  [wordpressProvider.slug]: wordpressProvider,
  [agentcoreBrowserProvider.slug]: agentcoreBrowserProvider,
  [heygenProvider.slug]: heygenProvider,
  [cloudflareAnalyticsProvider.slug]: cloudflareAnalyticsProvider,
  [cloudflareDnsProvider.slug]: cloudflareDnsProvider,
  [googleAnalyticsProvider.slug]: googleAnalyticsProvider,
  [elementorProvider.slug]: elementorProvider,
  [dataforseoProvider.slug]: dataforseoProvider,
  [whmcsProvider.slug]: whmcsProvider,
  [smartermailProvider.slug]: smartermailProvider,
  [postmarkProvider.slug]: postmarkProvider,
  [postgresProvider.slug]: postgresProvider,
  [githubProvider.slug]: githubProvider,
};

export function getBuiltinProvider(slug: string): BuiltinProvider | undefined {
  return BUILTIN_PROVIDERS[slug];
}

/** For the admin UI: what can be added as a built-in plugin. */
export function listBuiltinProviders() {
  return Object.values(BUILTIN_PROVIDERS).map(p => ({
    slug: p.slug,
    name: p.name,
    description: p.description,
    credentialLabel: p.credentialLabel,
    perConnection: Boolean(p.perConnection),
    multiKey: Boolean(p.multiKey),
    noCredential: Boolean(p.noCredential),
    usageMetering: p.usageMetering ?? null,
    targetLabel: p.targetLabel ?? null,
    targetPlaceholder: p.targetPlaceholder ?? null,
    targetIsUrl: p.targetIsUrl !== false,
    tools: p.tools.map(t => ({
      name: t.name,
      description: t.description,
      meteredArg: t.meteredArg,
    })),
  }));
}

/**
 * Ready-made catalog entries the admin can add in one click. These are just
 * form pre-fills — nothing is hardcoded into the platform.
 */
export const CATALOG_PRESETS = [
  {
    key: 'agentcore-browser',
    label: 'Cloud browser (AWS)',
    entry: {
      slug: 'agentcore-browser',
      name: 'Cloud browser',
      description: 'A real Chrome in AWS — reads JavaScript-rendered pages and operates web apps that have no API. Billed per second of browser time.',
      category: 'data',
      transport: 'builtin' as const,
      provider: 'agentcore-browser',
      // No credential: it uses the platform AWS keys Bedrock already uses.
      authHint: 'No key needed — it authenticates with the platform AWS credentials.',
    },
  },
  {
    key: 'firecrawl',
    label: 'Firecrawl (web search + scrape)',
    entry: {
      slug: 'firecrawl',
      name: 'Firecrawl',
      description: 'Search the web and read any page as clean markdown — including JavaScript-rendered sites that fetch_url cannot see.',
      category: 'data',
      transport: 'http' as const,
      // The API key goes in the URL PATH, so this is a TEMPLATE: `{key}` is
      // replaced at call time with the vaulted secret (see applyUrlSecret).
      // The key is never written to the connections table in plaintext.
      url: 'https://mcp.firecrawl.dev/{key}/v2/mcp',
      authHeader: 'url', // reserved: substitute into the URL, don't send a header
      authHint: 'Your Firecrawl API key (fc-…) from firecrawl.dev. It is stored encrypted and injected into the request URL at call time.',
    },
  },
  {
    key: 'zernio',
    label: 'Zernio (social media)',
    entry: {
      slug: 'zernio',
      name: 'Zernio',
      description: 'Schedule and publish social posts across 14+ platforms, plus analytics, inbox and ads.',
      category: 'marketing',
      transport: 'http' as const,
      // Streamable HTTP endpoint. Zernio also offers OAuth via Claude's own
      // Connectors UI — irrelevant here; server-to-server uses the API key.
      url: 'https://mcp.zernio.com/mcp',
      authHeader: 'Authorization',
      // The `Bearer ` prefix is REQUIRED and is the usual cause of Zernio's
      // `401 invalid_token` — pasting the bare key silently fails.
      authHint: 'Bearer <your API key> from zernio.com/dashboard/api-keys. Keep the "Bearer " prefix — without it Zernio returns 401 invalid_token.',
    },
  },
  {
    key: 'duda',
    label: 'Duda (websites)',
    entry: {
      slug: 'duda',
      name: 'Duda',
      description: 'Build and manage Duda websites — pages, content, publishing.',
      category: 'dev',
      transport: 'http' as const,
      url: 'https://mcp.duda.co/mcp',
      authHeader: 'Authorization',
      authHint: 'Your Duda MCP Access Token (Duda dashboard → Account Settings → MCP).',
    },
  },
  {
    key: 'google-analytics',
    label: 'Google Analytics 4 + Search Console',
    entry: {
      slug: 'google-analytics',
      name: 'Google Analytics + Search Console',
      description: 'GA4 traffic, engagement and conversions, plus the Search Console queries a site ranks for. Read-only, and free — Google does not bill these APIs.',
      category: 'data',
      transport: 'builtin' as const,
      provider: 'google-analytics',
      // Per-connection: the workspace supplies its own GA4 property ID (in the
      // connection's site/URL field) and its own service account JSON.
      authHint: 'The WHOLE service account JSON key file. Cloud Console → IAM → Service Accounts → Keys → Add key (JSON). Then grant that service account email Viewer on the GA4 property, and add it as a user in Search Console → Settings → Users and permissions. Do NOT use an OAuth client ID: a consent screen in "Testing" issues refresh tokens that expire after 7 days, which would silently blind the agent every week.',
    },
  },
  {
    key: 'dataforseo',
    label: 'DataForSEO (keyword + SERP research)',
    entry: {
      slug: 'dataforseo',
      name: 'DataForSEO',
      description: 'Real search data for deciding what to write and how to rank — keyword volume, CPC and difficulty, keyword ideas and long-tail suggestions, live Google SERPs, what a domain already ranks for, and its organic competitors.',
      category: 'data',
      transport: 'builtin' as const,
      provider: 'dataforseo',
      // Set Tier 1 in the Add-plugin form: this is OUR DataForSEO account,
      // metered per call and billed on at the markup. Tier is chosen there
      // rather than here, as with every other preset — these entries are form
      // pre-fills, not configuration.
      authHint: 'Your DataForSEO API login and password as "email:password", from dataforseo.com → API Access → API CREDENTIALS. The pre-encoded Base64 blob on that same page also works. This is the API password, NOT your dashboard login password.',
    },
  },
  {
    key: 'wordpress',
    label: 'WordPress (any site)',
    entry: {
      slug: 'wordpress',
      name: 'WordPress',
      description: 'Publish and edit posts and pages on a WordPress site.',
      category: 'dev',
      transport: 'builtin' as const,
      provider: 'wordpress',
      authHint: 'username:application password — create one in WP Admin → Users → Profile → Application Passwords.',
    },
  },
  {
    key: 'elementor',
    label: 'Elementor (WordPress page builder)',
    entry: {
      slug: 'elementor',
      name: 'Elementor',
      description: 'Read and edit Elementor layouts on a WordPress site — sections, containers, widgets, saved templates and the global colour/font kit.',
      category: 'dev',
      transport: 'builtin' as const,
      provider: 'elementor',
      // Built-in, NOT stdio. Elementor's layout lives in the protected
      // `_elementor_data` postmeta, so no transport reaches it without code on
      // the site — and once a site plugin is required anyway, a third-party
      // stdio server buys nothing and costs a child process. See the header of
      // src/libs/plugins/elementor.ts.
      authHint: 'username:application password — create one in WP Admin → Users → Profile → Application Passwords (use an Editor account). ⚠️ The site must ALSO have the artivio-elementor-agent plugin installed and active — it is in wordpress-plugins/artivio-elementor-agent/ in this repo. Without it every tool returns a 404, because core WordPress REST cannot read Elementor layout data. You will be asked for the site URL when enabling.',
    },
  },
  {
    key: 'heygen',
    label: 'HeyGen (AI avatar video)',
    entry: {
      slug: 'heygen',
      name: 'HeyGen',
      description: 'Generate talking-avatar / spokesperson videos from a script. Async render; billed by HeyGen against the plan that owns the API key.',
      category: 'marketing',
      transport: 'builtin' as const,
      provider: 'heygen',
      // Built-in provider (REST API, X-Api-Key). HeyGen's hosted MCP is
      // OAuth-only and Artivio's MCP client sends static headers only, so the
      // remote MCP URL 401s — the REST adapter is the supported path.
      authHint: 'Your HeyGen API key from app.heygen.com → Settings → API. Paste the raw key (no "Bearer" prefix); it is sent as the X-Api-Key header.',
    },
  },
  {
    key: 'cloudflare-analytics',
    label: 'Cloudflare Web Analytics (site traffic)',
    entry: {
      slug: 'cloudflare-analytics',
      name: 'Cloudflare Analytics',
      description: 'Near-realtime site traffic — page views, visits, top pages, referrers, countries, devices — from Cloudflare Web Analytics.',
      category: 'data',
      transport: 'builtin' as const,
      provider: 'cloudflare-analytics',
      // Per-connection: the connection URL field holds "<accountTag>/<siteTag>",
      // the credential is a CF API token with Account Analytics : Read.
      authHint: 'Connection URL = "<accountTag>/<siteTag>" (Account ID + Web Analytics site tag). Credential = a Cloudflare API token with Account Analytics : Read.',
    },
  },
  {
    key: 'diviops',
    label: 'DiviOps (Divi 5 websites)',
    entry: {
      slug: 'diviops',
      name: 'DiviOps',
      description: 'Author and manage Divi 5 WordPress sites — pages, sections, modules, templates, presets, rendered previews. Draft-first, with dry-run on every write tool.',
      category: 'dev',
      // stdio: a bundled MCP server (@diviops/mcp-server) spawned as a child
      // process — see src/libs/mcp/stdioCatalog.ts (the allowlist) and
      // stdioClient.ts (the transport). Per-connection like WordPress.
      transport: 'stdio' as const,
      provider: 'diviops',
      authHeader: 'credential',
      authHint: 'username:application password for the client\'s WordPress site (WP Admin → Users → Profile → Application Passwords). The site must also have the diviops-agent WordPress plugin installed. You\'ll be asked for the site URL when enabling.',
    },
  },
  {
    key: 'stripe',
    label: 'Stripe (payments — read-only to start)',
    entry: {
      slug: 'stripe',
      name: 'Stripe',
      description: 'Payments, subscriptions, invoices and payouts — revenue reporting, failed-payment and churn analysis, customer billing history.',
      category: 'data',
      // Stripe publishes a hosted MCP server, so there is NOTHING to write:
      // this is a plain HTTP connection like Zernio or Duda. Stripe prefers
      // OAuth, which Artivio's MCP client cannot do (it sends static headers
      // only) — but the docs explicitly support a restricted API key as a
      // Bearer token for exactly this "autonomous agent" case.
      transport: 'http' as const,
      url: 'https://mcp.stripe.com',
      authHeader: 'Authorization',
      authHint: 'Bearer <restricted key> — create it at Stripe Dashboard → Developers → API keys → Create restricted key, and grant ONLY the read permissions you need (Customers, Charges, PaymentIntents, Invoices, Subscriptions, Balance, Payouts). Keep the "Bearer " prefix. ⚠️ Use a restricted key (rk_…), never a secret key (sk_…): a secret key can move money, and the MCP server exposes a generic write tool that would then be able to use it. You must also switch MCP access on at Dashboard → Settings → MCP, separately for sandbox and live. The key decides which mode you are in — a live key reports on real money.',
    },
  },
  {
    key: 'cloudflare-dns',
    label: 'Cloudflare DNS (all domains on the account)',
    entry: {
      slug: 'cloudflare-dns',
      name: 'Cloudflare DNS',
      description: 'Read and manage DNS across every domain on a Cloudflare account — records, mail routing, SPF/DKIM/DMARC and site pointers.',
      category: 'dev',
      // Built-in, NOT Cloudflare's hosted MCP. That server authenticates with
      // OAuth, which Artivio's MCP client cannot do (it sends static headers
      // only) — an "insufficient_scope" error naming scopes like user:read
      // comes from there, and no API token will ever satisfy it.
      transport: 'builtin' as const,
      provider: 'cloudflare-dns',
      authHint: 'A Cloudflare API token with Zone → DNS → Edit AND Zone → Zone → Read (dash.cloudflare.com → My Profile → API Tokens → Create Token → Custom token). Under Zone Resources choose the zones it may touch — "All zones" gives it every client domain on the account. Paste the raw token; a "Bearer " prefix is stripped automatically. Leave the target/URL field blank: the token decides which zones are visible. ⚠️ NS and SOA records are refused by this plugin outright, and deletions require an explicit confirmation, because a wrong DNS record takes a client\'s website AND their email down at once.',
    },
  },
  {
    key: 'postmark',
    label: 'Postmark (send + schedule email)',
    entry: {
      slug: 'postmark',
      name: 'Postmark',
      description: 'Send transactional and broadcast email from the client\'s own Postmark account, and see what happened to it — delivery status, bounces, suppressions and templates.',
      category: 'marketing',
      // Built-in, NOT the vendor's MCP. Postmark's official server
      // (@activecampaign/postmark-mcp) is stdio-only with no hosted URL, so it
      // would cost an npm dep + a child process per call for 24 tools where we
      // want ten — and the unscoped `postmark-mcp` npm package was the first
      // malicious MCP server found in the wild (it BCC'd every send to the
      // author). See the header of src/libs/plugins/postmark.ts.
      transport: 'builtin' as const,
      provider: 'postmark',
      authHint: 'The Postmark SERVER API Token for the client\'s server (Postmark → Servers → pick the server → API Tokens tab). NOT the Account token and NOT the SMTP password. You will also be asked for a default From address, which must already be a CONFIRMED Sender Signature on that account — an unconfirmed From is the single most common Postmark failure (error 400/401). ⚠️ Postmark has NO scheduled-send API: every send goes immediately. Scheduling is done by Artivio\'s scheduled tasks (startAt + once), not by Postmark. Bulk/marketing mail also needs a BROADCAST message stream — the default outbound stream is transactional-only and rejects it.',
    },
  },
  {
    key: 'postgres',
    label: 'Postgres database (Neon, Supabase, any server)',
    entry: {
      slug: 'postgres',
      name: 'Postgres',
      description: 'Read and write one Postgres database — inspect tables, run queries, insert and update rows.',
      category: 'data',
      // Built-in rather than Neon's hosted MCP. Neon's MCP WOULD work (it takes
      // an API key in a static header, unlike Cloudflare's and HeyGen's), but a
      // Neon API key is account-wide and can delete projects, while a connection
      // string reaches exactly one database. Neon's own docs also say to use
      // their MCP for development, "never against production databases".
      transport: 'builtin' as const,
      provider: 'postgres',
      authHint: 'The full Postgres connection string — postgresql://user:password@host/dbname?sslmode=require. For Neon: Dashboard → your project → Connection Details → copy the POOLED connection string. Leave the target/URL field blank. ⚠️ This reaches a live database with no undo: schema changes (CREATE/ALTER/DROP/TRUNCATE) are refused outright, UPDATE and DELETE without a WHERE are refused, and every write runs in a transaction that ROLLS BACK if it affects more rows than the agent said it expected. Use a database role with only the privileges the work needs — a connection string with superuser rights hands over more than the task requires.',
    },
  },
  {
    key: 'whmcs',
    label: 'WHMCS (hosting billing)',
    entry: {
      slug: 'whmcs',
      name: 'WHMCS',
      description: 'The hosting business itself — clients, invoices and payments, orders, services, domains and support tickets.',
      category: 'ops',
      transport: 'builtin' as const,
      provider: 'whmcs',
      // Built-in rather than http: WHMCS has no MCP server, and its API is a
      // form-encoded POST to includes/api.php that answers 200 OK to failures.
      authHint: 'WHMCS API credentials as "identifier:secret" — WHMCS → Configuration → System Settings → API Credentials (the admin role attached needs the "API Access" permission). ⚠️ WHMCS restricts the API by IP address by default, and Artivio calls from a cloud host whose outbound address changes, so an allowlist will not hold. Add $api_access_key = \'some-long-random-passphrase\'; to the installation\'s configuration.php and paste the credential as "identifier:secret:accesskey". The connection URL is the WHMCS installation ROOT (the folder containing includes/api.php), e.g. https://billing.example.com.',
    },
  },
  {
    key: 'cloudflare',
    label: 'Cloudflare (DNS + the whole API)',
    entry: {
      slug: 'cloudflare',
      name: 'Cloudflare',
      description: 'Manage DNS records, zones and the rest of Cloudflare — point a domain at a new host, fix a broken record, add the SPF/DKIM/DMARC entries that decide whether a domain\'s mail is trusted.',
      category: 'dev',
      // Cloudflare's own hosted MCP server. It prefers OAuth, which Artivio's
      // MCP client cannot do, but the docs explicitly support a Cloudflare API
      // token as a static bearer for automation — so no adapter is needed. It
      // covers ~2,500 endpoints through a search-and-execute pattern rather
      // than one tool per endpoint, so it stays cheap in context.
      transport: 'http' as const,
      url: 'https://mcp.cloudflare.com/mcp',
      authHeader: 'Authorization',
      authHint: 'Bearer <API token> from dash.cloudflare.com → My Profile → API Tokens → Create Token. Scope it to Zone:Read + DNS:Edit across the zones you want reachable and nothing else — this server also fronts Workers, R2, firewall and Zero Trust, and the token is the only thing deciding how far a mistake reaches. Keep the "Bearer " prefix. This is separate from the Cloudflare Web Analytics plugin, which reads traffic data and needs its own Account Analytics:Read token.',
    },
  },
  {
    key: 'smartermail',
    label: 'SmarterMail (mail server)',
    entry: {
      slug: 'smartermail',
      name: 'SmarterMail',
      description: 'Run and troubleshoot the mail server — domains and DKIM/SPF, mailboxes, aliases and forwards, the delivery spool, bounce reasons, spam scores and blocked IPs.',
      category: 'ops',
      transport: 'builtin' as const,
      provider: 'smartermail',
      authHint: 'A SmarterMail login as "username:password". ⚠️ SmarterMail issues no API keys — this is a real account, so create a dedicated SYSTEM ADMINISTRATOR account for Artivio (e.g. artivio@yourdomain.com) rather than reusing your own: it can be revoked on its own, and its actions are distinguishable in SmarterMail\'s logs. A domain admin account cannot reach domains, the spool or blocked IPs, which rules out most delivery troubleshooting. The connection URL is the mail server base address, e.g. https://mail.example.com.',
    },
  },
  {
    key: 'github',
    label: 'GitHub (site repos)',
    entry: {
      slug: 'github',
      name: 'GitHub',
      description: 'Read and edit the code behind any site hosted from a Git repo. Pushing to the deploy branch publishes the site.',
      category: 'dev',
      transport: 'http' as const,
      url: 'https://api.githubcopilot.com/mcp/x/repos',
      authHeader: 'Authorization',
      authHint: 'Bearer <fine-grained PAT> with Contents read/write on the site repos. \u26a0\ufe0f Its only write verb takes the WHOLE file, so an agent cannot edit a page of any real size through it \u2014 the call exceeds the output-token limit. Use "GitHub repository (edit in place)" for editing; this one is fine for browsing and for repo-level operations it does not cover.',
    },
  },
  {
    key: 'github-repo',
    label: 'GitHub repository (edit in place)',
    entry: {
      slug: 'github-repo',
      name: 'GitHub repository',
      description: 'Read and edit the code behind one site repo. Edits are applied server-side by find-and-replace, so changing a headline on a large page costs a few tokens instead of the whole file. Pushing to the deploy branch publishes the site.',
      category: 'dev',
      transport: 'builtin' as const,
      provider: 'github-repo',
      authHint: 'A fine-grained PAT with Contents \u2192 Read and write on this repository. One connection = one repo: set the target to "owner/repo", or "owner/repo | branch" to pin the deploy branch. Add a second connection for a second site.',
    },
  },
];
