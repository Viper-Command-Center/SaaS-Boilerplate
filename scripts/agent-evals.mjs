#!/usr/bin/env node
/**
 * agent-evals.mjs — static tripwire suite for the agent runtime.
 *
 * Every incident becomes an eval (docs/PRODUCTION_READINESS_UAT.md, process
 * rule #1). Each check below pins a fix that was shipped after a real failure;
 * if a refactor silently removes one, this script fails the build BEFORE the
 * regression reaches a user. These are deliberately dumb string assertions —
 * no imports, no framework, no DB — so they run anywhere Node runs:
 *
 *   node scripts/agent-evals.mjs
 *
 * Run it locally before pushing (deploy.bat) or wire it into CI. Exit 1 on
 * any failure.
 *
 * LIVE GOLDEN TASKS (manual, run against the deployed app after big agent
 * changes — these need a real model + workspace and cannot be static):
 *  G1  Paste a large multi-week task brief into chat → the agent must ASK a
 *      confirming question or start work — never refuse it as "injection".
 *  G2  Say "try again" right after a spend-cap block → it must resume the
 *      BLOCKED action, not re-run an earlier paid generation.
 *  G3  Clear the chat, then ask "what were we working on?" → it must consult
 *      list_files / the Chat memory note and answer, not claim amnesia.
 *  G4  Ask for a 6-week build → it should start_mission (persisted plan),
 *      and the Missions API should show steps progressing tick by tick.
 *  G5  Approve a queued tool call that fails (e.g. bad credential) → the
 *      agent must come back into the chat, relay the real error, and NOT
 *      invent troubleshooting steps.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const root = process.cwd();
const failures = [];
let checks = 0;

function read(rel) {
  try {
    return readFileSync(resolve(root, rel), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Assert that file `rel` contains `needle` (string or RegExp).
 * `why` names the incident/fix the tripwire protects.
 */
function expect(rel, needle, why) {
  checks += 1;
  const content = read(rel);
  if (content === null) {
    failures.push(`${rel} — FILE MISSING (${why})`);
    return;
  }
  const found = needle instanceof RegExp ? needle.test(content) : content.includes(needle);
  if (!found) {
    failures.push(`${rel} — missing ${needle instanceof RegExp ? needle : JSON.stringify(needle)}\n      guards: ${why}`);
  }
}

/**
 * Assert that file `rel` does NOT contain `needle` in CODE. Comment lines are
 * stripped first — a comment may (and does) name the forbidden pattern while
 * explaining why it is forbidden.
 */
function forbid(rel, needle, why) {
  checks += 1;
  const content = read(rel);
  if (content === null) {
    failures.push(`${rel} — FILE MISSING (${why})`);
    return;
  }
  const code = content
    .split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  const found = needle instanceof RegExp ? needle.test(code) : code.includes(needle);
  if (found) {
    failures.push(`${rel} — FORBIDDEN content present: ${needle instanceof RegExp ? needle : JSON.stringify(needle)}\n      guards: ${why}`);
  }
}

// ── Prompt doctrines (Phase 26.1/27 — each fixed a real Max incident) ───────
expect('src/libs/agent/prompt.ts', 'TRUST — what is and is not the human', 'injection false-positive: agent refused the OWNER\'s pasted brief and report_issue\'d him');
expect('src/libs/agent/prompt.ts', 'RETRY DISAMBIGUATION', '"try again" after a cap block re-ran a PAID Kie video instead of the blocked task');
expect('src/libs/agent/prompt.ts', 'MEMORY:', 'Max claimed "no memory" about a sprint IT BUILT instead of checking the workspace');
expect('src/libs/agent/prompt.ts', 'MISSIONS:', 'big jobs must go through start_mission (persisted plan), not one giant chat turn');

// ── Loop budget honesty (Phase 26 — overnight build stopped silently at wk 2)
expect('src/libs/agent/loop.ts', 'DEFAULT_MAX_ITERATIONS = 24', 'silent 8-iteration cap starved overnight builds');
expect('src/libs/agent/loop.ts', 'shouldStop', 'Stop button: loop must check the cancel flag before every iteration');
expect('src/libs/agent/loop.ts', '[budget]', 'exhaustion must be narrated to the user, never silent');
expect('src/libs/agent/loop.ts', 'exhausted', 'loop must RETURN exhaustion so runners can requeue continuations');

// ── Approval resume, BOTH directions (Max went silent after approving) ──────
expect('src/app/api/approvals/[id]/route.ts', 'ok: false', 'FAILED approved calls must resume the conversation with the triaged error');
expect('src/app/api/approvals/[id]/route.ts', '(execution failed)', 'transcript marker for the failure direction');
expect('src/app/api/approvals/[id]/route.ts', 'checkSpend', 'approving is a spending action — cap must gate it');

// ── Scheduled-run continuation + mission runner (Phase 26/27) ───────────────
expect('src/app/api/internal/run-scheduled/route.ts', '[continuing]', 'exhausted runs must requeue with their wrap-up, not restart cold');
expect('src/app/api/internal/run-scheduled/route.ts', 'MAX_STEP_ATTEMPTS', 'mission steps must pause the mission after repeated failure, not retry forever');
expect('src/app/api/internal/run-scheduled/route.ts', 'buildMissionTools', 'mission runner must expose mission tools to executing steps');

// ── Mission plumbing (Phase 27) ─────────────────────────────────────────────
expect('src/libs/agent/missionTools.ts', 'start_mission', 'the agent\'s plan-first entrypoint for durable work');
expect('src/models/Schema.ts', 'mission_steps', 'missions schema must exist');
expect('migrations/meta/_journal.json', '0016_missions', 'missions migration must be journaled or db:migrate skips it');
expect('src/app/api/agent/chat/route.ts', 'buildMissionTools', 'chat must merge mission tools or start_mission is unreachable');
expect('src/app/api/missions/route.ts', '\'pause\'', 'humans need a pause control for running missions');

// ── Panel truthfulness (duplicate-week-panels incident) ─────────────────────
expect('src/app/api/panels/route.ts', 'config.filter', 'table panels without filters all render the same newest slice');
expect('src/app/api/panels/route.ts', 'sortBy', 'sorted panels must be resolved server-side in display order');

// ── Money + provider resilience (P0) ────────────────────────────────────────
expect('src/libs/agent/anthropic.ts', 'postWithRetry', 'transient 429/5xx/529 must retry with backoff, not kill the turn');
expect('src/app/api/agent/chat/route.ts', 'checkRateLimit', 'per-tenant velocity guard — a runaway client is a money problem');
expect('src/libs/mcp/registry.ts', '?? \'approval\'', 'unknown MCP tools must DEFAULT to approval, never auto');

// ── History window direction (the "Max is very confused" incident, 2026-08-03)
// `orderBy(asc).limit(N)` selects the OLDEST N messages — once the rolling
// conversation crossed the limit, the agent was permanently frozen in its
// earliest window and answered new requests against week-old context (asked
// for blog posts on the site, it drafted LinkedIn/Twitter posts from the old
// social-media era of the transcript). History must load newest-N descending
// and flip back to chronological.
expect('src/app/api/agent/chat/route.ts', /orderBy\(desc\(messages\.createdAt\)\)/, 'chat history must be the NEWEST window, not the oldest');

forbid('src/app/api/agent/chat/route.ts', /orderBy\(asc\(messages\.createdAt\)\)[\s\S]{0,80}limit\(/, 'asc+limit on messages = oldest-window amnesia');

expect('src/app/api/approvals/[id]/route.ts', /orderBy\(desc\(messages\.createdAt\)\)/, 'approval resume must see recent context, not the conversation opening');
expect('src/app/api/agent/history/route.ts', /orderBy\(desc\(messages\.createdAt\)\)/, 'UI transcript + clear-consolidation must use the newest window');

// ── Output truncation honesty (the "announced a mission, never created it"
// incident, 2026-08-03): at max_tokens the model's giant start_mission call
// was amputated mid-JSON and the loop read the stop as a FINAL ANSWER — the
// agent said "creating the mission now" and the turn silently ended. Three
// times in a row.
expect('src/libs/agent/anthropic.ts', '16_384', 'tool responses need headroom for large tool calls (mission plans)');
expect('src/libs/agent/loop.ts', 'stop_reason === \'max_tokens\'', 'truncated replies must recover/announce, never pass as final answers');

// ── Standing workspace memory (Phase 28 — "Max keeps forgetting the repo") ──
expect('src/models/Schema.ts', 'agent_memory', 'tenants.agent_memory column must exist');
expect('migrations/meta/_journal.json', '0017_agent-memory', 'memory migration must be journaled');
expect('src/libs/agent/platformTools.ts', '\'update_memory\'', 'the agent must be able to record corrections durably');
expect('src/libs/agent/prompt.ts', 'Workspace memory', 'standing memory must be injected into the system prompt');
expect('src/app/api/agent/chat/route.ts', 'agentMemory', 'chat turns must load workspace memory');
expect('src/app/api/internal/run-scheduled/route.ts', 'memory: tenant.agentMemory', 'scheduled + mission runs must load workspace memory');

// ── Mission throughput + agent mission control (Phase 28.2 — "missions are
// stalling and Max can't cancel anything") ──────────────────────────────────
expect('src/app/api/internal/run-scheduled/route.ts', 'TASKS_TIME_BUDGET_MS', 'scheduled tasks must not starve the mission runner');
expect('src/app/api/internal/run-scheduled/route.ts', 'STEP_STALE_MS', 'fresh running steps must not be double-run by overlapping ticks');
expect('src/libs/agent/missionTools.ts', '\'set_mission_status\'', 'the agent needs pause/resume/cancel — zombie missions pile up otherwise');
expect('src/libs/agent/missionTools.ts', 'already has', 'start_mission must refuse a pileup of concurrent running missions');

// ── Stock photos + memory secrets rail (Phase 28.1) ─────────────────────────
expect('src/libs/agent/webTools.ts', '\'search_stock_photos\'', 'free stock images (Pexels/Pixabay via env keys) before paid Kie generation');
expect('src/libs/agent/platformTools.ts', 'looks like it contains an API key', 'workspace memory must REJECT credentials — it is injected into every prompt');

// ── Chat UX honesty (Phase 26.1/26.2) ───────────────────────────────────────
expect('src/features/agent/AgentChat.tsx', 'abortRef', 'Stop button must abort the in-flight stream');
expect('src/features/agent/AgentChat.tsx', 'forceScrollRef', 'refresh must land at the NEWEST message, not the oldest');
expect('src/features/agent/AgentChat.tsx', 'clearChat', 'clear-chat control (with consolidation server-side)');
expect('src/app/api/agent/history/route.ts', 'chat-memory-', 'clearing a chat must consolidate durable memory into a note first');

// ── Security tripwires ──────────────────────────────────────────────────────
forbid('src/libs/mcp/stdioClient.ts', '...process.env', 'child MCP processes must NEVER inherit the app env (DB creds, vault master key)');

expect('src/libs/mcp/stdioCatalog.ts', 'STDIO_SERVERS', 'stdio spawning must go through the hardcoded allowlist — never user input');

// ── Stop decoupling + live turn status (Phase 29 — "refreshing the page KILLED
// the running task"). The stream was the ONLY thing driving the loop, so a
// browser refresh / tab close / network blip aborted the fetch and the work
// silently died. Stop is now an explicit server signal; the turn runs
// independent of the socket; a poller shows live progress that survives
// refresh. ──────────────────────────────────────────────────────────────────
expect('src/app/api/agent/chat/route.ts', 'isStopRequested', 'chat loop must stop on an explicit server signal, not a dropped socket');

forbid('src/app/api/agent/chat/route.ts', 'cancelled = true', 'stream cancel (refresh/close) must NOT abort the turn — that is the incident');

expect('src/app/api/agent/stop/route.ts', 'requestStop', 'explicit Stop endpoint must flag the active turn to halt');
expect('src/app/api/agent/status/route.ts', 'getTurn', 'live turn status must be pollable so progress survives a refresh');
expect('src/features/agent/AgentChat.tsx', 'lastTool', 'chat must render live remote progress (iteration + last tool)');

// ── Token diet (Phase 29 — context bloat burned budget + hit limits) ────────
expect('src/libs/agent/loop.ts', 'elided to save context', 'old tool results must be evicted from the running context, not resent forever');
expect('src/libs/mcp/registry.ts', 'load_connection_tools', 'big MCP tool collections defer behind a loader instead of bloating every prompt');
expect('src/libs/agent/missionTools.ts', '12 tool calls', 'start_mission must steer the model to right-sized steps (not "write 20 articles")');

// ── Runner health surfaced to humans (Phase 29 — a dead cron looked like a
// stuck mission). ────────────────────────────────────────────────────────────
expect('src/libs/agent/runnerHealth.ts', 'markTick', 'the runner must record a heartbeat the dashboard can read');
expect('src/app/api/internal/run-scheduled/route.ts', 'markTick', 'every tick must stamp the heartbeat');
expect('src/features/agent/MissionsPanel.tsx', 'lastTickAt', 'missions panel must show runner health, not just per-mission progress');

// ── Deferral must never be a functional wall (Phase 29.1 — "Unknown tool:
// load_connection_tools" blocked ALL GitHub/Zernio/DiviOps work in missions) ──
expect(
  'src/libs/mcp/registry.ts',
  /executors\.get\(namespacedName\)[\s\S]{0,800}NAME_RE\.exec\(namespacedName\)/,
  'resolve() must check the flat executor map BEFORE the mcp__x__y regex — the load_connection_tools meta-tool has a BARE name and was unresolvable',
);
expect('src/libs/mcp/registry.ts', 'attachToolSink', 'newly-loaded deferred schemas must reach the assemblers\' combined tool array, not just the registry\'s own');
expect('src/app/api/agent/chat/route.ts', 'attachToolSink', 'chat: loaded tools must become visible to the model on the next iteration');
expect('src/app/api/approvals/[id]/route.ts', 'attachToolSink', 'approval resume: loaded tools must become visible to the model');
expect('src/app/api/internal/run-scheduled/route.ts', 'attachToolSink', 'mission/task runs: loaded tools must become visible to the model — this is where the incident surfaced');

// ── MCP resource content must be READ, not stubbed (Phase 29.2 — every GitHub
// file read came back as the literal string "[resource]") ──────────────────
expect('src/libs/mcp/registry.ts', 'flattenMcpContent', 'MCP results must decode EmbeddedResource blocks — file reads do not use `text`');

forbid('src/libs/mcp/registry.ts', 'c.type === \'text\' ? c.text ?? \'\' : `[${c.type}]`', 'the naive flattener discarded every non-text block — that is the incident');

// ── Google Analytics + Search Console (Phase 30) ────────────────────────────
expect('src/libs/plugins/googleAnalytics.ts', 'jwt-bearer', 'GA4 must authenticate as a SERVICE ACCOUNT — an OAuth consent screen in Testing expires refresh tokens after 7 days and blinds the agent weekly');
expect('src/libs/plugins/googleAnalytics.ts', '\'ga4_metadata\'', 'the agent must be able to ENUMERATE real dimension/metric names — GA4 has ~200 of them (the Kie free-text-field lesson)');
expect('src/libs/plugins/googleAnalytics.ts', '\'gsc_list_sites\'', 'Search Console site strings (sc-domain: vs https://) cannot be guessed — they must be listed at runtime');
expect('src/libs/plugins/index.ts', 'googleAnalyticsProvider', 'the provider must be registered or it never reaches the admin catalog');

// ── Per-connection built-ins must be CORRECTABLE (Phase 30.1 — a GA4 property
// ID could only be entered wrong, and then could not be fixed) ─────────────
expect('src/features/agent/ToolsPanel.tsx', 'conn.perConnection', 'a per-connection built-in must show Edit — Remove-and-recreate silently drops tool policies (the Phase 11 defect)');
expect('src/libs/plugins/googleAnalytics.ts', 'targetIsUrl: false', 'the GA4 target is a numeric property ID; a URL-shaped form field made the right answer unenterable');

forbid('src/app/api/plugins/route.ts', 'siteUrl: z.string().url()', 'per-connection targets are not all URLs — that validator rejected valid GA4 property IDs');

expect('src/libs/plugins/googleAnalytics.ts', 'avgEngagementSecondsPerSession', 'userEngagementDuration is a TOTAL and was read back as an average — the tool must do the division, not the model');

// ── DiviOps section_replace (2026-09-04 — "fails on pages the runner already
// wrote" + blank pages). Two plugin-side traps, guarded in-process: the plugin
// escapes & < > " -- on write but matches sections by RAW substring, so such a
// label can never be targeted again; and section_replace splices content in
// verbatim, so a divi/placeholder wrapper nests and renders the page blank.
// The vendor's divi-5-builder skill (not in the npm package) is condensed into
// standing guidance — without it the agent writes Divi 5 JSON blind.
expect('src/libs/mcp/stdioCatalog.ts', 'guardCall: diviopsGuard', 'DiviOps section-targeting guard must stay wired to the allowlist entry');
expect('src/libs/mcp/stdioCatalog.ts', 'DIVI_PLACEHOLDER_OPEN', 'section_replace must strip a divi/placeholder wrapper — nested placeholder = blank page');
expect('src/libs/mcp/stdioCatalog.ts', 'guidance: DIVIOPS_GUIDANCE', 'DiviOps authoring rules must reach the system prompt — the vendor skill is not in the npm package');
expect('src/libs/mcp/registry.ts', 'guard(tool.name, args', 'stdio guardCall must run before the call is forwarded to the child');
expect('src/libs/mcp/registry.ts', 'guidanceByProvider.set(`stdio:', 'stdio guidance must join the same system-prompt slot as built-in providers');

// ── WP-CLI over SSH (2026-09-04 — Theo's "missing superpower"). Runs ON the
// live host as the hosting account, and shared-hosting SSH logins are
// account-wide, so the site path is pinned and code-execution subcommands are
// refused in the adapter — the approvals gateway gates tools, not arguments.
// The private key is minted server-side and never leaves the vault.
expect('src/libs/plugins/wpcli.ts', '\'eval\'', 'wp eval (a PHP shell) must stay on the deny list');
expect('src/libs/plugins/wpcli.ts', '\'db query\'', 'arbitrary SQL through wp db query must stay denied');
expect('src/libs/plugins/wpcli.ts', 'DENIED_FLAG_RE', '--path/--url/--ssh/--require must be refused so a connection cannot leave its pinned site');
expect('src/libs/plugins/wpcli.ts', 'map(shellQuote)', 'argv must be shell-quoted element by element — never interpolated into a command string');
expect('src/libs/plugins/wpcli.ts', 'hostVerifier', 'host-key posture is explicit (accept-new); pin fingerprints here when hardening');

forbid('src/app/api/plugins/ssh-key/route.ts', 'privateKeyPem }', 'the ssh-key route must never return the private key');

expect('src/app/api/plugins/ssh-key/route.ts', 'sealSecret(pair.privateKeyPem)', 'generated private keys go straight into the vault');
expect('src/app/api/plugins/route.ts', 'eq(credentials.provider, plugin.slug)', 'a supplied credentialId must be re-scoped to this tenant AND this plugin');
expect('next.config.ts', '\'ssh2\'', 'ssh2 must stay a server-external package like ws');

// ── Report ──────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`\n✗ agent-evals: ${failures.length} of ${checks} tripwires FAILED\n`);
  for (const f of failures) {
    console.error(`  · ${f}`);
  }
  console.error('\nEach tripwire pins a fix for a real incident. If you removed one on purpose,');
  console.error('update this suite in the same commit and say why in the message.\n');
  process.exit(1);
}
console.log(`✓ agent-evals: all ${checks} tripwires pass`);
