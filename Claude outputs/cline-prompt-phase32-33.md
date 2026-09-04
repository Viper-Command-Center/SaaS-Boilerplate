# Task: verify and ship Phase 32 + 33 (DiviOps guardrails, WP-CLI over SSH)

You are working in `C:\Users\Claude\Documents\SaaS-Boilerplate` (Next.js 16 / TypeScript, deployed to Railway by `deploy.bat`). Read `CLAUDE.md` first — specifically the sections **"Phase 32 — DiviOps section_replace"** and **"Phase 33 — WP-CLI over SSH"**, which describe the change you are verifying, and **"Verifying a change"** / **"Gotchas"**.

The working tree already contains an uncommitted change set written by another agent. Your job is NOT to rewrite it. Your job is to (1) confirm it matches the spec below, (2) run every check, (3) fix only what is actually wrong, and (4) ship it. Do not refactor, rename, reformat, or "improve" code outside the listed files. If you believe something in the spec is wrong, stop and say so rather than silently doing something different.

## 0. Ground rules

- Never print, log, or commit key material. `src/app/api/plugins/ssh-key/route.ts` must return only `{ credentialId, publicKey }`.
- Do not add dependencies beyond `ssh2` and `@types/ssh2` (already in `package.json`).
- Do not change tool policies, the approvals gateway, or the vault.
- `git status` may list files as modified that are not (CRLF noise) — trust `git diff --stat`. Do not commit files whose diff is only line endings.

## 1. Start

```
git status --short
git diff --stat
npm install
```

`npm install` is required: `package.json` gained `@diviops/mcp-server@1.5.47`, `ssh2`, `@types/ssh2`, and `deploy.bat` runs `tsc` before pushing — without the install, typecheck fails on the missing module.

Expected changed files (12 modified + 3 new). Anything else in the diff needs an explanation:

```
CLAUDE.md
next.config.ts                          (serverExternalPackages: ['ws', 'ssh2'])
package.json / package-lock.json
scripts/agent-evals.mjs                 (+14 tripwires → 88 total)
src/app/api/mcp/connections/route.ts    (+credentialKind)
src/app/api/plugins/route.ts            (+credentialId, +credentialKind)
src/app/api/plugins/ssh-key/route.ts    (NEW)
src/features/agent/ToolsPanel.tsx       (Generate SSH key / Show public key)
src/libs/mcp/registry.ts                (stdio guidance + guardCall)
src/libs/mcp/stdioCatalog.ts            (DiviOps guidance + diviopsGuard)
src/libs/plugins/index.ts               (wpcli registered + catalog preset)
src/libs/plugins/types.ts               (+credentialKind)
src/libs/plugins/sshKey.ts              (NEW)
src/libs/plugins/wpcli.ts               (NEW)
```

## 2. Spec to verify against

### Phase 32 — DiviOps (stdioCatalog.ts + registry.ts)

`StdioServerSpec` has two new optional fields: `guidance: string` and `guardCall(toolName, args) → { args, note? }`.

In `registry.ts`, inside the `conn.transport === 'stdio'` branch:
- `spec.guidance` is added to `guidanceByProvider` under the key `` `stdio:${spec.key}` `` (so it lands in the same "How your connected tools actually behave" system-prompt section the built-ins use).
- `spec.guardCall` runs BEFORE `client.callTool(...)`; its returned `args` are what is forwarded; its `note` (if any) is appended to the tool result after a blank line. A guard throw propagates as the tool error (no `explainToolError` wrapping).

`diviopsGuard` in `stdioCatalog.ts` must do exactly three things:
1. For `diviops_section_replace`, `diviops_section_remove`, `diviops_section_get`: throw if `label` or `match_text` contains any of `& < > "` or the sequence `--` (regex `/[&<>"]|--/`). The error must say it is a plugin limitation and suggest `match_text` with a plain phrase or append+remove.
2. For `diviops_section_replace`: strip a leading `<!-- wp:divi/placeholder -->` and trailing `<!-- /wp:divi/placeholder -->` from `content` and add a note saying so. `section_append` content must NOT be modified.
3. For `diviops_section_append` and `diviops_section_replace`: if `content` contains `"adminLabel":{"desktop":{"value":"…"}}` whose value matches the regex above, add a warning note (do not throw).

Quick check — run this with `npx tsx` from the repo root:

```ts
import { diviopsGuard } from './src/libs/mcp/stdioCatalog';
const r = diviopsGuard('diviops_section_replace', { page_id: 1, match_text: 'Hero', content: '<!-- wp:divi/placeholder -->\n<!-- wp:divi/section {"a":1} -->x<!-- /wp:divi/section -->\n<!-- /wp:divi/placeholder -->' });
console.log(String(r.args.content).startsWith('<!-- wp:divi/section') && !!r.note ? 'PASS strip' : 'FAIL strip');
try { diviopsGuard('diviops_section_get', { page_id: 1, label: 'Pricing & Plans' }); console.log('FAIL refuse'); } catch (e) { console.log(/plugin limitation/.test(String(e)) ? 'PASS refuse' : 'FAIL refuse'); }
const a = diviopsGuard('diviops_section_append', { page_id: 1, content: '<!-- wp:divi/placeholder --><!-- wp:divi/section --><!-- /wp:divi/section --><!-- /wp:divi/placeholder -->' });
console.log(String(a.args.content).startsWith('<!-- wp:divi/placeholder') && !a.note ? 'PASS append untouched' : 'FAIL append untouched');
```

### Phase 33 — WP-CLI over SSH (wpcli.ts, sshKey.ts, ssh-key route, plugins API, ToolsPanel)

`src/libs/plugins/wpcli.ts` — `BuiltinProvider` with `slug: 'wpcli'`, `perConnection: true`, `targetIsUrl: false`, `credentialKind: 'ssh-key'`, registered in `src/libs/plugins/index.ts` (both `BUILTIN_PROVIDERS` and a `PLUGIN_PRESETS` entry with `key: 'wpcli'`). It must satisfy ALL of the following — each one is a security property, not a style choice:

- Target is parsed by `parseTarget()` from `user@host[:port]:/absolute/path`; the path regex rejects `' " ` $ ; & | < >` and whitespace. Bad target → thrown error naming the expected format.
- Every command is built as an argv array `['wp', '--path=<target.path>', '--no-color', ...args]`, each element passed through `shellQuote()` (POSIX single-quote), joined with spaces. There is NO string interpolation of user args into a command anywhere.
- `assertArgsSafe()` throws on: empty args; any arg containing `\r`, `\n`, or NUL; any arg matching `/^--(?:path|url|ssh|http|require|exec|skip-packages)(?:=|$)/`; any command whose first one or two non-flag words match an entry of `WP_DENY_PREFIXES` (must include at least `eval`, `eval-file`, `shell`, `db drop`, `db reset`, `db import`, `db query`, `site empty`, `site delete`, `core download`, `core install`, `package`); and `search-replace` without `--dry-run` (the typed `wp_search_replace` tool is the only path to a live search-replace, and only with explicit `dry_run: false`).
- `sshExec()` uses `ssh2`'s `Client` with `privateKey` from the credential, `readyTimeout`, an overall timeout whose timer is `unref()`ed, `hostVerifier: () => true` (accept-new posture; documented), and always calls `conn.end()` once.
- Tools exposed: `wp_status`, `wp_cli`, `wp_cache_flush`, `wp_option_get`, `wp_option_update`, `wp_search_replace`, `wp_plugin_list`, `wp_plugin_update`. `call()` throws if the credential does not contain `PRIVATE KEY`.
- `guidance` is set (multi-line string) — it is injected into the system prompt.

`src/libs/plugins/sshKey.ts` — `generateSshKeyPair(comment)` uses `node:crypto` `generateKeyPairSync('rsa', { modulusLength: 3072, privateKeyEncoding: { type: 'pkcs1', format: 'pem' } })` and derives the OpenSSH public key THROUGH `ssh2`'s `utils.parseKey(...).getPublicSSH()`. RSA/PKCS#1 is deliberate: ssh2's parser rejects ed25519 in PKCS#8. Do not change the key type.

`src/app/api/plugins/ssh-key/route.ts`:
- `POST { tenantSlug, pluginId }` → owner/admin only; plugin must be `builtin` with a provider whose `credentialKind === 'ssh-key'`; inserts a `credentials` row with `tenantId`, `provider: plugin.slug`, `cipher: sealSecret(privateKeyPem)`; returns `{ credentialId, publicKey }`. Audit log detail contains the credential id only.
- `GET ?tenant=&connection=` → owner/admin only; the connection must belong to the tenant; re-derives and returns `{ publicKey }`.

`src/app/api/plugins/route.ts` — `EnableSchema` accepts optional `credentialId: uuid`. When present, the row is looked up with **all three** constraints `id = credentialId AND tenantId = tenant.id AND provider = plugin.slug`; otherwise 400. The GET response includes `credentialKind`.

`src/features/agent/ToolsPanel.tsx` — for a plugin with `credentialKind === 'ssh-key'` the inline form shows **Generate SSH key** (POST above), then the public key in a read-only textarea with a Copy button and Save; Save sends `credentialId` instead of `credentialValue`. Pasting an existing PEM remains as a fallback input. Connected rows with `credentialKind === 'ssh-key'` show **Show public key** (GET above) and render the key below the row.

Quick check — `npx tsx`:

```ts
import { parseTarget, wpcliProvider } from './src/libs/plugins/wpcli';
import { generateSshKeyPair, derivePublicKey } from './src/libs/plugins/sshKey';
const t = parseTarget('u195312244@45.13.134.129:65002:/home/u195312244/domains/site.com/public_html/');
console.log(t.port === 65002 && t.path.endsWith('public_html') ? 'PASS target' : 'FAIL target');
const pair = generateSshKeyPair('artivio-test');
console.log(/^ssh-rsa AAAA\S+ artivio-test$/.test(pair.publicKeyOpenSsh) && derivePublicKey(pair.privateKeyPem, 'artivio-test') === pair.publicKeyOpenSsh ? 'PASS keygen' : 'FAIL keygen');
const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----';
const tgt = 'u1@203.0.113.1:65002:/home/u1/public_html';
for (const [name, args, re] of [
  ['eval', ['eval', 'phpinfo();'], /refused/],
  ['db query', ['db', 'query', 'SELECT 1'], /refused/],
  ['--path', ['option', 'get', 'x', '--path=/other'], /not allowed/],
  ['live search-replace', ['search-replace', 'a', 'b'], /wp_search_replace/],
  ['newline', ['option', 'get', 'x\nrm'], /newlines/],
] as const) {
  try { await wpcliProvider.call('wp_cli', { args: [...args] }, key, tgt); console.log('FAIL', name); }
  catch (e) { console.log((re as RegExp).test(String(e)) ? 'PASS' : 'FAIL', name); }
}
// an allowed command must get PAST the guard and fail only at the SSH layer (fake key)
try { await wpcliProvider.call('wp_cli', { args: ['option', 'get', 'siteurl'] }, key, tgt); console.log('FAIL allowed'); }
catch (e) { console.log(/parse|key|SSH/i.test(String(e)) ? 'PASS allowed reaches ssh' : 'FAIL allowed'); }
```

All lines must print PASS and the process must exit on its own (if it hangs, the timeout timer is not `unref()`ed).

## 3. Checks (all must pass)

```
npm run check:types
node scripts/agent-evals.mjs            # expect "all 88 tripwires pass"
npx eslint src/libs/plugins/wpcli.ts src/libs/plugins/sshKey.ts src/libs/mcp/stdioCatalog.ts src/libs/mcp/registry.ts src/app/api/plugins/route.ts src/app/api/plugins/ssh-key/route.ts src/app/api/mcp/connections/route.ts src/features/agent/ToolsPanel.tsx src/libs/plugins/index.ts src/libs/plugins/types.ts next.config.ts
npx eslint scripts/agent-evals.mjs      # two PRE-EXISTING errors at lines ~78 and ~217 are known; anything else is new
npx vitest run                          # unit projects must pass; a trailing Playwright/Storybook browser error is environmental
```

Use `npx eslint --fix` for pure style findings; re-run the checks afterwards. If a check fails for a reason you cannot fix within the listed files, stop and report it — do not widen the change.

## 4. Review pass (read, don't rewrite)

Read `src/libs/plugins/wpcli.ts` top to bottom and confirm each bullet in §2 by pointing at the line. Then confirm:
- `next.config.ts` has `serverExternalPackages: ['ws', 'ssh2']` (ssh2 must not be bundled).
- `package.json` pins `@diviops/mcp-server` to `1.5.47` and the lockfile resolves it (`grep -n '"node_modules/@diviops/mcp-server"' -A3 package-lock.json`).
- `grep -n "privateKeyPem" src/app/api/plugins/ssh-key/route.ts` shows it only inside `sealSecret(...)` — never in a response or log.

## 5. Ship

```
git add CLAUDE.md next.config.ts package.json package-lock.json scripts/agent-evals.mjs src/app/api/mcp/connections/route.ts src/app/api/plugins/route.ts src/app/api/plugins/ssh-key/route.ts src/features/agent/ToolsPanel.tsx src/libs/mcp/registry.ts src/libs/mcp/stdioCatalog.ts src/libs/plugins/index.ts src/libs/plugins/types.ts src/libs/plugins/sshKey.ts src/libs/plugins/wpcli.ts
git commit -m "feat: WP-CLI over SSH provider (wpcli) + DiviOps section guardrails and authoring guidance; bump @diviops/mcp-server to 1.5.47"
deploy.bat
```

Note: `deploy.bat` also runs on a ~30-minute schedule and may have already committed some of this as `chore: deploy <timestamp>` — check `git log -3 --stat` before assuming a commit failed.

## 6. Report back

In your final message list: the output of each check in §3; any file you changed beyond the 15 listed and why; any §2 bullet you could NOT confirm; and the commit hash + Railway deploy status.

## After deploy (Ryan does this, not you)

Admin → Plugin catalog → Quick add → "WP-CLI over SSH". Workspace Tools panel → Enable → Generate SSH key → Copy → hPanel → Websites → Advanced → SSH Access → Add SSH key. Target: `u195312244@45.13.134.129:65002:/home/u195312244/domains/<domain>/public_html` (confirm the path holds `wp-config.php`). Save, then have the agent run `wp_status` — that is the live integration test.
