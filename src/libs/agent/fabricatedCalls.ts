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
