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
expect('src/app/api/missions/route.ts', "'pause'", 'humans need a pause control for running missions');

// ── Panel truthfulness (duplicate-week-panels incident) ─────────────────────
expect('src/app/api/panels/route.ts', 'config.filter', 'table panels without filters all render the same newest slice');
expect('src/app/api/panels/route.ts', 'sortBy', 'sorted panels must be resolved server-side in display order');

// ── Money + provider resilience (P0) ────────────────────────────────────────
expect('src/libs/agent/anthropic.ts', 'postWithRetry', 'transient 429/5xx/529 must retry with backoff, not kill the turn');
expect('src/app/api/agent/chat/route.ts', 'checkRateLimit', 'per-tenant velocity guard — a runaway client is a money problem');
expect('src/libs/mcp/registry.ts', "?? 'approval'", 'unknown MCP tools must DEFAULT to approval, never auto');

// ── Chat UX honesty (Phase 26.1/26.2) ───────────────────────────────────────
expect('src/features/agent/AgentChat.tsx', 'abortRef', 'Stop button must abort the in-flight stream');
expect('src/features/agent/AgentChat.tsx', 'forceScrollRef', 'refresh must land at the NEWEST message, not the oldest');
expect('src/features/agent/AgentChat.tsx', 'clearChat', 'clear-chat control (with consolidation server-side)');
expect('src/app/api/agent/history/route.ts', 'chat-memory-', 'clearing a chat must consolidate durable memory into a note first');

// ── Security tripwires ──────────────────────────────────────────────────────
forbid('src/libs/mcp/stdioClient.ts', '...process.env', 'child MCP processes must NEVER inherit the app env (DB creds, vault master key)');
expect('src/libs/mcp/stdioCatalog.ts', 'STDIO_SERVERS', 'stdio spawning must go through the hardcoded allowlist — never user input');

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
