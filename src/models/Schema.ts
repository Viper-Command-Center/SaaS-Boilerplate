import { boolean, index, jsonb, pgTable, serial, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  t => [uniqueIndex('users_email_normalized_uq').on(t.emailNormalized)],
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
    settings: jsonb('settings'), // guardrails, intensity, spend caps…
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
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
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
    transport: varchar('transport', { length: 10 }).notNull().default('http'), // http | stdio (stdio = Phase 4 worker)
    url: text('url'), // http transport: the MCP endpoint
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
