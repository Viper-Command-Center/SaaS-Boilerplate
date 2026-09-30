/**
 * Fabricated tool calls (Phase 42).
 *
 * When a tool really runs, loop.ts writes "[tool] calling <name>…" into the
 * streamed reply, and that text is what the transcript stores and what the
 * model sees as its own history next turn. After a long build (200 messages,
 * every one of them full of those markers) Theo (BBI, 2026-09-08) began to
 * WRITE the marker as text instead of emitting a tool_use block — then
 * narrated the results he expected. Two turns, ~25 "calls", zero executed,
 * "confirmed in the database via WP-CLI" included. The owner checked the
 * live site and nothing had changed.
 *
 * The rule: a marker the model wrote is not a call. Detect it in the text
 * blocks of a response that carried no tool_use for that name, strip it from
 * what the user sees, and send the model back to make the real call.
 */

/** Anything that looks like the platform's own call/approval/result markers. */
const MARKER_RE = /^[ \t]*\[(?:tool|approval|artivio|system|platform)\][^\n]*$/gm;
/** The model's other tell: a line that IS a tool name followed by a result-ish narration. */
const CALLING_RE = /^[ \t]*(?:calling|running|executing)[ \t]+(mcp__[\w\-]+|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)…?[ \t]*$/gim;

export type Fabrication = { names: string[]; cleaned: string };

/**
 * Inspect the TEXT the model produced this iteration. `realCalls` are the
 * tool names it actually invoked via tool_use in the same response. Returns
 * the marker-free text and the names it pretended to call, or null when the
 * text is honest.
 */
export function detectFabricatedCalls(text: string, realCalls: Iterable<string>): Fabrication | null {
  const real = new Set([...realCalls].map(n => n.toLowerCase()));
  const names: string[] = [];
  let cleaned = text;
  const nameOf = (line: string, captured?: string): string | undefined => {
    if (captured) {
      return captured;
    }
    // "[tool] calling mcp__x__y…" → "mcp__x__y"; "[artivio] wrote to #46" → "wrote"
    const rest = line.replace(/^[ \t]*\[[a-z]+\][ \t]*/i, '').replace(/^calling[ \t]+/i, '');
    const token = rest.split(/[\s…]/)[0] ?? '';
    return token || undefined;
  };
  for (const re of [MARKER_RE, CALLING_RE]) {
    cleaned = cleaned.replace(re, (line: string, captured?: string) => {
      const name = nameOf(line, typeof captured === 'string' ? captured : undefined);
      // A real marker never appears in the model's own text (the platform
      // appends it after the model's turn), so any marker here is written by
      // the model. Drop the line either way; count it as a fabrication only
      // when no real tool_use for that name accompanied it.
      const n = (name ?? '').toLowerCase();
      if (!n || !real.has(n)) {
        names.push(name ?? line.trim().slice(0, 60));
      }
      return '';
    });
  }
  if (cleaned === text) {
    return null;
  }
  return { names: [...new Set(names)], cleaned: cleaned.replace(/\n{3,}/g, '\n\n').trim() };
}

export function fabricationNudge(names: string[]): string {
  return `[system] Your last reply WROTE ${names.length === 1 ? 'a tool call' : `${names.length} tool calls`} as text (${names.slice(0, 6).join(', ')}${names.length > 6 ? ', …' : ''}) instead of calling ${names.length === 1 ? 'it' : 'them'}. Text like "[tool] calling X…" is an annotation the platform adds AFTER you really call a tool; writing it yourself runs nothing, and any result you described after it does not exist. The lines were removed from what the user sees. Now either make the real tool call (a tool_use block — the user is waiting for the ACTION, not a description of it), or tell the user plainly that it has not been done. Never report a result you did not receive from a tool.`;
}

/**
 * Phase 48.3: a DIFFERENT failure from the fake-marker one above. Here the model
 * doesn't write "[tool] calling X" — it writes a confident completion report
 * ("Migration 100% COMPLETE ✅", "all 4 pages live", "0 defects") in PROSE, with
 * no verifying tool call behind it. Noah shipped exactly this: a full "site
 * complete" summary for pages that did not exist. detectFabricatedCalls can't
 * catch it (there's no marker), so we check the claim against the turn's real
 * tool history: a "done"-class claim is only trustworthy if THIS turn actually
 * read the result back (a render/preview/get/list style verification tool ran).
 */
const COMPLETION_CLAIM_RE = /\b(?:100%\s*complete|migration\s+complete|fully\s+complete|all\s+(?:\d+\s+)?pages?\s+(?:are\s+)?(?:live|built|complete|published)|everything\s+is\s+(?:done|complete|live)|site[- ]wide\s+verification\s+complete|0\s+(?:layout\s+)?defects|ready\s+for\s+review|successfully\s+(?:built|migrated|created|deployed|published|completed)|(?:build|site|page)\s+is\s+(?:now\s+)?(?:complete|done|live))\b/i;
/** Tool-name fragments that count as real verification (a read-back of state). */
const VERIFY_TOOL_RE = /(?:render[_-]?preview|page[_-]?get|page[_-]?list|get[_-]?layout|section[_-]?get|validate[_-]?blocks|migration[_-]?read|migration[_-]?list|render[_-]?check|content[_-]?get|wp[_-]?rest|fetch[_-]?url)/i;

/**
 * True when `text` makes a completion/verification claim that NO verification
 * tool in `toolsUsedThisTurn` backs up. Returns null when the claim is either
 * absent or actually verified.
 */
export function detectUnverifiedCompletion(
  text: string,
  toolsUsedThisTurn: Iterable<string>,
): string | null {
  if (!COMPLETION_CLAIM_RE.test(text)) {
    return null;
  }
  for (const name of toolsUsedThisTurn) {
    if (VERIFY_TOOL_RE.test(name)) {
      return null; // a real read-back ran this turn — the claim may stand
    }
  }
  return '[system] You just reported work as COMPLETE / verified, but this turn made no tool call that read the result back (no render preview, page get/list, validate, or migration read). A completion claim you did not verify with a tool is exactly the false "done" report that must never happen. Do NOT tell the user it is complete. Either run the real verification now (e.g. diviops_render_preview / diviops_page_list / migration_read and quote what it actually returns), or state plainly what is done, what is unverified, and what remains. Report only what a tool result proved.';
}

/**
 * Phase 48.7 (2026-09-30, Copetown): a mission-executor-level failure, distinct
 * from the two chat-level ones above. The tool loop can return WITHOUT throwing
 * and without exhausting its budget even when the actual work failed — e.g. the
 * DiviOps MCP was down, so the model tried, got "server is not running" back,
 * and wrote an honest "I couldn't do this" summary. The runner marked such a
 * step [done] purely because the loop returned normally, storing that failure
 * prose as the step "result", and marched the mission to the next step. Build-3
 * ended with ZERO pages while steps 2–4 read [done].
 *
 * The runner cannot trust prose. This inspects a finished step's own summary
 * for admissions that it did NOT complete — a connection outage, a platform
 * error it hit, or an explicit "not completed / could not". When the text says
 * the work didn't happen, the step must be treated as failed, not done.
 */
const SELF_REPORTED_FAILURE_RE = /\b(?:not\s+(?:completed|finished|done|built|created|possible)|could\s+not\s+(?:complete|finish|build|create|be\s+(?:completed|done))|couldn['’]t\s+(?:complete|finish|build|create)|unable\s+to\s+(?:complete|finish|build|create|proceed)|(?:server|connection|service|mcp|diviops|tool)\s+(?:is\s+)?(?:not\s+(?:running|responding|available|reachable)|down|unavailable|unreachable|stopped\s+responding)|platform\s+error|not\s+something\s+(?:fixable|i\s+can\s+fix)|no\s+(?:pages?|content)\s+(?:were|was)\s+(?:created|built|written)|nothing\s+(?:was|has\s+been)\s+(?:built|created|written|persisted)|dry\s+run|escalat(?:e|ing|ed)\b|report_issue)\b/i;

/**
 * True when a step's own final summary admits the work did NOT complete (an
 * outage, an error, an explicit "not completed"), so the runner should record
 * the step as failed rather than done. Returns the matched phrase for the
 * step's stored result, or null when the summary reads as genuine completion.
 */
export function detectSelfReportedFailure(stepResultText: string): string | null {
  const m = SELF_REPORTED_FAILURE_RE.exec(stepResultText);
  return m ? m[0] : null;
}

/**
 * Tool-name fragments that COUNT as a real, state-changing or state-reading
 * action for a build/migration step — a step that claims to have built a page
 * but ran none of these did no verifiable work. Broader than VERIFY_TOOL_RE
 * (which is read-back only): a mutating write here is also proof the step
 * actually did something rather than only narrating.
 */
const PRODUCTIVE_TOOL_RE = /(?:create|update|append|insert|replace|write|upload|save|delete|trash|move|build|render|preview|page[_-]?get|page[_-]?list|get[_-]?layout|validate|migration[_-]?read|scrape|browse|wp[_-]?rest|wp[_-]?cli|content[_-]?get|fetch[_-]?url)/i;

/**
 * Bookkeeping / planning tools that are NOT productive build work even though
 * their names contain a productive-looking verb — mission control and memory
 * writes (get_mission, update_mission_step, start_mission, update_memory, …).
 * A step that only touched these built or verified nothing. Checked BEFORE the
 * productive test so e.g. update_memory doesn't read as a real "update".
 */
const BOOKKEEPING_TOOL_RE = /mission|memory/i;

/**
 * True when NONE of the tools a build/migration step ran were productive —
 * i.e. the step called no tool that could create, change, or read back real
 * state. Such a step "finished" by talking only, so its [done] would be false.
 * Returns null (trustworthy) when at least one productive tool ran, or when no
 * tools were expected (an empty list means the caller opted out of this check).
 */
export function ranNoProductiveTool(toolsUsed: Iterable<string>): boolean {
  const names = [...toolsUsed].filter(n => !BOOKKEEPING_TOOL_RE.test(n));
  if (names.length === 0) {
    return true;
  }
  return !names.some(n => PRODUCTIVE_TOOL_RE.test(n));
}
