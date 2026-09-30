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
