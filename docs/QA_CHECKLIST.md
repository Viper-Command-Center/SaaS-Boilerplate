# Artivio — QA checklist for an agentic multi-tenant platform

Derived from the bugs we actually shipped, not from theory. Every item below
exists because something broke in a specific, traceable way.

The point of this document: **the bugs were not random.** They fall into eight
repeating shapes. If we check the shapes, we catch the next one before Ryan does.

---

## The eight failure classes

| # | Class | What it looks like | The bug it caused |
|---|-------|--------------------|-------------------|
| 1 | **Path parity** | A capability works on one execution path but not the others | Kie worked on auto-call but **failed on approval** — the approvals route re-implemented execution and only handled HTTP transport |
| 2 | **Contract drift** | UI, API validator and DB disagree about a shape | CatalogTab sent `unit:'usage'`; the zod schema only allowed `'call'\|'arg'` → every Kie price save would 400 |
| 3 | **Credential matrix holes** | A (tier × transport × provider-kind) combination nobody thought about | Tier-1 **HTTP** plugins got no credential at all — the registry reads from the connection, the platform key lives on the catalog |
| 4 | **Secret leakage** | A secret ends up somewhere unencrypted | Firecrawl puts the API key **in the URL path**, and `mcp_connections.url` is plaintext |
| 5 | **Capability half-loop** | The agent can *produce* X but not *persist / retrieve / publish* X | Agent could fetch a QR PNG but had **no way to save bytes** — only text notes |
| 6 | **Dishonest errors** | The error message misdescribes the cause | "The tool connection is no longer available" (it was available; the code refused non-HTTP) → agent invented "reconnect Kie" |
| 7 | **Money leaks** | A paid action isn't metered, capped, or cleaned up | Approved calls **skipped metering and asset-archiving**; an orphaned browser session bills until timeout |
| 8 | **Broken build loop** | Nothing compiles the code before production does | One stray backtick in `prompt.ts` cost **two failed Railway builds** |

---

## Definition of Done — run this for EVERY new capability

### 1. Path parity
The same call must behave identically through every path it can take:

- [ ] **Auto call** (agent invokes it directly)
- [ ] **Approval** (queued → approved → executed) — *does it use the same executor, or a copy?*
- [ ] **Scheduled task** (3am, no human present)
- [ ] If any path re-implements execution instead of calling the shared executor → **that's the bug**. One code path.

### 2. Contract drift
- [ ] UI sends a shape → API zod schema accepts it → DB column can store it
- [ ] Adding an enum value? Grep for **every** place that enum is declared
- [ ] TypeScript types shared, not duplicated, across UI/API

### 3. Credential matrix
For the new provider, fill in this grid explicitly:

| | Who supplies the key? | Where is it stored? | Encrypted? |
|---|---|---|---|
| tier1 + builtin | platform | catalog `credentialId` → vault | yes |
| tier1 + http | platform | catalog → **copied to connection** | yes |
| tier2 + http | client | connection `headerCredentials` → vault | yes |
| per-connection builtin | client | connection + site URL | yes |
| noCredential | nobody | — | n/a |

- [ ] Which cell is this? Is that cell actually implemented?
- [ ] Does the key ever touch a **plaintext column** (`url`, `name`, `detail`)?
- [ ] Is the key ever returned to the browser? (It must not be — only counts/flags)

### 4. Capability loop closure
For anything the agent can produce, ask all five:

- [ ] Can it **produce** it?
- [ ] Can it **persist** it? (text → `save_note`; **bytes → `save_file_from_url`**)
- [ ] Can it **retrieve** it later? (`list_files` / `read_file`)
- [ ] Can it **publish** it? (permanent public URL, not a provider URL that expires)
- [ ] Can the user **delete** it? (and does that purge R2, not just the DB row?)

### 5. Error honesty
- [ ] Is the error message **true**? (Not "connection unavailable" when the code simply refused)
- [ ] Is it **classified** (`config` / `provider` / `platform`)?
- [ ] Do platform-class errors **escalate automatically** (email + Issues inbox)?
- [ ] Does the agent get told **"do not invent troubleshooting steps"**?
- [ ] Would this error make the agent recommend buying an integration we already have?

### 6. Money safety
- [ ] Is every paid call **metered** with real usage (provider-reported, not estimated)?
- [ ] Does it respect **daily cap + kill switch** (`checkSpend` before the call)?
- [ ] Are **failed** calls NOT billed?
- [ ] Are resources released in a `finally`? (browser sessions, temp objects)
- [ ] Is markup applied and visible in Admin → margin?

### 7. Tenant isolation
- [ ] New table has `tenantId` with `ON DELETE cascade`
- [ ] Storage keys derived **server-side** from the session (`tenants/<id>/…`), never from client input
- [ ] Cross-tenant read is impossible even with a guessed ID (membership re-checked on every request)
- [ ] Workspace delete purges **external** resources too (R2 objects, sessions)

### 8. Build loop
- [ ] `npm run check:types` passes **before** pushing (deploy.bat enforces this)
- [ ] New dependency? Justified, and `serverExternalPackages` if it's native/server-only
- [ ] New migration? Hand-written SQL is **idempotent** (`IF NOT EXISTS`)
- [ ] Every script step fails **loudly** (a silent `git commit` failure once hid 12 hours of work)

---

## Pre-deploy checklist (every push)

- [ ] `deploy.bat` typechecks and aborts on error
- [ ] Migration (if any) runs pre-deploy and is idempotent
- [ ] New env vars added to Railway **before** the code that needs them
- [ ] No secret printed to logs or returned to the browser

## Post-deploy smoke test (5 minutes)

- [ ] Sign in → dashboard loads
- [ ] Agent chat responds (proves Bedrock + prompt caching path)
- [ ] Create a panel → appears (proves platform tools)
- [ ] Upload a file → appears in Files (proves R2 + presigned upload)
- [ ] Approve a queued tool call → **executes AND meters** (proves path parity)
- [ ] Admin → cost/margin moved (proves the ledger)
- [ ] Admin → Issues is empty (proves nothing silently escalated)

## Periodic audit (monthly, or before onboarding a client)

- [ ] **Secrets**: nothing in plaintext columns; vault key rotated if needed
- [ ] **Isolation**: pick a random file/issue/connection — is it reachable from another workspace? (must be no)
- [ ] **Cost**: does Admin margin match reality? Spot-check one Kie job's credits against the ledger
- [ ] **Orphans**: any browser sessions or R2 objects with no owning row?
- [ ] **Issues inbox**: any open `platform` bugs older than a week?

---

## The meta-lesson

Two failure modes recur, and they're both about **honesty**, not capability:

1. **The platform lies** → misleading error → the agent faithfully repeats the lie
   and dresses it up as a diagnosis. *Fix the platform's error, not the agent's
   intelligence.*
2. **The agent doesn't know what the platform can do** → it recommends buying an
   integration we already have (Cloudinary for storage we own; "reconnect Kie"
   for a connection that was fine). *Tell it plainly, in the prompt, what exists.*

When something breaks, the first question is never "how do we make the agent
smarter?" It is: **"what did the platform tell it, and was that true?"**
