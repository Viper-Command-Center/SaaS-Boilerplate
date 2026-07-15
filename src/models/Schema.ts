import { boolean, index, integer, jsonb, numeric, pgTable, serial, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

// This file defines the structure of your database tables using the Drizzle ORM.
// To modify the database schema:
// 1. Update this file with your desired changes.
// 2. Generate a new migration by running: `npm run db:generate`
// Migrations run on Railway via the pre-deploy command (`npm run db:migrate`).

// ─── Auth (ported from the proven BudgetSmart pattern) ──────────────────────
// Session strategy: on login we create a row in `sessions` with a random
// tokenId; the browser cookie holds an HS256 JWT { sid, uid } signed with
// SESSION_SECRET. Edge middleware verifies the signature cheaply; the DB row
// is the authoritative check (revocation, expiry).

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 254 }).notNull(),
    emailNormalized: varchar('email_normalized', { length: 254 }).notNull(),
    passwordHash: text('password_hash').notNull(),
    firstName: varchar('first_name', { length: 80 }),
    lastName: varchar('last_name', { length: 80 }),
    // Platform admin — full access to every tenant and platform settings.
    // The first user ever created is automatically the platform admin.
    isAdmin: boolean('is_admin').notNull().default(false),
    // ── Two-factor auth (TOTP) ──
    twoFactorSecret: text('two_factor_secret'), // base32, set at enrolment
    twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
    twoFactorBackupCodes: jsonb('two_factor_backup_codes'), // bcrypt hashes
    // Forces a password change on next sign-in (invited accounts).
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  t => [uniqueIndex('users_email_normalized_uq').on(t.emailNormalized)],
);

/** Waitlist / invite requests from the public site. */
export const inviteRequests = pgTable('invite_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 120 }).notNull(),
  email: varchar('email', { length: 254 }).notNull(),
  company: varchar('company', { length: 160 }),
  website: varchar('website', { length: 300 }),
  useCase: text('use_case'),
  clientCount: varchar('client_count', { length: 40 }),
  status: varchar('status', { length: 20 }).notNull().default('new'), // new | invited | declined
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Single-use, time-limited password reset tokens (hashed at rest). */
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 128 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [index('password_reset_user_idx').on(t.userId)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Opaque token id carried inside the signed cookie JWT.
    tokenId: varchar('token_id', { length: 64 }).notNull(),
    userAgent: text('user_agent'),
    ipAddress: varchar('ip_address', { length: 64 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    uniqueIndex('sessions_token_id_uq').on(t.tokenId),
    index('sessions_user_id_idx').on(t.userId),
  ],
);

// ─── Tenancy ─────────────────────────────────────────────────────────────────
// A tenant is a client business (BudgetSmart, True Therapy, BargainBalloons…).
// Users get access to tenants through memberships with a role.

export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: varchar('slug', { length: 80 }).notNull(), // used in URLs: /t/true-therapy
    vertical: varchar('vertical', { length: 40 }), // health | finance | ecommerce…
    brandVoice: jsonb('brand_voice'),
    settings: jsonb('settings'), // guardrails, intensity…
    // ── AI Employee (Phase 20) ──
    // Which persona works this account. Nullable = the generic agent.
    // ON DELETE set null so removing a persona never deletes a workspace.
    personaId: uuid('persona_id'),
    // Optional per-workspace rename ("Bud" → "Buddy") without forking the persona.
    agentNameOverride: varchar('agent_name_override', { length: 60 }),
    // ── Billing & guardrails (Phase 6) ──
    planName: varchar('plan_name', { length: 40 }).notNull().default('trial'),
    // Monthly allowance the client's plan includes (what we bill them against).
    monthlyBudgetUsd: numeric('monthly_budget_usd', { precision: 10, scale: 2 }).notNull().default('50'),
    // Hard daily ceiling on OUR cost. Nothing runs past it, ever.
    dailyCapUsd: numeric('daily_cap_usd', { precision: 10, scale: 2 }).notNull().default('10'),
    // Kill switch — when true the agent refuses to run for this workspace.
    paused: boolean('paused').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [uniqueIndex('tenants_slug_uq').on(t.slug)],
);

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    // owner: full control · admin: manage tenant + approve · editor: draft +
    // approve content · viewer: read-only dashboards
    role: varchar('role', { length: 20 }).notNull().default('viewer'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    uniqueIndex('memberships_user_tenant_uq').on(t.userId, t.tenantId),
    index('memberships_user_idx').on(t.userId),
  ],
);

// ─── Phase 2: credential vault + MCP registry + approvals + audit ────────────
// Credentials are AES-256-GCM sealed (src/libs/vault.ts, key = VAULT_MASTER_KEY
// in Railway variables). MCP connections define which tool servers a tenant's
// agent can reach; toolPolicy gates each tool: 'auto' | 'approval' | 'deny'.

export const credentials = pgTable(
  'credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // NULL = a platform-level credential (tier-1 plugin key owned by us and
    // reused across workspaces). Non-null = that workspace's own credential.
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 80 }).notNull(), // dataforseo | zernio | shopify | custom…
    label: varchar('label', { length: 120 }),
    cipher: text('cipher').notNull(), // vault-sealed, never plaintext
    meta: jsonb('meta'), // non-secret: account ids, scopes
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [index('credentials_tenant_idx').on(t.tenantId)],
);

export const mcpConnections = pgTable(
  'mcp_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 80 }).notNull(), // used in tool namespace mcp__<name>__<tool>
    // http = remote MCP server · builtin = in-app tier-1 adapter (Kie.ai etc.)
    transport: varchar('transport', { length: 10 }).notNull().default('http'),
    url: text('url'), // http transport: the MCP endpoint
    // When enabled from the plugin catalog, links back to the catalog entry
    // (gives us the tier, the platform credential and the price rules).
    catalogId: uuid('catalog_id'),
    // Header name → credential id; resolved+decrypted at call time and sent as
    // HTTP headers (e.g. { "Authorization": "<credId>" } where the credential
    // holds "Bearer sk_…"). Never stored plaintext.
    headerCredentials: jsonb('header_credentials'),
    // Tool name → 'auto' | 'approval' | 'deny'. Tools absent from the map
    // default to 'approval' (safe by default).
    toolPolicy: jsonb('tool_policy'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    index('mcp_connections_tenant_idx').on(t.tenantId),
    uniqueIndex('mcp_connections_tenant_name_uq').on(t.tenantId, t.name),
  ],
);

export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id'),
    connectionId: uuid('connection_id'),
    toolName: text('tool_name').notNull(), // namespaced mcp__<connection>__<tool>
    args: jsonb('args').notNull(),
    status: varchar('status', { length: 20 }).notNull().default('pending'), // pending|approved|rejected|executed|failed
    requestedBy: varchar('requested_by', { length: 40 }).notNull().default('agent'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    result: jsonb('result'),
  },
  t => [index('approvals_tenant_status_idx').on(t.tenantId, t.status)],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id'),
    actor: varchar('actor', { length: 120 }).notNull(), // userId | agent
    action: varchar('action', { length: 80 }).notNull(), // tool.call | tool.approved | connection.create…
    target: text('target'),
    detail: jsonb('detail'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [index('audit_log_tenant_at_idx').on(t.tenantId, t.at)],
);

// ─── Agent conversations (ported Bud pattern, tenant-scoped) ─────────────────

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title'),
    channel: varchar('channel', { length: 20 }).notNull().default('web'), // web | whatsapp (later)
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [index('conversations_tenant_idx').on(t.tenantId)],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 20 }).notNull(), // user | assistant
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [index('messages_conversation_idx').on(t.conversationId, t.createdAt)],
);

// ─── Phase 3: datasets + dynamic dashboard panels ────────────────────────────
// Generic per-tenant data store the agent (and later scheduled jobs) writes
// to, and the panels that visualize it. The agent edits panels itself via
// platform tools — this is how the dashboard adapts to whatever MCPs are in
// play and what the user asks for.

export const datasets = pgTable(
  'datasets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    key: varchar('key', { length: 80 }).notNull(), // e.g. organic_traffic, shopify_image_jobs
    row: jsonb('row').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [index('datasets_tenant_key_at_idx').on(t.tenantId, t.key, t.capturedAt)],
);

export const dashboardPanels = pgTable(
  'dashboard_panels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 20 }).notNull(), // kpi | timeseries | table | markdown
    title: text('title').notNull(),
    // kpi: { datasetKey, valueField, label? } · timeseries: { datasetKey, valueField }
    // table: { datasetKey, columns?, limit? } · markdown: { text }
    config: jsonb('config').notNull(),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [index('dashboard_panels_tenant_idx').on(t.tenantId, t.position)],
);

// ─── Phase 4b: scheduled agent tasks ─────────────────────────────────────────
// Standing missions the agent runs on an interval ("post a blog every Monday",
// "collect SEO metrics nightly", "work toward 100 new customers"). A cron
// trigger (GitHub Actions → /api/internal/run-scheduled) executes due tasks
// through the same tool loop + approvals gateway as chat.

export const scheduledTasks = pgTable(
  'scheduled_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    prompt: text('prompt').notNull(),
    intervalMinutes: integer('interval_minutes').notNull().default(1440), // daily
    nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull().defaultNow(),
    enabled: boolean('enabled').notNull().default(true),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastResult: text('last_result'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [index('scheduled_tasks_due_idx').on(t.enabled, t.nextRunAt)],
);

// ─── Phase 6: cost ledger, plans/caps, plugin catalog ────────────────────────
// Every LLM call and every metered plugin call writes a usage_events row with
// the real underlying cost (costUsd) and what we charge (billedUsd = cost ×
// markup). That gives real-time margin per workspace and makes hard caps
// enforceable before the next call.

export const usageEvents = pgTable(
  'usage_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 20 }).notNull(), // llm | plugin
    // llm: model id · plugin: catalog slug (e.g. kie-ai)
    source: varchar('source', { length: 120 }).notNull(),
    detail: varchar('detail', { length: 160 }), // tool name, operation…
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    quantity: numeric('quantity', { precision: 12, scale: 4 }), // plugin units (calls, seconds…)
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'), // what WE pay
    billedUsd: numeric('billed_usd', { precision: 12, scale: 6 }).notNull().default('0'), // what the client is charged
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [index('usage_events_tenant_at_idx').on(t.tenantId, t.at)],
);

/**
 * Catalog of connectable capabilities, managed by the platform admin.
 *  tier1 = platform-provided: OUR credential, metered + billed (priceRules).
 *  tier2 = bring-your-own-key: client pastes their credential, not metered.
 * A catalog entry is just a template — enabling it for a workspace creates a
 * normal mcp_connection (or, for in-app adapters, flips a provider on).
 */
export const pluginCatalog = pgTable(
  'plugin_catalog',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: varchar('slug', { length: 80 }).notNull(),
    name: text('name').notNull(),
    description: text('description'),
    category: varchar('category', { length: 40 }), // media | seo | social | ads | analytics | dev | data
    tier: varchar('tier', { length: 10 }).notNull().default('tier2'), // tier1 | tier2
    transport: varchar('transport', { length: 12 }).notNull().default('http'), // http | builtin
    // builtin transport: which in-app adapter powers it (e.g. 'kie-ai')
    provider: varchar('provider', { length: 60 }),
    url: text('url'), // http: the MCP endpoint
    // tier2: which header the client's key goes in, e.g. "Authorization"
    authHeader: varchar('auth_header', { length: 80 }),
    authHint: text('auth_hint'), // "Bearer sk_…" / where to get the key
    // tier1: platform credential (vault) used for every workspace
    credentialId: uuid('credential_id'),
    // tier1 metering: { "<tool>": { unit: 'call'|'arg', argField?: string,
    //                   costUsd: number, markup: number } }
    priceRules: jsonb('price_rules'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [uniqueIndex('plugin_catalog_slug_uq').on(t.slug)],
);

// ─── Phase 12: workspace file library (R2) ───────────────────────────────────
// One table for BOTH sides of the same problem:
//  · knowledge  — briefs, brand guides, requirement docs the client uploads so
//    the agent can read them instead of being pasted a 5-page prompt.
//  · assets     — media the agent generates (Kie.ai deletes originals after 14
//    days), archived to R2 so links stay alive for the site / social schedule.
// Bytes live in R2 under tenants/<tenantId>/…; rows here are the index.

export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // knowledge | asset | note (agent-written text)
    kind: varchar('kind', { length: 20 }).notNull().default('knowledge'),
    mime: varchar('mime', { length: 120 }),
    sizeBytes: integer('size_bytes').notNull().default(0),
    r2Key: text('r2_key').notNull(),
    // Public URL when the bucket has a custom domain (used by social/CMS posts)
    publicUrl: text('public_url'),
    // Where it came from: upload | kie-ai | agent
    source: varchar('source', { length: 40 }).notNull().default('upload'),
    // Extracted text (documents) so the agent can read a file without bytes.
    textContent: text('text_content'),
    // Free-form: model, prompt, taskId, tags…
    meta: jsonb('meta'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [index('files_tenant_at_idx').on(t.tenantId, t.createdAt)],
);

// ─── Phase 14: issue triage + escalation ────────────────────────────────────
// When something breaks mid-conversation, three things must happen: the client
// gets an honest message, the platform captures WHY (not a guess), and anything
// that needs a code change reaches Ryan without the client having to describe it.
//
// kind:
//   config   — the client can fix it (wrong key, bad URL, expired token)
//   provider — the third party is down / rejecting (their problem, retry later)
//   platform — OUR bug. Escalated: emailed + shown in the admin Issues inbox
//              with a diagnostic bundle ready to hand to an engineer.

export const issues = pgTable(
  'issues',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 20 }).notNull().default('platform'),
    // where it happened: tool name, connection name, route…
    source: varchar('source', { length: 160 }).notNull(),
    // the REAL error text — never a paraphrase
    message: text('message').notNull(),
    // args (redacted), connection id, transport, stack, failed connections…
    detail: jsonb('detail'),
    status: varchar('status', { length: 20 }).notNull().default('open'), // open | resolved
    // set when the agent escalated it rather than the server auto-capturing
    reportedByAgent: boolean('reported_by_agent').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [index('issues_status_at_idx').on(t.status, t.createdAt)],
);

// ─── Phase 19: messaging consent (WhatsApp / RCS / SMS via Twilio) ───────────
// Carriers require verifiable opt-in BEFORE any message and honored opt-out.
// This table is the record of consent: what channel, what number, the exact
// text they agreed to, when, and whether they later opted out. No message is
// ever sent to a number without a matching row where optedOutAt IS NULL and
// (for double opt-in) confirmedAt IS NOT NULL.

export const messagingConsents = pgTable(
  'messaging_consents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Optional — a consent can exist before we know which workspace/user it maps to.
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    channel: varchar('channel', { length: 20 }).notNull().default('whatsapp'), // whatsapp | sms | rcs
    // E.164 phone, normalized (+15551234567)
    phone: varchar('phone', { length: 24 }).notNull(),
    // The exact wording the person agreed to — kept for compliance evidence.
    consentText: text('consent_text').notNull(),
    source: varchar('source', { length: 40 }).notNull().default('web-optin'),
    // Double opt-in: set when they reply YES to the confirmation message.
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    optedOutAt: timestamp('opted_out_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    index('messaging_consents_phone_idx').on(t.phone, t.channel),
  ],
);

// ─── Phase 20: AI Employees (personas) ───────────────────────────────────────
// An employee is a name, a face, and a personality — the thing that makes the
// agent feel like a hire rather than a chatbot. Bud for BudgetSmart, Aria for
// WellnessTrove. The persona is platform-level (a gallery the admin curates);
// each workspace picks one, and the choice flows into the system prompt, the
// chat UI, and the WhatsApp message templates ("it's Aria from your workspace").
//
// Deliberately NOT per-tenant rows: the same employee can work for several
// workspaces, exactly like a real agency assigning staff to accounts.

export const agentPersonas = pgTable(
  'agent_personas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Stable key so seeded personas can be upserted without duplicating.
    slug: varchar('slug', { length: 60 }).notNull(),
    name: varchar('name', { length: 60 }).notNull(), // Bud, Aria…
    // One-liner shown in the picker: "Warm, practical money coach"
    tagline: varchar('tagline', { length: 160 }),
    role: varchar('role', { length: 60 }), // marketing | finance | support | ops
    // Woven into the system prompt — how this employee talks and thinks.
    personality: text('personality').notNull(),
    // Face. R2 URL (generated via Kie) or any public image.
    avatarUrl: text('avatar_url'),
    // Fallback when there's no image: gradient initials.
    accent: varchar('accent', { length: 20 }).default('indigo'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  t => [uniqueIndex('agent_personas_slug_uq').on(t.slug)],
);

// ─── Boilerplate demo table (kept because migration 0000 already created it) ─
export const todoSchema = pgTable('todo', {
  id: serial('id').primaryKey(),
  ownerId: text('owner_id').notNull(),
  title: text('title').notNull(),
  message: text('message').notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date' })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
});
