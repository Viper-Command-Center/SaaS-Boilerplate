/**
 * Loops (loops.so) — built-in provider (per-connection, bring-your-own API key).
 *
 * WHY A BUILT-IN AND NOT AN MCP CONNECTION
 * Loops does publish a hosted MCP (https://mcp.loops.so), but it authenticates
 * with OAuth to a person's Loops login. Artivio's MCP client sends static
 * headers only, so an API key can never satisfy it — the same wall as
 * Cloudflare's and HeyGen's hosted servers (see "the OAuth wall" in CLAUDE.md).
 * The REST API takes a plain Bearer key and is small, so an in-app adapter is
 * the route that works for every workspace (ADR #3b).
 *
 * The adapter also earns its keep in three places a passthrough would not:
 *
 *  1. CONTENT. Loops email bodies are LMX — an XML dialect of PascalCase tags
 *     that is neither HTML nor Markdown, with variables that must be prefixed
 *     ({contact.firstName}) and fallbacks that live in a SEPARATE field. A model
 *     asked to "write the email" produces HTML or Markdown every time, and
 *     Loops answers 422. So the content tools accept Markdown and convert it
 *     here, and lint raw LMX before spending a call.
 *
 *  2. REVISIONS. Every content update needs the email's current revision id.
 *     The adapter reads it, so the agent never has to carry one around — and
 *     when the agent DOES pass the one it read earlier, a human's edit in the
 *     Loops editor in the meantime is refused instead of overwritten.
 *
 *  3. BLAST RADIUS. A campaign goes to a whole audience and cannot be recalled.
 *     Previews only go to the addresses configured on the connection (never to
 *     an address the model chose), scheduling runs a pre-flight, and the tools
 *     that reach a real inbox or change a contact are in `alwaysAsk`, so they
 *     stop for a human even when the connection is set to Auto.
 *
 * Per-connection config (stored on the mcp_connection, not the catalog):
 *   target     = preview recipient address(es), comma-separated
 *   credential = that workspace's own Loops API key (Loops → Settings → API)
 *
 * WHY THE TARGET IS "PREVIEW RECIPIENTS" AND NOT A URL
 * Loops has one API host for everyone, so there is no site to point at. What
 * does differ per workspace — and what an agent must never guess — is whose
 * inbox a test email may land in. Answered once by the person who connects the
 * account, it turns "send me a preview" into a call with no address in it.
 *
 * NO METERING: the Loops API is free to call (plans are priced on contacts),
 * so there are no `units` and no price rule — and none of the Phase 18
 * silent-$0 risk.
 *
 * Schemas below were read from Loops' own OpenAPI document (v1.22) and the LMX
 * reference, not recalled. Docs: https://loops.so/docs/api-reference
 */

import type { BuiltinProvider, BuiltinTool } from '@/libs/plugins/types';
import { getFile } from '@/libs/storage/files';
import { getObject } from '@/libs/storage/r2';

const API = 'https://app.loops.so/api/v1';
const MAX_OUTPUT = 120_000;
/** Loops rejects LMX bodies above 100KB with a 413. */
const MAX_LMX_BYTES = 100_000;
/** Uploads API ceiling (bytes) and the only image types it accepts. */
const MAX_IMAGE_BYTES = 4_000_000;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_PREVIEW_RECIPIENTS = 10;

/**
 * Tools that stop for a human even when the connection is set to Auto.
 * Everything here either puts real email in a real inbox or changes who is
 * subscribed. Drafting, previews (to the configured addresses only) and reads
 * follow the connection's own policy.
 */
export const LOOPS_ALWAYS_ASK = [
  'set_campaign_schedule',
  'send_event',
  'send_transactional',
  'upsert_contact',
];

// ── HTTP ─────────────────────────────────────────────────────────────────────

export class LoopsError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'LoopsError';
    this.status = status;
  }
}

type LoopsInit = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Appended to the error for this call only — the "so do this next". */
  hints?: Partial<Record<number, string>>;
};

function loopsMessage(body: any, text: string): string {
  const m = body?.message ?? body?.error?.message ?? (typeof body?.error === 'string' ? body.error : undefined);
  if (typeof m === 'string' && m.trim()) {
    return m.trim();
  }
  return text.slice(0, 400) || 'no detail returned';
}

/**
 * One Loops request. 429 is retried once after a short pause (the limit is 10
 * requests/second and a 429 means the request was NOT processed, so a retry
 * cannot double-send).
 */
async function loops(path: string, key: string, init?: LoopsInit): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(`${API}${path}`, {
        method: init?.method ?? 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${key}`,
          ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(init?.headers ?? {}),
        },
        ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch (err) {
      throw new Error(`Could not reach Loops: ${err instanceof Error ? err.message : 'network error'}`);
    }

    if (resp.status === 429 && attempt === 0 && !init?.hints?.[429]) {
      await new Promise(resolve => setTimeout(resolve, 1200));
      continue;
    }

    const text = await resp.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }

    if (!resp.ok) {
      const detail = loopsMessage(body, text);
      let hint = init?.hints?.[resp.status];
      if (!hint && resp.status === 401) {
        hint = path.startsWith('/api-key')
          ? 'The API key on this connection is wrong or was revoked. Create a key in Loops → Settings → API and update the connection in the Tools panel.'
          : 'Either the API key is wrong or revoked, or the Content API is not enabled for this Loops team (campaign, email-content, segment and upload endpoints need it). Run loops_status to see which.';
      }
      if (!hint && resp.status === 429) {
        hint = 'Rate limited by Loops (10 requests/second; content endpoints 60/minute). Wait a moment and try again.';
      }
      throw new LoopsError(resp.status, `Loops ${resp.status}: ${detail}${hint ? ` — ${hint}` : ''}`);
    }

    return body ?? {};
  }
}

/** Trim provider payloads so one call can't eat the context window. */
function out(value: unknown): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > MAX_OUTPUT
    ? `${s.slice(0, MAX_OUTPUT)}\n…truncated (${s.length} chars). Ask for less — a smaller page, or includeContent:false.`
    : s;
}

function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v).trim();
}

function need(args: Record<string, unknown>, name: string, why?: string): string {
  const v = str(args[name]);
  if (!v) {
    throw new Error(`Provide ${name}.${why ? ` ${why}` : ''}`);
  }
  return v;
}

function pageQuery(args: Record<string, unknown>, fallback = 20): string {
  const n = Number(args.perPage);
  const perPage = Math.min(50, Math.max(10, Number.isFinite(n) && n > 0 ? Math.round(n) : fallback));
  const p = new URLSearchParams({ perPage: String(perPage) });
  const cursor = str(args.cursor);
  if (cursor) {
    p.set('cursor', cursor);
  }
  return p.toString();
}

// ── Connection target: preview recipients ────────────────────────────────────

const EMAIL_RE = /^[^\s@<>(),;]+@[^\s@<>(),;.]+(?:\.[^\s@<>(),;.]+)+$/;

/** "a@x.com, b@y.com" → ['a@x.com','b@y.com'] (deduped, lower-cased). */
export function parseRecipients(target: string | undefined): string[] {
  const seen = new Set<string>();
  for (const raw of String(target ?? '').split(/[\s,;]+/)) {
    const email = raw.trim().toLowerCase();
    if (email && EMAIL_RE.test(email)) {
      seen.add(email);
    }
  }
  return [...seen].slice(0, MAX_PREVIEW_RECIPIENTS);
}

/**
 * Which addresses a preview may go to. Only ever a subset of what the person
 * who connected the account typed in — an address the model supplies that is
 * not on that list is refused, not sent.
 */
export function previewRecipients(target: string | undefined, requested: unknown): string[] {
  const allowed = parseRecipients(target);
  if (!allowed.length) {
    throw new Error(
      'This Loops connection has no preview recipients configured, so a preview has nowhere safe to go. Ask the workspace owner to add their address under Tools → Loops → Edit → Preview recipients.',
    );
  }
  const asked = (Array.isArray(requested) ? requested : requested === undefined || requested === null || requested === '' ? [] : [requested])
    .flatMap(v => String(v).split(/[\s,;]+/))
    .map(v => v.trim().toLowerCase())
    .filter(Boolean);
  if (!asked.length) {
    return allowed;
  }
  const refused = asked.filter(a => !allowed.includes(a));
  if (refused.length) {
    throw new Error(
      `Previews can only go to the addresses configured on this connection (${allowed.join(', ')}). Not sent to: ${refused.join(', ')}. To preview to someone else, the workspace owner adds them under Tools → Loops → Edit.`,
    );
  }
  return [...new Set(asked)];
}

// ── Markdown → LMX ───────────────────────────────────────────────────────────

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function attr(s: string): string {
  return escapeXml(s).replace(/"/g, '&quot;');
}

/** Private-use sentinels that wrap a stash index; stripped from input first. */
const STASH_OPEN = '\uE000';
const STASH_CLOSE = '\uE001';
const STASH_RE = /\uE000(\d+)\uE001/g;

function renderInline(src: string, stash: string[]): string {
  const keep = (s: string) => {
    stash.push(s);
    return `${STASH_OPEN}${stash.length - 1}${STASH_CLOSE}`;
  };

  // Code spans first: nothing inside them is formatting.
  let s = src.replace(/`([^`\n]+)`/g, (_m, code: string) => keep(`<Code>${escapeXml(code)}</Code>`));

  // [text](url)
  s = s.replace(/\[([^\]\n]+)\]\(\s*([^\s)]+)\s*\)/g, (_m, text: string, url: string) =>
    keep(`<Link href="${attr(url)}">${renderInline(text, stash)}</Link>`));

  // Bare URLs — email clients do not reliably auto-link, so make it explicit.
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>()]*[^\s<>().,!?;:'"])/g, (_m, lead: string, url: string) =>
    `${lead}${keep(`<Link href="${attr(url)}">${escapeXml(url)}</Link>`)}`);

  s = escapeXml(s);

  s = s
    .replace(/\*\*([^*\n]+)\*\*/g, '<Strong>$1</Strong>')
    .replace(/~~([^~\n]+)~~/g, '<Strike>$1</Strike>')
    .replace(/(^|[^*\w])\*([^*\s][^*\n]*)\*(?![*\w])/g, '$1<Em>$2</Em>');

  return s;
}

/** Inline Markdown (bold, italic, strike, code, links) → LMX inline tags. */
export function inlineToLmx(src: string): string {
  const stash: string[] = [];
  let s = renderInline(src.replace(/[\uE000\uE001]/g, ''), stash);
  // Stashed fragments can contain other placeholders (code inside a link).
  for (let i = 0; i < 6 && s.includes(STASH_OPEN); i++) {
    s = s.replace(STASH_RE, (_m, n: string) => stash[Number(n)] ?? '');
  }
  return s;
}

/** Button labels are plain text in LMX — strip Markdown markers, keep variables. */
function plainLabel(src: string): string {
  return escapeXml(src.replace(/\*\*|~~|`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim());
}

/**
 * Convert the Markdown a model naturally writes into LMX.
 *
 * Supported: # / ## / ### headings · paragraphs (a single newline is a line
 * break — in an email, "Thanks,⏎Ryan" means two lines) · - and 1. lists ·
 * > quotes · --- divider · ``` code fences · **bold** *italic* ~~strike~~
 * `code` [links](url) · [button: Label](url) on its own line ·
 * ![alt](loops-hosted-url) on its own line · and raw LMX blocks (a block that
 * starts with a PascalCase tag is passed through untouched, so <Columns>,
 * <Section>, <Component /> and <Style /> can be mixed in).
 *
 * Variables such as {contact.firstName} pass through unchanged.
 */
export function markdownToLmx(markdown: string): string {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: string[] = [];
  let para: string[] = [];

  const flush = () => {
    if (para.length) {
      blocks.push(`<Paragraph>${para.map(inlineToLmx).join('<Br />')}</Paragraph>`);
      para = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();

    if (!line) {
      flush();
      continue;
    }

    // ``` fenced code
    if (line.startsWith('```')) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith('```')) {
        code.push(lines[i] ?? '');
        i++;
      }
      blocks.push(`<CodeBlock>${escapeXml(code.join('\n'))}</CodeBlock>`);
      continue;
    }

    // Raw LMX block — passed through until the next blank line.
    if (/^<\/?[A-Z][A-Za-z0-9]*[\s>/]/.test(line)) {
      flush();
      const raw: string[] = [line];
      while (i + 1 < lines.length && (lines[i + 1] ?? '').trim()) {
        i++;
        raw.push((lines[i] ?? '').trim());
      }
      blocks.push(raw.join('\n'));
      continue;
    }

    const heading = /^(#{1,6})\s+(\S.*)$/.exec(line);
    if (heading) {
      flush();
      const level = Math.min(3, heading[1]!.length);
      const text = heading[2]!.replace(/[#\s]+$/, '');
      blocks.push(`<H${level}>${inlineToLmx(text)}</H${level}>`);
      continue;
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) {
      flush();
      blocks.push('<Divider />');
      continue;
    }

    const button = /^\[button:([^\]]+)\]\(\s*([^\s)]+)\s*\)$/i.exec(line);
    if (button) {
      flush();
      blocks.push(`<Button href="${attr(button[2]!)}" align="center">${plainLabel(button[1]!)}</Button>`);
      continue;
    }

    const image = /^!\[([^\]]*)\]\(\s*([^\s)]+)\s*\)$/.exec(line);
    if (image) {
      flush();
      blocks.push(`<Image src="${attr(image[2]!)}"${image[1] ? ` alt="${attr(image[1])}"` : ''} />`);
      continue;
    }

    const bullet = /^[-*+]\s+(\S.*)$/.exec(line);
    const ordered = /^\d+[.)]\s+(\S.*)$/.exec(line);
    if (bullet || ordered) {
      flush();
      const re = bullet ? /^[-*+]\s+(\S.*)$/ : /^\d+[.)]\s+(\S.*)$/;
      const items: string[] = [(bullet ?? ordered)![1]!];
      while (i + 1 < lines.length) {
        const next = re.exec((lines[i + 1] ?? '').trim());
        if (!next) {
          break;
        }
        items.push(next[1]!);
        i++;
      }
      const tag = bullet ? 'UnorderedList' : 'OrderedList';
      blocks.push(`<${tag}>${items.map(it => `<ListItem>${inlineToLmx(it)}</ListItem>`).join('')}</${tag}>`);
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      const q: string[] = [quote[1]!];
      while (i + 1 < lines.length) {
        const next = /^>\s?(.*)$/.exec((lines[i + 1] ?? '').trim());
        if (!next) {
          break;
        }
        q.push(next[1]!);
        i++;
      }
      blocks.push(`<Quote>${q.filter(Boolean).map(inlineToLmx).join('<Br />')}</Quote>`);
      continue;
    }

    para.push(line);
  }
  flush();

  return blocks.join('\n');
}

// ── LMX lint ─────────────────────────────────────────────────────────────────

const LMX_TAGS = new Set([
  'Style',
  'H1',
  'H2',
  'H3',
  'Paragraph',
  'Quote',
  'CodeBlock',
  'Button',
  'Image',
  'Divider',
  'OrderedList',
  'UnorderedList',
  'ListItem',
  'Columns',
  'ColumnItem',
  'Component',
  'Section',
  'Icons',
  'Icon',
  'Br',
  'Strong',
  'Em',
  'Underline',
  'Code',
  'Strike',
  'Text',
  'Link',
]);

const HTML_TO_LMX: Record<string, string> = {
  p: '<Paragraph>',
  div: '<Section> or <Paragraph>',
  span: '<Text>',
  br: '<Br />',
  a: '<Link href="…">',
  b: '<Strong>',
  strong: '<Strong>',
  i: '<Em>',
  em: '<Em>',
  u: '<Underline>',
  s: '<Strike>',
  h1: '<H1>',
  h2: '<H2>',
  h3: '<H3>',
  h4: '<H3>',
  ul: '<UnorderedList>',
  ol: '<OrderedList>',
  li: '<ListItem>',
  img: '<Image src="…" /> (src from upload_image)',
  hr: '<Divider />',
  blockquote: '<Quote>',
  pre: '<CodeBlock>',
  code: '<Code>',
  button: '<Button href="…">',
  table: '<Columns> with <ColumnItem>',
};

function withoutCodeBlocks(lmx: string): string {
  return lmx.replace(/<CodeBlock\b[^>]*>[\s\S]*?<\/CodeBlock>/g, '<CodeBlock></CodeBlock>');
}

/** Contact properties the LMX references, e.g. ['firstName', 'plan']. */
export function contactVariables(lmx: string): string[] {
  const found = new Set<string>();
  for (const m of withoutCodeBlocks(lmx).matchAll(/\{contact\.([A-Z_]\w*)\}/gi)) {
    found.add(m[1]!);
  }
  return [...found];
}

/**
 * Catch what Loops would reject (or silently mis-send) BEFORE spending a call.
 * Not a full validator — Loops' own compiler is the authority and its 422 is
 * passed through — but these are the mistakes every model makes first.
 */
export function lintLmx(lmx: string): string[] {
  const problems: string[] = [];
  const body = withoutCodeBlocks(lmx);

  if (!body.trim()) {
    return ['The email body is empty.'];
  }
  if (new TextEncoder().encode(lmx).length > MAX_LMX_BYTES) {
    problems.push('The body is over Loops\' 100KB limit. Shorten it.');
  }

  const bad = new Set<string>();
  for (const m of body.matchAll(/<\/?([A-Z][\w-]*)/gi)) {
    const tag = m[1]!;
    if (!LMX_TAGS.has(tag)) {
      bad.add(tag);
    }
  }
  for (const tag of bad) {
    const lower = tag.toLowerCase();
    if (lower.startsWith('mj-')) {
      problems.push(`<${tag}> is MJML. Loops uses LMX, not MJML.`);
    } else if (HTML_TO_LMX[lower]) {
      problems.push(`<${tag}> is HTML, not LMX — use ${HTML_TO_LMX[lower]}. (Or pass the content as "markdown" and let the platform convert it.)`);
    } else {
      problems.push(`<${tag}> is not an LMX tag. Valid tags: ${[...LMX_TAGS].join(', ')}.`);
    }
  }

  const flagged = new Set<string>();
  for (const m of body.matchAll(/\{([^{}\n]{1,120})\}/g)) {
    const inner = m[1]!.trim();
    if (flagged.has(inner)) {
      continue;
    }
    if (/^contact\.[A-Z_]\w*$/i.test(inner)) {
      continue;
    }
    if (/^(?:event|data)\.[A-Z_]\w*$/i.test(inner)) {
      flagged.add(inner);
      problems.push(`{${inner}} cannot be used in a campaign — {event.*} only exists in workflow emails and {data.*} only in transactional emails. Campaigns can use {contact.*}.`);
      continue;
    }
    if (/^[A-Z_]\w*$/i.test(inner)) {
      flagged.add(inner);
      problems.push(`{${inner}} is missing its prefix — write {contact.${inner}}.`);
      continue;
    }
    if (/^(?:contact\.)?[A-Z_]\w*\s*(?:\|\|?|\?\?|:|,|\bor\b|\bdefault\b)/i.test(inner) || /^[A-Z_]+:[\w.]+$/.test(inner)) {
      flagged.add(inner);
      problems.push(`{${inner}} — LMX has no inline fallbacks or editor-style tags. Write {contact.<property>} and pass the default in "fallbacks", e.g. fallbacks: {"firstName": "there"}.`);
    }
  }

  return problems;
}

type Content = { lmx: string; source: 'markdown' | 'lmx' };

/** Resolve the body from tool args: `markdown` (converted) or raw `lmx`. */
export function resolveContent(args: Record<string, unknown>): Content | null {
  const md = typeof args.markdown === 'string' ? args.markdown : '';
  const raw = typeof args.lmx === 'string' ? args.lmx : '';
  if (md.trim() && raw.trim()) {
    throw new Error('Pass the body as "markdown" OR "lmx", not both.');
  }
  if (!md.trim() && !raw.trim()) {
    return null;
  }
  let lmx = md.trim() ? markdownToLmx(md) : raw.trim();
  const themeId = str(args.themeId);
  if (themeId && !/<Style\b/.test(lmx)) {
    lmx = `<Style themeId="${attr(themeId)}" />\n${lmx}`;
  }
  const problems = lintLmx(lmx);
  if (problems.length) {
    throw new Error(`The email body is not valid for Loops — nothing was saved.\n- ${problems.join('\n- ')}`);
  }
  return { lmx, source: md.trim() ? 'markdown' : 'lmx' };
}

// ── Email message fields ─────────────────────────────────────────────────────

/** Loops wants the sender as the part BEFORE the @ — it appends the sending domain. */
export function senderLocalPart(value: unknown): string | undefined {
  const v = str(value);
  if (!v) {
    return undefined;
  }
  return v.includes('@') ? v.slice(0, v.indexOf('@')) : v;
}

function stringMap(value: unknown, name: string): Record<string, string> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object of string values, e.g. {"firstName": "there"}.`);
  }
  const outMap: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // Tolerate "contact.firstName" as a key — the API wants the bare name.
    outMap[k.replace(/^contact\./, '')] = String(v ?? '');
  }
  return Object.keys(outMap).length ? outMap : undefined;
}

/** The email-message fields present in these args (excluding the revision id). */
export function emailFields(args: Record<string, unknown>, content: Content | null): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const k of ['subject', 'previewText', 'fromName', 'replyToEmail'] as const) {
    if (typeof args[k] === 'string') {
      body[k] = String(args[k]).trim();
    }
  }
  const from = senderLocalPart(args.fromEmail);
  if (from) {
    body.fromEmail = from;
  }
  if (content) {
    body.lmx = content.lmx;
  }
  const fallbacks = stringMap(args.fallbacks, 'fallbacks');
  if (fallbacks) {
    body.contactPropertiesFallbacks = fallbacks;
  }
  return body;
}

const CONTENT_HINTS: Partial<Record<number, string>> = {
  409: 'Either the campaign is no longer a Draft (sent and scheduled campaigns cannot be edited), or the email was changed in Loops since it was read. Call get_campaign for the current state and re-apply the change.',
  413: 'The body is over Loops\' 100KB limit.',
  422: 'Loops could not compile the LMX. Images must use a URL returned by upload_image; text cannot sit at the top level outside a block tag; variables must be {contact.name}. Passing the body as "markdown" avoids most of this.',
};

async function saveEmail(
  key: string,
  emailMessageId: string,
  fields: Record<string, unknown>,
  expectedRevisionId: string | null | undefined,
): Promise<any> {
  let revision = expectedRevisionId;
  if (revision === undefined) {
    const current = await loops(`/email-messages/${encodeURIComponent(emailMessageId)}`, key);
    revision = current?.contentRevisionId ?? null;
  }
  return loops(`/email-messages/${encodeURIComponent(emailMessageId)}`, key, {
    method: 'POST',
    body: { ...fields, ...(revision ? { expectedRevisionId: revision } : {}) },
    hints: CONTENT_HINTS,
  });
}

async function guardian(key: string, emailMessageId: string): Promise<{ errors: any[]; warnings: any[] }> {
  const res = await loops(`/email-messages/${encodeURIComponent(emailMessageId)}/guardian`, key);
  const slim = (list: unknown) =>
    (Array.isArray(list) ? list : []).map((g: any) => ({
      rule: g?.rule,
      title: g?.title,
      description: g?.description,
      ...(Array.isArray(g?.items) && g.items.length ? { items: g.items.map((it: any) => it?.label ?? it?.codeName) } : {}),
    }));
  return { errors: slim(res?.errors), warnings: slim(res?.warnings) };
}

/** Guardian must never be the reason a save is reported as failed. */
async function guardianSafe(key: string, emailMessageId: string) {
  try {
    return await guardian(key, emailMessageId);
  } catch (err) {
    return { unavailable: err instanceof Error ? err.message : 'could not run checks' };
  }
}

// ── Audience ─────────────────────────────────────────────────────────────────

const FILTER_HELP
  = 'filter = {"match": "all"|"any", "conditions": [...]}. Condition shapes: '
    + '{"type":"property","key":"<contact property>","operator":"equals|notEquals|contains|notContains|greaterThan|lessThan|isTrue|isFalse|empty|notEmpty|any|after|before|between|dateEmpty|dateNotEmpty","value":…} '
    + '(no value for isTrue/isFalse/empty/notEmpty; {"from","to"} ISO dates for between) · '
    + '{"type":"optIn","status":"accepted|pending|rejected"} · '
    + '{"type":"activity","action":"sent|opened|clicked","negate":false,"target":"campaign|workflow|workflowEmail","id":"<id>"}.';

export function checkFilter(value: unknown): { match: string; conditions: unknown[] } {
  const f = value as { match?: unknown; conditions?: unknown } | null;
  if (!f || typeof f !== 'object' || Array.isArray(f)) {
    throw new Error(`filter must be an object. ${FILTER_HELP}`);
  }
  if (f.match !== 'all' && f.match !== 'any') {
    throw new Error(`filter.match must be "all" or "any". ${FILTER_HELP}`);
  }
  if (!Array.isArray(f.conditions) || !f.conditions.length) {
    throw new Error(`filter.conditions must be a non-empty array. ${FILTER_HELP}`);
  }
  for (const c of f.conditions as Array<Record<string, unknown>>) {
    if (!c || !['property', 'optIn', 'activity'].includes(String(c.type))) {
      throw new Error(`Each filter condition needs type "property", "optIn" or "activity". ${FILTER_HELP}`);
    }
    if (c.type === 'property' && (!str(c.key) || !str(c.operator))) {
      throw new Error(`A property condition needs "key" and "operator". ${FILTER_HELP}`);
    }
  }
  return { match: f.match, conditions: f.conditions };
}

/**
 * Audience fields for create/update-campaign.
 *
 * Loops' rule (from its docs): a segment and a filter can be combined, but
 * setting one WITHOUT the other clears the other. So what is not named here is
 * sent as null on purpose — the result is exactly what the call describes.
 */
export function audienceBody(args: Record<string, unknown>): Record<string, unknown> | null {
  const list = str(args.mailingListId);
  const segment = str(args.audienceSegmentId);
  const hasFilter = args.filter !== undefined && args.filter !== null;
  const all = args.allContacts === true;

  if (all && (list || segment || hasFilter)) {
    throw new Error('allContacts:true means the whole subscribed audience — do not combine it with a list, segment or filter.');
  }
  if (!all && !list && !segment && !hasFilter) {
    return null;
  }
  return {
    mailingListId: list || null,
    audienceSegmentId: segment || null,
    audienceFilter: hasFilter ? checkFilter(args.filter) : null,
  };
}

function describeAudience(c: any): string {
  const parts: string[] = [];
  if (c?.mailingListId) {
    parts.push(`mailing list ${c.mailingListId}`);
  }
  if (c?.audienceSegmentId) {
    parts.push(`segment ${c.audienceSegmentId}`);
  }
  if (c?.audienceFilter?.conditions?.length) {
    parts.push(`a filter (${c.audienceFilter.match} of ${c.audienceFilter.conditions.length} condition${c.audienceFilter.conditions.length === 1 ? '' : 's'})`);
  }
  return parts.length ? parts.join(' + ') : 'ALL subscribed contacts (no list, segment or filter set)';
}

function slimCampaign(c: any) {
  return {
    campaignId: c?.id,
    name: c?.name,
    status: c?.status,
    url: c?.url,
    emailMessageId: c?.emailMessageId ?? null,
    audience: describeAudience(c),
    mailingListId: c?.mailingListId ?? null,
    audienceSegmentId: c?.audienceSegmentId ?? null,
    audienceFilter: c?.audienceFilter ?? null,
    scheduling: c?.scheduling ?? null,
    updatedAt: c?.updatedAt,
  };
}

async function campaignWithEmail(key: string, campaignId: string): Promise<{ campaign: any; emailMessageId: string }> {
  const campaign = await loops(`/campaigns/${encodeURIComponent(campaignId)}`, key);
  const emailMessageId = str(campaign?.emailMessageId);
  if (!emailMessageId) {
    throw new Error(`Campaign ${campaignId} has no email message attached — open it in Loops (${campaign?.url ?? 'app.loops.so'}) to check it.`);
  }
  return { campaign, emailMessageId };
}

// ── Tools ────────────────────────────────────────────────────────────────────

const CONTENT_PROPS = {
  markdown: {
    type: 'string',
    description:
      'The email body as Markdown — PREFERRED. The platform converts it to Loops\' LMX. Supports #/##/### headings, paragraphs (a single newline is a line break), - and 1. lists, > quotes, --- dividers, **bold**, *italic*, [links](https://…), a button as its own line "[button: Label](https://…)", and an image as its own line "![alt](url-from-upload_image)". Personalise with {contact.firstName} (any contact property). Do NOT add an unsubscribe link or postal address — Loops appends the footer itself.',
  },
  lmx: {
    type: 'string',
    description:
      'The email body as raw LMX, for layouts Markdown cannot express (<Columns>, <Section>, <Component />, <Style />). LMX is XML with PascalCase tags — NOT HTML. Pass this OR markdown, never both.',
  },
  fallbacks: {
    type: 'object',
    description:
      'Default text for contact properties when a contact has none, keyed by property name — e.g. {"firstName": "there"} makes "Hi {contact.firstName}" read "Hi there". Required for every {contact.*} variable used, or Loops flags the email. LMX has no inline fallback syntax.',
  },
  themeId: { type: 'string', description: 'Optional theme id from list_design_assets. Omit to use the team\'s default theme.' },
} as const;

const EMAIL_PROPS = {
  subject: { type: 'string', description: 'Subject line. May contain {contact.*} variables.' },
  previewText: { type: 'string', description: 'The grey preview line inboxes show after the subject.' },
  fromName: { type: 'string', description: 'Sender display name. Omit to keep the team default.' },
  fromEmail: { type: 'string', description: 'Sender — the part BEFORE the @ only (e.g. "ryan"). Loops appends the team\'s verified sending domain. Omit to keep the default.' },
  replyToEmail: { type: 'string', description: 'Optional reply-to address.' },
} as const;

const AUDIENCE_PROPS = {
  mailingListId: { type: 'string', description: 'Send only to this mailing list (id from list_audience_options).' },
  audienceSegmentId: { type: 'string', description: 'Send only to this saved segment (id from list_audience_options).' },
  filter: { type: 'object', description: `An ad-hoc audience filter. ${FILTER_HELP} With a segment AND a filter, contacts must match both.` },
} as const;

const tools: BuiltinTool[] = [
  {
    name: 'loops_status',
    description:
      'Check this Loops connection: confirms the API key, names the Loops team, shows which addresses previews go to, and whether the Content API (campaign authoring) is enabled. Run this first on a new connection, and whenever another Loops tool fails with 401.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_campaigns',
    description:
      'List campaigns (one-off emails to an audience) with their status — Draft, Scheduled, Sending or Sent — newest first. Use before creating a campaign, so an existing draft is edited rather than duplicated.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['Draft', 'Scheduled', 'Sending', 'Sent'], description: 'Only this status' },
        perPage: { type: 'number', description: '10–50, default 20' },
        cursor: { type: 'string', description: 'nextCursor from a previous page' },
      },
    },
  },
  {
    name: 'get_campaign',
    description:
      'Everything about one campaign: status, audience, schedule, the email itself (subject, sender, preview text, body as LMX, fallbacks, revision id) and — once sent — its results (sends, opens, clicks, unsubscribes, bounces, spam reports).',
    input_schema: {
      type: 'object',
      properties: {
        campaignId: { type: 'string' },
        includeContent: { type: 'boolean', description: 'Default true. False omits the LMX body (use when only status or metrics matter).' },
      },
      required: ['campaignId'],
    },
  },
  {
    name: 'create_campaign',
    description:
      'Create a DRAFT campaign with its subject and body in one call. Nothing is sent: a draft reaches nobody until a person publishes it in Loops. Returns the campaign id, its Loops URL, and Loops\' own pre-send checks. Next: send_preview, then set_campaign_audience / set_campaign_schedule. If this fails after the draft was created, the error says so — fix it with update_campaign, do not create a second one.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Internal campaign name (recipients never see it), e.g. "October product update"' },
        ...EMAIL_PROPS,
        ...CONTENT_PROPS,
        ...AUDIENCE_PROPS,
      },
      required: ['name', 'subject'],
    },
  },
  {
    name: 'update_campaign',
    description:
      'Edit a DRAFT campaign: its name, subject, sender, preview text, body and fallbacks. Only the fields passed are changed; passing a body replaces the whole body. Sent and scheduled campaigns cannot be edited. Returns Loops\' pre-send checks for the new version.',
    input_schema: {
      type: 'object',
      properties: {
        campaignId: { type: 'string' },
        name: { type: 'string', description: 'New internal name' },
        ...EMAIL_PROPS,
        ...CONTENT_PROPS,
        expectedRevisionId: {
          type: 'string',
          description: 'Optional. The contentRevisionId from get_campaign. Pass it when editing a body you read earlier: if someone changed the email in Loops since, the update is refused instead of overwriting their work. Omitted = overwrite the current version.',
        },
      },
      required: ['campaignId'],
    },
  },
  {
    name: 'check_email',
    description:
      'Run Loops\' pre-send checks ("Guardian") on a campaign\'s email: missing fallbacks, unknown contact properties, buttons or links with no URL. Errors must be fixed before sending; warnings are worth reading.',
    input_schema: {
      type: 'object',
      properties: { campaignId: { type: 'string' } },
      required: ['campaignId'],
    },
  },
  {
    name: 'send_preview',
    description:
      'Send a test copy of a campaign\'s email to the preview recipients configured on this connection — and only to them. Use it so a person can see the real rendering before anything is scheduled. The addresses come from the connection, so do not ask the user for one.',
    input_schema: {
      type: 'object',
      properties: {
        campaignId: { type: 'string' },
        contactProperties: { type: 'object', description: 'Sample values for {contact.*} variables in the preview, e.g. {"firstName": "Alex"}. String values.' },
        to: { type: 'array', items: { type: 'string' }, description: 'Optional: a subset of the configured preview recipients. Any other address is refused.' },
      },
      required: ['campaignId'],
    },
  },
  {
    name: 'set_campaign_audience',
    description:
      'Choose who a DRAFT campaign goes to: a mailing list, a saved segment, an ad-hoc filter, a segment plus a filter, or everyone (allContacts:true). This REPLACES the campaign\'s audience — whatever is not named in the call is cleared. Loops has no API to count the recipients; the number shows on the campaign\'s audience step in Loops.',
    input_schema: {
      type: 'object',
      properties: {
        campaignId: { type: 'string' },
        ...AUDIENCE_PROPS,
        allContacts: { type: 'boolean', description: 'true = every subscribed contact. Cannot be combined with a list, segment or filter.' },
      },
      required: ['campaignId'],
    },
  },
  {
    name: 'set_campaign_schedule',
    description:
      'Set when a DRAFT campaign should go out: when:"now" or a future ISO 8601 time. ALWAYS needs a person\'s approval. Runs a pre-flight first and refuses if the campaign is not a draft, has no subject or body, fails Loops\' checks, or would go to the whole audience without confirmAllContacts:true. Loops\' documentation says a person still has to open the campaign in Loops and press Send to publish it — the result states the campaign\'s real status afterwards; report that status, never "sent".',
    input_schema: {
      type: 'object',
      properties: {
        campaignId: { type: 'string' },
        when: { type: 'string', description: '"now", or an ISO 8601 timestamp in the future, e.g. "2026-11-03T14:00:00Z"' },
        confirmAllContacts: { type: 'boolean', description: 'Required (true) when the campaign has no list, segment or filter — i.e. it would go to every subscribed contact.' },
      },
      required: ['campaignId', 'when'],
    },
  },
  {
    name: 'list_audience_options',
    description:
      'What a campaign can be targeted at: mailing lists, saved segments (with their filters) and the contact properties available for filters and {contact.*} personalisation. Read this before building a filter or using a variable — property names are exact.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'create_segment',
    description:
      'Save a reusable audience segment (a named filter over contact properties, opt-in status or email activity), e.g. "Trial users" or "Opened the October update". Segment names must be unique.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        filter: { type: 'object', description: FILTER_HELP },
      },
      required: ['name', 'filter'],
    },
  },
  {
    name: 'find_contact',
    description:
      'Look up ONE contact by email or userId: their properties, subscription status, mailing lists and whether Loops has suppressed them (bounce or complaint). Loops has no API to list or export contacts — this is single-contact only.',
    input_schema: {
      type: 'object',
      properties: {
        email: { type: 'string' },
        userId: { type: 'string', description: 'The app\'s own id for the user, if the contact was created with one' },
      },
    },
  },
  {
    name: 'upsert_contact',
    description:
      'Create a contact, or update an existing one (matched by email or userId). ALWAYS needs approval. To unsubscribe someone, set subscribed:false. Re-subscribing a contact who unsubscribed needs their actual consent and confirmResubscribe:true — otherwise leave "subscribed" out entirely so their choice is preserved.',
    input_schema: {
      type: 'object',
      properties: {
        email: { type: 'string' },
        userId: { type: 'string' },
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        userGroup: { type: 'string', description: 'A grouping label, e.g. "trial", "paid"' },
        source: { type: 'string', description: 'Where the contact came from' },
        subscribed: { type: 'boolean', description: 'false = unsubscribe from campaigns and workflows. Omit unless the task is specifically about subscription.' },
        confirmResubscribe: { type: 'boolean', description: 'Required with subscribed:true when the contact is currently unsubscribed. Only with the contact\'s consent.' },
        mailingLists: { type: 'object', description: 'Mailing list id → true (add) / false (remove)' },
        properties: { type: 'object', description: 'Custom contact properties to set (string, number or boolean values). A property must exist first — see create_contact_property.' },
      },
    },
  },
  {
    name: 'create_contact_property',
    description:
      'Add a custom contact property (a new column on every contact), usable in filters and as {contact.name}. Names are camelCase. Properties cannot be deleted through the API, so check list_audience_options first.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'camelCase, e.g. "planName"' },
        type: { type: 'string', enum: ['string', 'number', 'boolean', 'date'] },
      },
      required: ['name', 'type'],
    },
  },
  {
    name: 'send_event',
    description:
      'Record an event for one contact (e.g. "trial_started"). Events are what TRIGGER workflows, so this can start a live email sequence for that person — ALWAYS needs approval. Use an event name that already exists (list_workflows shows them) unless a new one is intended.',
    input_schema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'The contact. Provide email or userId.' },
        userId: { type: 'string' },
        eventName: { type: 'string' },
        eventProperties: { type: 'object', description: 'Data for this occurrence, available to the workflow\'s emails as {event.*}' },
        contactProperties: { type: 'object', description: 'Contact properties to update at the same time' },
        mailingLists: { type: 'object', description: 'Mailing list id → true/false' },
        idempotencyKey: { type: 'string', description: 'Optional, ≤100 chars. The same key twice within 24h is rejected, which prevents a duplicate if a step is retried.' },
      },
      required: ['eventName'],
    },
  },
  {
    name: 'list_workflows',
    description:
      'List workflows (automated sequences, e.g. onboarding) and the event names this Loops team has received. Use get_workflow for one workflow\'s steps and results.',
    input_schema: {
      type: 'object',
      properties: {
        perPage: { type: 'number', description: '10–50, default 20' },
        cursor: { type: 'string' },
      },
    },
  },
  {
    name: 'get_workflow',
    description:
      'One workflow: whether it is live (Sending), paused or a draft, its trigger, and every step in order. With includeMetrics:true, each email step also reports sends, opens, clicks, unsubscribes and bounces. Read-only — workflows are built and edited in Loops.',
    input_schema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string' },
        includeMetrics: { type: 'boolean', description: 'Default false. Adds one request per email step (max 15).' },
      },
      required: ['workflowId'],
    },
  },
  {
    name: 'list_transactional_emails',
    description:
      'List transactional email templates (password resets, receipts, invites…) with their ids and the data variables each one requires. Call before send_transactional rather than guessing an id.',
    input_schema: {
      type: 'object',
      properties: {
        perPage: { type: 'number', description: '10–50, default 20' },
        cursor: { type: 'string' },
      },
    },
  },
  {
    name: 'send_transactional',
    description:
      'Send ONE published transactional email to ONE address, immediately. IRREVERSIBLE and ALWAYS needs approval. For one-to-one operational mail only — never marketing, and never a way around a campaign: transactional mail ignores unsubscribes, so using it for promotion breaks anti-spam law.',
    input_schema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'The single recipient' },
        transactionalId: { type: 'string', description: 'From list_transactional_emails' },
        dataVariables: { type: 'object', description: 'Values for the template\'s {data.*} variables — every required one must be present' },
        addToAudience: { type: 'boolean', description: 'Also create the recipient as a contact. Default false.' },
        idempotencyKey: { type: 'string', description: 'Optional, ≤100 chars — prevents a duplicate send on retry.' },
      },
      required: ['email', 'transactionalId'],
    },
  },
  {
    name: 'list_design_assets',
    description:
      'Themes (colours, fonts, button styles) and reusable components (logo header, footer blocks…) saved in this Loops team. Use a themeId when creating a campaign to match the brand, and <Component componentId="…" /> in a body to reuse a block.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'upload_image',
    description:
      'Upload an image from the workspace file library to Loops and get back the Loops-hosted URL. Loops emails can ONLY show Loops-hosted images — any other image URL is rejected — so this is the step between "an image exists" and "the image is in the email". JPEG, PNG, GIF or WebP, up to 4MB.',
    input_schema: {
      type: 'object',
      properties: {
        fileId: { type: 'string', description: 'Workspace file library id (from list_files, generate_image or save_file_from_url)' },
      },
      required: ['fileId'],
    },
  },
];

// ── Tool implementations ─────────────────────────────────────────────────────

const DRAFT_ONLY_NOTE
  = 'This is a draft. It has not been sent to anyone and will not be until a person publishes it in Loops.';

async function contentApiState(key: string): Promise<{ enabled: boolean; detail?: string }> {
  try {
    await loops('/campaigns?perPage=10', key);
    return { enabled: true };
  } catch (err) {
    if (err instanceof LoopsError && err.status === 401) {
      return {
        enabled: false,
        detail: 'The key is valid but the Content API is not enabled for this Loops team, so campaigns cannot be read or written from here. Contacts, events and transactional sends still work. Ask Loops support (or check Loops → Settings → API) to enable the Content API.',
      };
    }
    return { enabled: false, detail: err instanceof Error ? err.message : 'unknown error' };
  }
}

async function scanCampaigns(key: string, status: string, args: Record<string, unknown>) {
  // Loops has no status filter, so page through (bounded) and filter here.
  const matches: any[] = [];
  let cursor = str(args.cursor);
  let nextCursor: string | null = null;
  for (let page = 0; page < 4; page++) {
    const p = new URLSearchParams({ perPage: '50' });
    if (cursor) {
      p.set('cursor', cursor);
    }
    const res = await loops(`/campaigns?${p.toString()}`, key);
    for (const c of (res?.data ?? []) as any[]) {
      if (c?.status === status) {
        matches.push(c);
      }
    }
    nextCursor = res?.pagination?.nextCursor ?? null;
    if (!nextCursor) {
      break;
    }
    cursor = nextCursor;
  }
  return { matches, nextCursor };
}

async function uploadImage(key: string, fileId: string, tenantId: string | undefined): Promise<string> {
  if (!tenantId) {
    throw new Error('Cannot read the file library: this Loops connection has no workspace context.');
  }
  const row = await getFile(tenantId, fileId);
  if (!row) {
    throw new Error(`No file ${fileId} in this workspace's library. Use list_files to find the right id.`);
  }
  const object = await getObject(row.r2Key);
  const contentType = String(row.mime || object.contentType || '').toLowerCase().split(';')[0]!.trim();
  if (!IMAGE_TYPES.has(contentType)) {
    throw new Error(`"${row.name}" is ${contentType || 'an unknown type'}. Loops accepts JPEG, PNG, GIF or WebP images only.`);
  }
  const bytes = object.body;
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(`"${row.name}" is ${(bytes.length / 1_000_000).toFixed(1)}MB. Loops accepts images up to 4MB — resize or compress it first.`);
  }

  const created = await loops('/uploads', key, {
    method: 'POST',
    body: { contentType, contentLength: bytes.length },
  });
  const assetId = str(created?.emailAssetId);
  const presignedUrl = str(created?.presignedUrl);
  if (!assetId || !presignedUrl) {
    throw new Error('Loops did not return an upload URL.');
  }

  // The presigned URL is storage, not the Loops API — the API key must NOT go
  // with it. Plain PUT of the bytes with the declared content type.
  let put: Response;
  try {
    put = await fetch(presignedUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: new Uint8Array(bytes),
    });
  } catch (err) {
    throw new Error(`Could not upload the image to Loops' storage: ${err instanceof Error ? err.message : 'network error'}`);
  }
  if (!put.ok) {
    throw new Error(`Loops' storage refused the image upload (HTTP ${put.status}).`);
  }

  const done = await loops(`/uploads/${encodeURIComponent(assetId)}/complete`, key, { method: 'POST' });
  const finalUrl = str(done?.finalUrl);
  if (!finalUrl) {
    throw new Error('Loops accepted the upload but returned no image URL.');
  }
  return out({
    uploaded: true,
    name: row.name,
    url: finalUrl,
    use: `In markdown, on its own line: ![describe the image](${finalUrl})  ·  In LMX: <Image src="${finalUrl}" alt="…" />`,
  });
}

function plainObject(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

const CONTACT_RESERVED = new Set(['email', 'userId', 'subscribed', 'mailingLists', 'eventName', 'eventProperties']);

function customProps(value: unknown, name: string): Record<string, unknown> {
  const outMap: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(plainObject(value, name))) {
    if (CONTACT_RESERVED.has(k)) {
      throw new Error(`"${k}" is not a custom property — pass it as its own argument.`);
    }
    if (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) {
      throw new Error(`${name}.${k} must be a string, number or boolean.`);
    }
    outMap[k] = v;
  }
  return outMap;
}

function idempotency(args: Record<string, unknown>): Record<string, string> | undefined {
  const k = str(args.idempotencyKey);
  if (!k) {
    return undefined;
  }
  if (k.length > 100) {
    throw new Error('idempotencyKey must be 100 characters or fewer.');
  }
  return { 'Idempotency-Key': k };
}

export const loopsProvider: BuiltinProvider = {
  slug: 'loops',
  name: 'Loops (campaigns + lifecycle email)',
  description:
    'Run email marketing in the client\'s own Loops account: write and preview campaigns, target audiences, manage contacts and events, send transactional mail, and report on what campaigns and workflows achieved.',
  perConnection: true,
  credentialLabel:
    'A Loops API key for this client\'s team (Loops → Settings → API → Generate key). Paste the key itself; a "Bearer " prefix is stripped automatically.',
  targetLabel: 'Preview recipients',
  targetPlaceholder: 'you@yourcompany.com — where test emails go (comma-separate several)',
  targetIsUrl: false,
  alwaysAsk: LOOPS_ALWAYS_ASK,

  /**
   * Cross-tool rules. Each line is a mistake that either costs a wasted call
   * (LMX) or reaches real inboxes (everything else).
   */
  guidance: [
    'LOOPS HAS THREE KINDS OF EMAIL — pick the right one. A CAMPAIGN is a one-off to an audience (newsletter, announcement). A WORKFLOW is an automated sequence triggered by an event or a signup; it is built in Loops and you can only read it and report on it. A TRANSACTIONAL email is one operational message to one person (reset, receipt). Marketing content never goes out as transactional: it ignores unsubscribes.',
    'CAMPAIGN ORDER: list_campaigns (reuse an existing draft) → create_campaign → send_preview → tell the user it is in their inbox and WAIT for their verdict → set_campaign_audience → set_campaign_schedule. Never schedule a campaign the user has not seen a preview of.',
    'YOU DO NOT SEND CAMPAIGNS. Everything you create is a draft, and set_campaign_schedule only records when it should go. Report the status the tool returns. If it is still "Draft", say plainly: "it is ready — open it in Loops and press Send". Never tell the user a campaign "was sent" unless get_campaign shows status Sending or Sent.',
    'WRITE BODIES AS MARKDOWN (the "markdown" argument). Loops\' native format is LMX, an XML dialect that is not HTML; the platform converts Markdown for you. Reach for raw "lmx" only for columns, sections or saved components.',
    'PERSONALISATION: variables are {contact.propertyName} with the exact name from list_audience_options, and every one needs a default in "fallbacks" (e.g. {"firstName": "there"}). There is no inline fallback syntax. Do not add an unsubscribe link or address — Loops appends the footer.',
    'IMAGES must be uploaded with upload_image first; Loops rejects any image URL it does not host (including this workspace\'s own file library URLs).',
    'PREVIEWS go only to the addresses saved on the connection. Do not ask the user for an address and do not try to preview to anyone else.',
    'AUDIENCE: say in words who a campaign will reach before scheduling it, and remember Loops gives no recipient count over the API — the user sees the number on the campaign in Loops. A campaign with no list, segment or filter goes to EVERY subscribed contact.',
    'CONTACTS ARE PEOPLE. Look up one contact when a task needs it; do not copy contact details into workspace memory, notes or datasets. To stop mailing someone, upsert_contact with subscribed:false. Never re-subscribe anyone without their consent.',
    'Scheduling, events, transactional sends and contact changes always stop for approval, even when this connection is set to Auto. That is by design — do not ask for it to be turned off.',
  ].join('\n'),

  tools,

  call: async (tool, args, credential, target, ctx): Promise<string> => {
    const key = (credential ?? '').trim().replace(/^Bearer\s+/i, '');
    if (!key) {
      throw new Error('No Loops API key configured for this connection.');
    }

    if (tool === 'loops_status') {
      const who = await loops('/api-key', key);
      const content = await contentApiState(key);
      const recipients = parseRecipients(target);
      return out({
        connected: true,
        team: who?.teamName ?? null,
        contentApi: content.enabled ? 'enabled' : 'NOT AVAILABLE',
        ...(content.detail ? { contentApiDetail: content.detail } : {}),
        previewRecipients: recipients,
        ...(recipients.length
          ? {}
          : { previewNote: 'No valid preview address is configured — send_preview will refuse until the owner adds one under Tools → Loops → Edit.' }),
        alwaysNeedsApproval: LOOPS_ALWAYS_ASK,
        note: 'Campaigns created here are drafts. Publishing a campaign is done by a person in Loops.',
      });
    }

    if (tool === 'list_campaigns') {
      const status = str(args.status);
      if (status) {
        if (!['Draft', 'Scheduled', 'Sending', 'Sent'].includes(status)) {
          throw new Error('status must be Draft, Scheduled, Sending or Sent.');
        }
        const { matches, nextCursor } = await scanCampaigns(key, status, args);
        return out({
          status,
          count: matches.length,
          campaigns: matches.map(slimCampaign),
          nextCursor,
          ...(nextCursor ? { note: 'More campaigns exist beyond the 200 scanned — pass nextCursor to continue.' } : {}),
        });
      }
      const res = await loops(`/campaigns?${pageQuery(args)}`, key);
      return out({
        total: res?.pagination?.totalResults ?? null,
        campaigns: ((res?.data ?? []) as any[]).map(slimCampaign),
        nextCursor: res?.pagination?.nextCursor ?? null,
      });
    }

    if (tool === 'get_campaign') {
      const campaignId = need(args, 'campaignId', 'list_campaigns shows the ids.');
      const campaign = await loops(`/campaigns/${encodeURIComponent(campaignId)}`, key);
      const result: Record<string, unknown> = { ...slimCampaign(campaign) };

      if (campaign?.emailMessageId) {
        try {
          const email = await loops(`/email-messages/${encodeURIComponent(campaign.emailMessageId)}`, key);
          result.email = {
            subject: email?.subject ?? '',
            previewText: email?.previewText ?? '',
            fromName: email?.fromName ?? '',
            fromEmail: email?.fromEmail ?? '',
            replyToEmail: email?.replyToEmail ?? '',
            contentRevisionId: email?.contentRevisionId ?? null,
            fallbacks: email?.contactPropertiesFallbacks ?? {},
            ...(args.includeContent === false ? {} : { lmx: email?.lmx ?? '' }),
            ...(Array.isArray(email?.warnings) && email.warnings.length ? { warnings: email.warnings } : {}),
          };
        } catch (err) {
          result.email = { unavailable: err instanceof Error ? err.message : 'could not read the email' };
        }
      }

      if (campaign?.status === 'Sent' || campaign?.status === 'Sending') {
        try {
          const m = await loops(`/campaigns/${encodeURIComponent(campaignId)}/metrics`, key);
          const sends = Number(m?.sends) || 0;
          const pct = (n: unknown) => (sends ? `${((Number(n) || 0) / sends * 100).toFixed(1)}%` : null);
          result.metrics = {
            ...m,
            openRate: pct(m?.opens),
            clickRate: pct(m?.clicks),
            unsubscribeRate: pct(m?.unsubscribes),
            note: 'Rates are a share of sends. Open counts are inflated by Apple Mail privacy protection — clicks are the more trustworthy signal.',
          };
        } catch (err) {
          result.metrics = { unavailable: err instanceof Error ? err.message : 'no metrics yet' };
        }
      } else {
        result.note = campaign?.status === 'Draft' ? DRAFT_ONLY_NOTE : 'Scheduled — it has not gone out yet.';
      }
      return out(result);
    }

    if (tool === 'create_campaign') {
      const name = need(args, 'name');
      const subject = need(args, 'subject');
      // Validate the body BEFORE creating anything, so a bad body cannot leave
      // an empty draft behind for someone to find in Loops.
      const content = resolveContent(args);
      if (!content) {
        throw new Error('Provide the email body as "markdown" (preferred) or "lmx".');
      }
      const audience = audienceBody(args);

      const created = await loops('/campaigns', key, {
        method: 'POST',
        body: { name, ...(audience ?? {}) },
        hints: { 400: 'If this mentions a sending domain, the Loops team has no verified sending domain yet (Loops → Settings → Domain).' },
      });
      const campaignId = str(created?.id);
      const emailMessageId = str(created?.emailMessageId);
      if (!campaignId || !emailMessageId) {
        throw new Error(`Loops created the campaign but returned no email message id (campaign ${campaignId || '?'}). Open it in Loops to finish it.`);
      }

      try {
        await saveEmail(key, emailMessageId, { ...emailFields(args, content), subject }, created?.emailMessageContentRevisionId ?? null);
      } catch (err) {
        throw new Error(
          `The draft campaign "${name}" WAS created (campaignId ${campaignId}, ${created?.url ?? ''}) but its content could not be saved: ${err instanceof Error ? err.message : 'unknown error'} — Fix the problem and call update_campaign with this campaignId. Do NOT call create_campaign again; that would leave a duplicate draft.`,
        );
      }

      const checks = await guardianSafe(key, emailMessageId);
      const unfilled = contactVariables(content.lmx).filter(v => !(stringMap(args.fallbacks, 'fallbacks') ?? {})[v]);
      return out({
        created: true,
        ...slimCampaign(created),
        subject,
        checks,
        ...(unfilled.length
          ? { missingFallbacks: unfilled, missingFallbacksNote: 'These variables have no default. Call update_campaign with fallbacks for each, or contacts without a value will see a gap.' }
          : {}),
        note: `${DRAFT_ONLY_NOTE} Next: send_preview so the user can see it.`,
      });
    }

    if (tool === 'update_campaign') {
      const campaignId = need(args, 'campaignId');
      const content = resolveContent(args);
      const fields = emailFields(args, content);
      const newName = str(args.name);
      if (!newName && !Object.keys(fields).length) {
        throw new Error('Nothing to change — pass at least one of name, subject, previewText, fromName, fromEmail, replyToEmail, markdown, lmx or fallbacks.');
      }

      const { campaign, emailMessageId } = await campaignWithEmail(key, campaignId);
      if (Object.keys(fields).length && campaign?.status !== 'Draft') {
        throw new Error(`Campaign "${campaign?.name}" is ${campaign?.status}, and only a Draft's email can be edited. ${campaign?.status === 'Scheduled' ? 'To change it, a person must move it back to draft in Loops first.' : 'Create a new campaign instead.'}`);
      }

      let renamed = campaign;
      if (newName && newName !== campaign?.name) {
        renamed = await loops(`/campaigns/${encodeURIComponent(campaignId)}`, key, { method: 'POST', body: { name: newName } });
      }

      let saved: any = null;
      if (Object.keys(fields).length) {
        const expected = str(args.expectedRevisionId) || undefined;
        saved = await saveEmail(key, emailMessageId, fields, expected);
      }

      const checks = saved ? await guardianSafe(key, emailMessageId) : undefined;
      return out({
        updated: true,
        ...slimCampaign(renamed),
        changed: [...(newName ? ['name'] : []), ...Object.keys(fields).map(k => (k === 'lmx' ? 'body' : k === 'contactPropertiesFallbacks' ? 'fallbacks' : k))],
        ...(saved ? { contentRevisionId: saved?.contentRevisionId ?? null } : {}),
        ...(checks ? { checks } : {}),
        note: content ? 'The body was replaced. Send a fresh preview before scheduling — the last one shows the old version.' : DRAFT_ONLY_NOTE,
      });
    }

    if (tool === 'check_email') {
      const campaignId = need(args, 'campaignId');
      const { campaign, emailMessageId } = await campaignWithEmail(key, campaignId);
      const checks = await guardian(key, emailMessageId);
      return out({
        campaignId,
        name: campaign?.name,
        status: campaign?.status,
        ...checks,
        verdict: checks.errors.length
          ? 'NOT ready — fix the errors with update_campaign.'
          : checks.warnings.length
            ? 'No blocking errors. Read the warnings.'
            : 'Clean — Loops found nothing to fix.',
      });
    }

    if (tool === 'send_preview') {
      const campaignId = need(args, 'campaignId');
      const emails = previewRecipients(target, args.to);
      const { campaign, emailMessageId } = await campaignWithEmail(key, campaignId);
      const sample = stringMap(args.contactProperties, 'contactProperties');
      await loops(`/email-messages/${encodeURIComponent(emailMessageId)}/preview`, key, {
        method: 'POST',
        body: { emails, ...(sample ? { contactProperties: sample } : {}) },
        hints: {
          400: 'A sample value may name a property this email does not use, or the email has no content yet.',
          429: 'Loops\' daily preview limit for this team has been reached. Previews will work again tomorrow; the user can also preview inside Loops.',
        },
      });
      return out({
        previewSent: true,
        campaignId,
        name: campaign?.name,
        to: emails,
        note: 'A TEST copy went to the preview recipients only — the campaign itself has not been sent to anyone. Ask the user to check their inbox and wait for their verdict before scheduling.',
      });
    }

    if (tool === 'set_campaign_audience') {
      const campaignId = need(args, 'campaignId');
      const audience = audienceBody(args);
      if (!audience) {
        throw new Error('Say who the campaign goes to: mailingListId, audienceSegmentId, filter, or allContacts:true. list_audience_options shows the lists and segments.');
      }
      const updated = await loops(`/campaigns/${encodeURIComponent(campaignId)}`, key, {
        method: 'POST',
        body: audience,
        hints: { 409: 'This campaign has already been sent — its audience can no longer change.' },
      });
      return out({
        updated: true,
        ...slimCampaign(updated),
        note: 'Loops does not report how many contacts match over the API — the count is on the campaign\'s audience step in Loops. Tell the user who this targets in words, and that they can confirm the number there.',
      });
    }

    if (tool === 'set_campaign_schedule') {
      const campaignId = need(args, 'campaignId');
      const when = need(args, 'when', 'Use "now" or a future ISO 8601 timestamp.');

      let scheduling: { method: 'now' } | { method: 'schedule'; timestamp: string };
      if (when.toLowerCase() === 'now') {
        scheduling = { method: 'now' };
      } else {
        const at = new Date(when);
        if (Number.isNaN(at.getTime())) {
          throw new TypeError(`"${when}" is not a time Loops understands. Use "now" or ISO 8601, e.g. 2026-11-03T14:00:00Z.`);
        }
        if (at.getTime() <= Date.now() + 60_000) {
          throw new Error(`${at.toISOString()} is not in the future. Pick a later time, or use "now".`);
        }
        scheduling = { method: 'schedule', timestamp: at.toISOString() };
      }

      // ── Pre-flight. Every refusal below is cheaper than an email that
      // cannot be recalled. ──
      const { campaign, emailMessageId } = await campaignWithEmail(key, campaignId);
      if (campaign?.status !== 'Draft') {
        throw new Error(`Campaign "${campaign?.name}" is already ${campaign?.status}. Only a Draft can be scheduled.`);
      }
      const email = await loops(`/email-messages/${encodeURIComponent(emailMessageId)}`, key);
      const blockers: string[] = [];
      if (!str(email?.subject)) {
        blockers.push('It has no subject line.');
      }
      if (!str(email?.lmx)) {
        blockers.push('It has no body.');
      }
      const checks = await guardian(key, emailMessageId);
      for (const e of checks.errors) {
        blockers.push(`${e.title ?? e.rule}${e.items ? ` (${e.items.join(', ')})` : ''}`);
      }
      const everyone = !campaign?.mailingListId && !campaign?.audienceSegmentId && !campaign?.audienceFilter;
      if (everyone && args.confirmAllContacts !== true) {
        blockers.push('It has no list, segment or filter, so it would go to EVERY subscribed contact. If that is what the user asked for, pass confirmAllContacts:true; otherwise call set_campaign_audience first.');
      }
      if (blockers.length) {
        throw new Error(`Not scheduled — "${campaign?.name}" is not ready:\n- ${blockers.join('\n- ')}`);
      }

      const updated = await loops(`/campaigns/${encodeURIComponent(campaignId)}`, key, {
        method: 'POST',
        body: { scheduling },
        hints: { 409: 'This campaign has already been sent.' },
      });
      const status = str(updated?.status) || 'unknown';
      return out({
        ...slimCampaign(updated),
        requested: scheduling,
        ...(checks.warnings.length ? { warnings: checks.warnings } : {}),
        nextStep: status === 'Draft'
          ? `The schedule is saved, but the campaign is STILL A DRAFT — nothing has been sent or queued. A person must open ${updated?.url ?? 'the campaign in Loops'} and press Send to publish it. Tell the user exactly that.`
          : status === 'Scheduled'
            ? `Loops reports the campaign as Scheduled for ${updated?.scheduling?.timestamp ?? 'the requested time'}. It can still be cancelled in Loops until then.`
            : `Loops reports the campaign as ${status}. Report that status to the user as it is.`,
      });
    }

    if (tool === 'list_audience_options') {
      const [lists, segments, properties] = await Promise.all([
        loops('/lists', key).catch((e: unknown) => ({ error: e instanceof Error ? e.message : 'unavailable' })),
        loops('/audience-segments?perPage=50', key).catch((e: unknown) => ({ error: e instanceof Error ? e.message : 'unavailable' })),
        loops('/contacts/properties', key).catch((e: unknown) => ({ error: e instanceof Error ? e.message : 'unavailable' })),
      ]);
      return out({
        mailingLists: Array.isArray(lists)
          ? lists.map((l: any) => ({ id: l.id, name: l.name, description: l.description ?? null, isPublic: l.isPublic }))
          : lists,
        segments: Array.isArray(segments?.data)
          ? segments.data.map((s: any) => ({ id: s.id, name: s.name, description: s.description ?? null, filter: s.filter ?? null }))
          : segments,
        contactProperties: Array.isArray(properties)
          ? properties.map((p: any) => ({ key: p.key, label: p.label, type: p.type }))
          : properties,
        note: 'Use a property\'s "key" in filters and as {contact.<key>}. With no list, segment or filter a campaign goes to every subscribed contact.',
      });
    }

    if (tool === 'create_segment') {
      const name = need(args, 'name');
      const filter = checkFilter(args.filter);
      const description = str(args.description);
      const res = await loops('/audience-segments', key, {
        method: 'POST',
        body: { name, filter, ...(description ? { description } : {}) },
        hints: {
          400: 'Usually a segment with this name already exists, or a property key in the filter is not a real contact property (see list_audience_options).',
          404: 'The filter names a campaign or workflow id that does not exist.',
        },
      });
      return out({ created: true, id: res?.id, name: res?.name, filter: res?.filter ?? filter });
    }

    if (tool === 'find_contact') {
      const email = str(args.email);
      const userId = str(args.userId);
      if ((email ? 1 : 0) + (userId ? 1 : 0) !== 1) {
        throw new Error('Provide exactly one of email or userId.');
      }
      const q = new URLSearchParams(email ? { email } : { userId }).toString();
      const found = await loops(`/contacts/find?${q}`, key);
      const contact = Array.isArray(found) ? found[0] : null;
      if (!contact) {
        return out({ found: false, note: 'No contact with that identifier in this Loops audience.' });
      }
      let suppression: unknown;
      try {
        const s = await loops(`/contacts/suppression?${q}`, key);
        suppression = { isSuppressed: Boolean(s?.isSuppressed) };
      } catch {
        suppression = undefined;
      }
      return out({
        found: true,
        contact,
        ...(suppression ? { suppression } : {}),
        note: 'subscribed:false means they opted out of campaigns and workflows. A suppressed contact bounced or complained and receives nothing.',
      });
    }

    if (tool === 'upsert_contact') {
      const email = str(args.email);
      const userId = str(args.userId);
      if (!email && !userId) {
        throw new Error('Provide email or userId to say which contact.');
      }

      if (args.subscribed === true && args.confirmResubscribe !== true) {
        const q = new URLSearchParams(email ? { email } : { userId }).toString();
        const existing = await loops(`/contacts/find?${q}`, key);
        const current = Array.isArray(existing) ? existing[0] : null;
        if (current && current.subscribed === false) {
          throw new Error(
            'This contact is UNSUBSCRIBED. Setting subscribed:true would opt them back in to marketing email, which needs their actual consent. If they asked to be re-subscribed, call again with confirmResubscribe:true. Otherwise leave "subscribed" out — the other fields will still be updated.',
          );
        }
      }

      const body: Record<string, unknown> = { ...customProps(args.properties, 'properties') };
      if (email) {
        body.email = email;
      }
      if (userId) {
        body.userId = userId;
      }
      for (const k of ['firstName', 'lastName', 'userGroup', 'source'] as const) {
        if (typeof args[k] === 'string') {
          body[k] = String(args[k]).trim();
        }
      }
      if (typeof args.subscribed === 'boolean') {
        body.subscribed = args.subscribed;
      }
      const lists = plainObject(args.mailingLists, 'mailingLists');
      if (Object.keys(lists).length) {
        body.mailingLists = lists;
      }

      const res = await loops('/contacts/update', key, {
        method: 'PUT',
        body,
        hints: { 400: 'Check the email address, and that every custom property exists (list_audience_options) — unknown properties are rejected.' },
      });
      return out({
        saved: true,
        contactId: res?.id ?? null,
        fields: Object.keys(body).filter(k => k !== 'email' && k !== 'userId'),
        ...(args.subscribed === false ? { note: 'Unsubscribed — they will receive no campaigns or workflow emails. Transactional mail still reaches them.' } : {}),
      });
    }

    if (tool === 'create_contact_property') {
      const name = need(args, 'name');
      const type = need(args, 'type');
      if (!/^[a-z][A-Za-z0-9]*$/.test(name)) {
        throw new Error(`"${name}" is not camelCase. Use letters and digits starting with a lower-case letter, e.g. "planName".`);
      }
      if (!['string', 'number', 'boolean', 'date'].includes(type)) {
        throw new Error('type must be string, number, boolean or date.');
      }
      await loops('/contacts/properties', key, {
        method: 'POST',
        body: { name, type },
        hints: { 400: 'The property may already exist — check list_audience_options.' },
      });
      return out({ created: true, name, type, use: `{contact.${name}} in email bodies; key "${name}" in filters.` });
    }

    if (tool === 'send_event') {
      const email = str(args.email);
      const userId = str(args.userId);
      if (!email && !userId) {
        throw new Error('Provide email or userId to say which contact the event is for.');
      }
      const eventName = need(args, 'eventName');
      const eventProperties = plainObject(args.eventProperties, 'eventProperties');
      const lists = plainObject(args.mailingLists, 'mailingLists');
      const body: Record<string, unknown> = {
        ...customProps(args.contactProperties, 'contactProperties'),
        ...(email ? { email } : {}),
        ...(userId ? { userId } : {}),
        eventName,
        ...(Object.keys(eventProperties).length ? { eventProperties } : {}),
        ...(Object.keys(lists).length ? { mailingLists: lists } : {}),
      };
      const headers = idempotency(args);
      await loops('/events/send', key, {
        method: 'POST',
        body,
        ...(headers ? { headers } : {}),
        hints: { 409: 'That idempotencyKey was already used in the last 24 hours, so this event was NOT recorded again (the earlier one stands).' },
      });
      return out({
        recorded: true,
        eventName,
        for: email || userId,
        note: 'Recorded. Any live workflow triggered by this event has now started for this contact — its emails follow that workflow\'s own timing.',
      });
    }

    if (tool === 'list_workflows') {
      const [res, events] = await Promise.all([
        loops(`/workflows?${pageQuery(args)}`, key),
        loops('/event-patterns?perPage=50', key).catch(() => null),
      ]);
      return out({
        total: res?.pagination?.totalResults ?? null,
        workflows: ((res?.data ?? []) as any[]).map(w => ({ workflowId: w.id, name: w.name, url: w.url, updatedAt: w.updatedAt })),
        nextCursor: res?.pagination?.nextCursor ?? null,
        ...(events?.data
          ? { knownEvents: (events.data as any[]).map(e => e.eventName).filter(Boolean) }
          : {}),
        note: 'get_workflow shows whether a workflow is live and what each step does.',
      });
    }

    if (tool === 'get_workflow') {
      const workflowId = need(args, 'workflowId');
      const w = await loops(`/workflows/${encodeURIComponent(workflowId)}`, key);
      const nodes = (w?.nodes ?? {}) as Record<string, any>;

      // Walk from the root so steps read in the order a contact meets them.
      const ordered: string[] = [];
      const seen = new Set<string>();
      const queue: string[] = w?.rootNodeId ? [String(w.rootNodeId)] : Object.keys(nodes);
      while (queue.length && ordered.length < 200) {
        const id = queue.shift()!;
        if (seen.has(id) || !nodes[id]) {
          continue;
        }
        seen.add(id);
        ordered.push(id);
        for (const next of (Array.isArray(nodes[id].nextNodeIds) ? nodes[id].nextNodeIds : []) as string[]) {
          queue.push(String(next));
        }
      }

      const steps: Array<Record<string, unknown>> = ordered.map((id) => {
        const { nextNodeIds: _next, ...rest } = nodes[id];
        return { nodeId: id, ...rest };
      });

      if (args.includeMetrics === true) {
        const emailSteps = steps.filter(s => s.typeName === 'SendEmailAction' && s.emailMessageId).slice(0, 15);
        for (const step of emailSteps) {
          try {
            step.metrics = await loops(`/workflows/${encodeURIComponent(workflowId)}/nodes/${encodeURIComponent(String(step.nodeId))}/metrics`, key);
          } catch (err) {
            step.metrics = { unavailable: err instanceof Error ? err.message : 'no metrics' };
          }
        }
      }

      const status = str(w?.status);
      return out({
        workflowId: w?.id,
        name: w?.name,
        description: w?.description ?? '',
        status,
        statusMeaning: status === 'Sending'
          ? 'LIVE — contacts who hit the trigger are receiving these emails.'
          : status === 'Draft'
            ? 'Not started — nobody receives it yet.'
            : 'Paused.',
        url: w?.url,
        mailingListId: w?.mailingListId ?? null,
        steps,
        note: 'Workflows are edited in Loops, not from here.',
      });
    }

    if (tool === 'list_transactional_emails') {
      const res = await loops(`/transactional-emails?${pageQuery(args)}`, key);
      return out({
        total: res?.pagination?.totalResults ?? null,
        transactionalEmails: ((res?.data ?? []) as any[]).map(t => ({
          transactionalId: t.id,
          name: t.name,
          published: Boolean(t.publishedEmailMessageId),
          dataVariables: t.dataVariables ?? [],
          url: t.url,
        })),
        nextCursor: res?.pagination?.nextCursor ?? null,
        note: 'Only a published template can be sent. Every name in dataVariables must be supplied to send_transactional.',
      });
    }

    if (tool === 'send_transactional') {
      const email = need(args, 'email');
      if (!EMAIL_RE.test(email)) {
        throw new Error(`"${email}" is not one email address. Transactional email goes to exactly one recipient per call.`);
      }
      const transactionalId = need(args, 'transactionalId', 'list_transactional_emails shows the ids.');
      const dataVariables = plainObject(args.dataVariables, 'dataVariables');
      const headers = idempotency(args);
      await loops('/transactional', key, {
        method: 'POST',
        body: {
          email,
          transactionalId,
          ...(Object.keys(dataVariables).length ? { dataVariables } : {}),
          ...(args.addToAudience === true ? { addToAudience: true } : {}),
        },
        ...(headers ? { headers } : {}),
        hints: {
          400: 'Usually the template is not published yet, or a required data variable is missing — list_transactional_emails shows what it needs.',
          404: 'No transactional email with that id — list_transactional_emails shows the real ids.',
          409: 'That idempotencyKey was already used in the last 24 hours, so this email was NOT sent again (the earlier one stands).',
        },
      });
      return out({
        sent: true,
        to: email,
        transactionalId,
        note: 'Handed to Loops for immediate delivery. It cannot be recalled.',
      });
    }

    if (tool === 'list_design_assets') {
      const [themes, components] = await Promise.all([
        loops('/themes?perPage=50', key).catch((e: unknown) => ({ error: e instanceof Error ? e.message : 'unavailable' })),
        loops('/components?perPage=50', key).catch((e: unknown) => ({ error: e instanceof Error ? e.message : 'unavailable' })),
      ]);
      return out({
        themes: Array.isArray(themes?.data)
          ? themes.data.map((t: any) => ({ themeId: t.id, name: t.name, isDefault: Boolean(t.isDefault) }))
          : themes,
        components: Array.isArray(components?.data)
          ? components.data.map((c: any) => ({ componentId: c.id, name: c.name }))
          : components,
        note: 'The default theme applies when no themeId is given. Place a component in a markdown body by putting <Component componentId="…" /> on its own line.',
      });
    }

    if (tool === 'upload_image') {
      return uploadImage(key, need(args, 'fileId', 'list_files shows the ids.'), ctx?.tenantId);
    }

    throw new Error(`Unknown Loops tool: ${tool}`);
  },
};
