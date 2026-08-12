/**
 * Postmark — built-in provider (per-connection, bring-your-own server token).
 *
 * WHY A BUILT-IN AND NOT AN MCP CONNECTION
 * Postmark's official MCP server (@activecampaign/postmark-mcp) is stdio-only —
 * there is no hosted URL — so it would cost an npm dependency, a stdioCatalog
 * entry and a child process per call, to get 24 tools where we want about ten.
 * Postmark's REST API is a single header and flat JSON, so the adapter is
 * cheaper than the integration. Same call as HeyGen.
 *
 * There is a second reason, specific to this vendor. In September 2025 the
 * UNSCOPED npm package `postmark-mcp` — a third-party impersonation, not
 * ActiveCampaign's — was found BCC'ing every message it sent to the author's
 * own address. It was the first malicious MCP server found in the wild. The
 * legitimate package is scoped `@activecampaign/postmark-mcp`, and the two are
 * one typo apart in a config file nobody re-reads. Owning the ~200 lines below
 * removes that class of risk from the mail path entirely, which is the one path
 * where a silent BCC is worst: it leaks the client's customer list.
 *
 * NOT THE SAME THING AS src/libs/email.ts. That module is ARTIVIO's own
 * transactional mail (invites, password resets) on the PLATFORM's Postmark
 * token from env. This provider is per-connection: each workspace pastes its
 * OWN client's server token, and the two never share a credential or a server.
 *
 * Per-connection config (stored on the mcp_connection, not the catalog):
 *   target     = the default From address, e.g. news@clientdomain.com
 *   credential = that Postmark server's Server API Token
 *
 * WHY THE TARGET IS AN ADDRESS AND NOT A URL
 * Postmark refuses to send from any address that is not a confirmed Sender
 * Signature, and returns error 400/401 when you try. That is the single most
 * common Postmark failure, and an agent that has to guess the From address hits
 * it constantly. Making it connection config means it is answered once, by the
 * person who set the account up, instead of re-guessed on every send.
 */

import type { BuiltinProvider, BuiltinTool } from '@/libs/plugins/types';
import { Buffer } from 'node:buffer';
import { getFile } from '@/libs/storage/files';
import { getObject } from '@/libs/storage/r2';

const API = 'https://api.postmarkapp.com';
const MAX_OUTPUT = 120_000;

/** Postmark's own caps — exceeding them is a 422, so clamp before sending. */
const MAX_BATCH = 500;
const MAX_SUPPRESSIONS = 50;
const MAX_BOUNCE_COUNT = 500;
/**
 * Postmark's documented ceiling is ~10MB per message AFTER base64 (which inflates
 * by ~33%), so cap the raw total below that. Exceeding it is a 422 late in the
 * send, by which point the deck has already been rendered and filed.
 */
const MAX_ATTACH_BYTES = 7 * 1024 * 1024;

/**
 * Error codes worth translating. Postmark's `Message` is accurate but assumes
 * you know the product; these add the "so do this next" the agent needs to
 * recover on its own instead of reporting a dead end to the user.
 */
const ERROR_HINTS: Record<number, string> = {
  300: 'Invalid request — usually a malformed To/From address, or both HtmlBody and TextBody missing.',
  400: 'That From address is not a Sender Signature on this Postmark account. Add and confirm it in Postmark → Sender Signatures, or send from the connection\'s configured default instead.',
  401: 'The Sender Signature for that From address exists but has not been confirmed — someone must click the confirmation email Postmark sent to it.',
  402: 'This Postmark server is not activated for sending.',
  405: 'This account is pending approval and can only send to addresses on the account.',
  406: 'The recipient is INACTIVE — Postmark suppressed them after a hard bounce or spam complaint, and will keep refusing until they are reactivated. Use search_bounces to see why, then activate_bounce or unsuppress_addresses if the address is genuinely good.',
  409: 'Sending on this message stream is blocked.',
  410: 'The account has no available sends left on its plan.',
  411: 'Sending has been disabled for this server.',
  412: 'This account is pending approval.',
  422: 'Postmark rejected the payload — check the field named in the message.',
  429: 'Rate limited, or too many messages in one batch (max 500). Retry with a smaller batch.',
  1101: 'That message stream does not exist on this server, or is the wrong type. Bulk and marketing mail must go on a BROADCAST stream; transactional mail on an outbound stream.',
};

/**
 * One Postmark request.
 *
 * Postmark signals failure two ways and both matter: a non-2xx status with an
 * {ErrorCode, Message} body (the common case, usually 422), and — on the batch
 * endpoints — HTTP 200 with per-message ErrorCodes inside the array, because
 * partial success is a real outcome there. This helper handles the first; the
 * batch tools below unpack the second rather than reporting "sent" for a call
 * where 40 of 50 messages were rejected.
 */
async function pm(
  path: string,
  token: string,
  init?: { method?: string; body?: unknown },
): Promise<any> {
  let resp: Response;
  try {
    resp = await fetch(`${API}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-Postmark-Server-Token': token,
      },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch (err) {
    throw new Error(
      `Could not reach Postmark: ${err instanceof Error ? err.message : 'network error'}`,
    );
  }

  const text = await resp.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Postmark always returns JSON; anything else means a proxy or an outage.
    if (!resp.ok) {
      throw new Error(`Postmark ${resp.status}: ${text.slice(0, 400) || 'empty response'}`);
    }
    return {};
  }

  if (!resp.ok) {
    const code = Number(body?.ErrorCode ?? 0);
    if (resp.status === 401) {
      throw new Error(
        'Postmark rejected the server token (401). This connection needs a SERVER API Token (Postmark → the server → API Tokens), not an Account token and not the SMTP password.',
      );
    }
    const hint = ERROR_HINTS[code];
    throw new Error(
      `Postmark ${resp.status} (code ${code || '?'}): ${body?.Message ?? 'unknown error'}${hint ? ` — ${hint}` : ''}`,
    );
  }

  return body ?? {};
}

/** Trim provider payloads so one call can't eat the context window. */
function out(value: unknown): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > MAX_OUTPUT
    ? `${s.slice(0, MAX_OUTPUT)}\n…truncated (${s.length} chars). Narrow the query — add a date range, tag, recipient or a smaller count.`
    : s;
}

/** Accepts "a@b.com" or ["a@b.com","c@d.com"]; Postmark wants comma-separated. */
export function addressList(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const list = Array.isArray(value) ? value : [value];
  const joined = list.map(v => String(v).trim()).filter(Boolean).join(',');
  return joined || undefined;
}

/**
 * Build one Postmark message body from tool args.
 *
 * `From` falls back to the connection's configured default (the confirmed
 * Sender Signature). An explicit From is allowed because a workspace may have
 * several signatures on one server, but the default is what makes the common
 * case work without the agent knowing anything about the account.
 */
export function buildMessage(args: Record<string, unknown>, defaultFrom: string): Record<string, unknown> {
  const from = String(args.From ?? args.from ?? defaultFrom ?? '').trim();
  if (!from) {
    throw new Error(
      'No From address. Set a default From on this Postmark connection, or pass From explicitly — it must be a confirmed Sender Signature.',
    );
  }

  const to = addressList(args.To ?? args.to);
  if (!to) {
    throw new Error('Provide at least one To address.');
  }

  const html = args.HtmlBody ?? args.htmlBody ?? args.html;
  const text = args.TextBody ?? args.textBody ?? args.text;
  if (!html && !text) {
    throw new Error('Provide HtmlBody, TextBody, or both.');
  }

  const msg: Record<string, unknown> = {
    From: from,
    To: to,
    Subject: String(args.Subject ?? args.subject ?? ''),
    // Postmark defaults to the transactional stream when this is omitted.
    // Naming it explicitly makes the wrong-stream mistake visible in the
    // message body rather than silently applied.
    MessageStream: String(args.MessageStream ?? args.messageStream ?? 'outbound'),
  };

  if (html) {
    msg.HtmlBody = String(html);
  }
  if (text) {
    msg.TextBody = String(text);
  }

  const cc = addressList(args.Cc ?? args.cc);
  const bcc = addressList(args.Bcc ?? args.bcc);
  const replyTo = args.ReplyTo ?? args.replyTo;
  if (cc) {
    msg.Cc = cc;
  }
  if (bcc) {
    msg.Bcc = bcc;
  }
  if (replyTo) {
    msg.ReplyTo = String(replyTo);
  }
  if (args.Tag ?? args.tag) {
    msg.Tag = String(args.Tag ?? args.tag);
  }
  if (args.TrackOpens !== undefined) {
    msg.TrackOpens = Boolean(args.TrackOpens);
  }
  if (args.Metadata && typeof args.Metadata === 'object') {
    msg.Metadata = args.Metadata;
  }

  return msg;
}

/** Summarise a send response without echoing the whole body back. */
function sendSummary(res: any, msg: Record<string, unknown>, attached: string[] = []): string {
  return out({
    sent: true,
    to: msg.To,
    from: msg.From,
    subject: msg.Subject,
    stream: msg.MessageStream,
    ...(attached.length ? { attached } : {}),
    messageId: res?.MessageID ?? null,
    submittedAt: res?.SubmittedAt ?? null,
    note: 'Delivered to Postmark for immediate sending. Postmark has no scheduled-send API — this message is already on its way and cannot be recalled.',
  });
}

/**
 * Turn workspace file ids into Postmark attachment objects.
 *
 * BY REFERENCE, NEVER BY VALUE. The obvious design — an `Attachments` argument
 * the model fills with base64 — cannot work: a 500KB PDF is ~700K characters of
 * base64, so the deck would have to pass through the context window twice (once
 * to write it, once to send it). File ids keep the bytes entirely server-side.
 *
 * Scoped to the calling tenant via getFile(tenantId, id), so one workspace
 * cannot attach another's documents by guessing an id.
 */
async function loadAttachments(
  fileIds: unknown,
  tenantId: string | undefined,
): Promise<Array<{ Name: string; Content: string; ContentType: string }>> {
  const ids = (Array.isArray(fileIds) ? fileIds : [fileIds])
    .map(v => String(v ?? '').trim())
    .filter(Boolean);
  if (!ids.length) {
    return [];
  }
  if (!tenantId) {
    throw new Error('Cannot attach files: this Postmark connection has no workspace context.');
  }
  if (ids.length > 10) {
    throw new Error(`${ids.length} attachments is too many for one email — send at most 10.`);
  }

  const out: Array<{ Name: string; Content: string; ContentType: string }> = [];
  let total = 0;

  for (const id of ids) {
    const row = await getFile(tenantId, id);
    if (!row) {
      throw new Error(`No file ${id} in this workspace's library. Use list_files to find the right id.`);
    }
    const object = await getObject(row.r2Key);
    total += object.body.length;
    if (total > MAX_ATTACH_BYTES) {
      throw new Error(
        `Attachments total more than ${Math.round(MAX_ATTACH_BYTES / 1024 / 1024)}MB, which Postmark will reject. Send a link to the file instead of attaching it.`,
      );
    }
    out.push({
      Name: row.name,
      Content: Buffer.from(object.body).toString('base64'),
      ContentType: row.mime || object.contentType || 'application/octet-stream',
    });
  }

  return out;
}

const tools: BuiltinTool[] = [
  {
    name: 'send_email',
    description:
      'Send one email immediately via Postmark. IRREVERSIBLE — there is no recall and no scheduling; the message goes out as soon as this returns. From defaults to the connection\'s configured Sender Signature. Use MessageStream "outbound" for transactional mail and a broadcast stream for bulk/marketing.',
    input_schema: {
      type: 'object',
      properties: {
        To: { type: 'string', description: 'Recipient address, or several comma-separated (max 50)' },
        Subject: { type: 'string' },
        HtmlBody: { type: 'string', description: 'HTML body. Provide this, TextBody, or both.' },
        TextBody: { type: 'string', description: 'Plain-text body. Always include one alongside HTML — it improves deliverability.' },
        From: { type: 'string', description: 'Override the default From. Must be a confirmed Sender Signature on this account.' },
        Cc: { type: 'string' },
        Bcc: { type: 'string' },
        ReplyTo: { type: 'string' },
        Tag: { type: 'string', description: 'Groups messages for stats and search, e.g. "welcome" or "march-newsletter"' },
        MessageStream: { type: 'string', description: 'Default "outbound". Bulk/marketing MUST use a broadcast stream or Postmark rejects it.' },
        TrackOpens: { type: 'boolean' },
        Metadata: { type: 'object', description: 'Arbitrary key/value pairs, searchable later' },
        attachFileIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Workspace file library ids to attach (from list_files, create_presentation or save_file_from_url). Attach BY ID — never paste file contents into this call. Max 10 files, ~7MB total.',
        },
      },
      required: ['To', 'Subject'],
    },
  },
  {
    name: 'send_with_template',
    description:
      'Send immediately using a Postmark template, filling it with TemplateModel. Prefer this over hand-built HTML for anything recurring — the template holds the design and the layout, so the agent only supplies the data. IRREVERSIBLE.',
    input_schema: {
      type: 'object',
      properties: {
        TemplateAlias: { type: 'string', description: 'Template alias (preferred — stable across environments). Provide this or TemplateId.' },
        TemplateId: { type: 'number' },
        TemplateModel: { type: 'object', description: 'Values for the template\'s placeholders' },
        To: { type: 'string' },
        From: { type: 'string' },
        Cc: { type: 'string' },
        Bcc: { type: 'string' },
        ReplyTo: { type: 'string' },
        Tag: { type: 'string' },
        MessageStream: { type: 'string' },
        attachFileIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Workspace file library ids to attach. Max 10 files, ~7MB total.',
        },
      },
      required: ['To', 'TemplateModel'],
    },
  },
  {
    name: 'send_batch',
    description:
      'Send up to 500 individually-addressed emails in one call. Each recipient gets their own message — nobody sees anyone else\'s address. IRREVERSIBLE, and this is the highest-blast-radius tool here: check the recipient list before calling. Returns per-message results, since Postmark can accept some and reject others in the same batch.',
    input_schema: {
      type: 'object',
      properties: {
        messages: {
          type: 'array',
          description: 'Up to 500 messages, each shaped like send_email\'s arguments.',
          items: { type: 'object' },
        },
        MessageStream: { type: 'string', description: 'Applied to any message that does not set its own. Use a broadcast stream for marketing.' },
      },
      required: ['messages'],
    },
  },
  {
    name: 'list_templates',
    description: 'List the templates on this Postmark server, with their aliases and IDs. Call this before send_with_template rather than guessing an alias.',
    input_schema: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Default 100' },
        offset: { type: 'number', description: 'Default 0' },
      },
    },
  },
  {
    name: 'search_messages',
    description: 'Search sent mail — who was it sent to, did it go out, what status. Use this to answer "did the invoice reach them" before assuming anything about delivery.',
    input_schema: {
      type: 'object',
      properties: {
        recipient: { type: 'string' },
        tag: { type: 'string' },
        subject: { type: 'string' },
        status: { type: 'string', description: 'queued | sent | processed' },
        fromdate: { type: 'string', description: 'YYYY-MM-DD (Eastern Time)' },
        todate: { type: 'string', description: 'YYYY-MM-DD (Eastern Time)' },
        messagestream: { type: 'string' },
        count: { type: 'number', description: 'Default 50, max 500' },
        offset: { type: 'number' },
      },
    },
  },
  {
    name: 'message_details',
    description: 'Full detail for one sent message, including Postmark\'s delivery events (accepted, bounced, opened). Takes the MessageID returned by a send or by search_messages.',
    input_schema: {
      type: 'object',
      properties: { messageId: { type: 'string' } },
      required: ['messageId'],
    },
  },
  {
    name: 'delivery_stats',
    description: 'Account-level delivery health — total sent, bounce counts broken down by type. The first thing to check when someone reports "our email stopped arriving".',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'search_bounces',
    description: 'List bounces, optionally filtered. Explains WHY an address stopped receiving mail — and whether the cause was permanent (HardBounce) or transient.',
    input_schema: {
      type: 'object',
      properties: {
        emailFilter: { type: 'string', description: 'Filter by recipient address' },
        type: { type: 'string', description: 'e.g. HardBounce, SoftBounce, SpamNotification, Transient' },
        inactive: { type: 'boolean', description: 'true = only addresses Postmark has deactivated' },
        tag: { type: 'string' },
        fromdate: { type: 'string', description: 'YYYY-MM-DD' },
        todate: { type: 'string', description: 'YYYY-MM-DD' },
        count: { type: 'number', description: 'Default 50, max 500' },
        offset: { type: 'number' },
      },
    },
  },
  {
    name: 'activate_bounce',
    description:
      'Reactivate an address Postmark deactivated after a bounce, so it can receive mail again. Only do this when the bounce cause is known to be fixed (mailbox was full, typo corrected, server was down) — reactivating a genuinely dead address re-bounces it and damages the account\'s sending reputation.',
    input_schema: {
      type: 'object',
      properties: { bounceId: { type: 'string', description: 'The bounce ID from search_bounces' } },
      required: ['bounceId'],
    },
  },
  {
    name: 'list_suppressions',
    description: 'List suppressed addresses on a message stream — everyone this stream will silently refuse to mail, and why (bounce, spam complaint, or manual).',
    input_schema: {
      type: 'object',
      properties: {
        stream: { type: 'string', description: 'Message stream ID, default "outbound"' },
        origin: { type: 'string', description: 'Customer | Recipient | Admin' },
        fromdate: { type: 'string', description: 'YYYY-MM-DD' },
      },
    },
  },
  {
    name: 'suppress_addresses',
    description: 'Add addresses to a stream\'s suppression list so this account never mails them again — the correct way to honour an unsubscribe or a "stop emailing me" request. Max 50 per call.',
    input_schema: {
      type: 'object',
      properties: {
        emails: { type: 'array', items: { type: 'string' }, description: 'Up to 50 addresses' },
        stream: { type: 'string', description: 'Message stream ID, default "outbound"' },
      },
      required: ['emails'],
    },
  },
  {
    name: 'unsuppress_addresses',
    description:
      'Remove addresses from a stream\'s suppression list so they can receive mail again. Requires the recipient\'s actual consent — re-mailing someone who unsubscribed is what gets a sending domain blocklisted. Spam-complaint suppressions cannot be removed by design. Max 50 per call.',
    input_schema: {
      type: 'object',
      properties: {
        emails: { type: 'array', items: { type: 'string' }, description: 'Up to 50 addresses' },
        stream: { type: 'string', description: 'Message stream ID, default "outbound"' },
      },
      required: ['emails'],
    },
  },
  {
    name: 'postmark_call',
    description:
      'Escape hatch for any server-level Postmark endpoint the curated tools do not cover (message streams, webhooks, inbound, opens, clicks). Path is relative to https://api.postmarkapp.com. Account-level endpoints — servers, domains, sender signatures — are NOT reachable: they need an Account token, which this connection deliberately does not hold.',
    input_schema: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'GET | POST | PUT | DELETE (default GET)' },
        path: { type: 'string', description: 'e.g. /message-streams or /messages/outbound/opens' },
        body: { type: 'object', description: 'JSON body for POST/PUT' },
      },
      required: ['path'],
    },
  },
];

function qs(args: Record<string, unknown>, keys: string[], defaults: Record<string, string> = {}): string {
  const p = new URLSearchParams(defaults);
  for (const k of keys) {
    const v = args[k];
    if (v !== undefined && v !== null && v !== '') {
      p.set(k, String(v));
    }
  }
  return p.toString();
}

export const postmarkProvider: BuiltinProvider = {
  slug: 'postmark',
  name: 'Postmark (transactional email)',
  description:
    'Send transactional and broadcast email through the client\'s own Postmark account, and see what happened to it — delivery status, bounces, suppressions and templates.',
  perConnection: true,
  credentialLabel:
    'The Postmark SERVER API Token for this client\'s server (Postmark → Servers → the server → API Tokens). Not the Account token, and not the SMTP password.',
  targetLabel: 'Default From address',
  targetPlaceholder: 'news@clientdomain.com — must be a CONFIRMED Sender Signature in Postmark',
  targetIsUrl: false,

  /**
   * Cross-tool rules. Every line here is a mistake that costs a real send —
   * and unlike most tool errors, a bad send cannot be undone.
   */
  guidance: [
    'POSTMARK CANNOT SCHEDULE. There is no send-at parameter in its API; every send tool fires immediately. To send later, create_scheduled_task with startAt set to the send time and once=true, and put the full message in the task prompt. Never simulate a delay by any other means.',
    'A one-off send scheduled WITHOUT once=true will repeat on every interval forever. For email that is not a nuisance, it is a reputation incident.',
    'The From address must be a confirmed Sender Signature or the send fails with code 400/401. Omit From and the connection default is used, which is already a confirmed one.',
    'Bulk and marketing mail must go on a BROADCAST message stream; the default "outbound" stream is transactional-only and rejects it (code 1101). Check with postmark_call GET /message-streams if unsure.',
    'Error 406 (inactive recipient) means Postmark is refusing an address it previously suppressed — the fix is search_bounces to find out why, not a retry. Retrying never clears it.',
    'send_batch gives each recipient their own message. Never put a mailing list in To or Cc.',
    'Sends go through the approvals gateway by default. Do not ask for that to be turned off to make a run smoother.',
  ].join('\n'),

  tools,

  call: async (tool, args, credential, target, ctx): Promise<string> => {
    const token = (credential ?? '').trim();
    if (!token) {
      throw new Error('No Postmark server token configured for this connection.');
    }
    const defaultFrom = (target ?? '').trim();

    if (tool === 'send_email') {
      const msg = buildMessage(args, defaultFrom);
      const attachments = await loadAttachments(args.attachFileIds, ctx?.tenantId);
      if (attachments.length) {
        msg.Attachments = attachments;
      }
      const res = await pm('/email', token, { method: 'POST', body: msg });
      return sendSummary(res, msg, attachments.map(a => a.Name));
    }

    if (tool === 'send_with_template') {
      const alias = args.TemplateAlias ? String(args.TemplateAlias).trim() : '';
      const id = args.TemplateId !== undefined ? Number(args.TemplateId) : null;
      if (!alias && !id) {
        throw new Error('Provide TemplateAlias or TemplateId. Call list_templates to see what exists.');
      }
      const from = String(args.From ?? defaultFrom ?? '').trim();
      if (!from) {
        throw new Error('No From address. Set a default From on this connection or pass From explicitly.');
      }
      const to = addressList(args.To);
      if (!to) {
        throw new Error('Provide at least one To address.');
      }

      const body: Record<string, unknown> = {
        From: from,
        To: to,
        TemplateModel: args.TemplateModel ?? {},
        MessageStream: String(args.MessageStream ?? 'outbound'),
        ...(alias ? { TemplateAlias: alias } : { TemplateId: id }),
      };
      for (const k of ['Cc', 'Bcc', 'ReplyTo', 'Tag'] as const) {
        if (args[k]) {
          body[k] = String(args[k]);
        }
      }

      const attachments = await loadAttachments(args.attachFileIds, ctx?.tenantId);
      if (attachments.length) {
        body.Attachments = attachments;
      }

      const res = await pm('/email/withTemplate', token, { method: 'POST', body });
      return sendSummary(res, body, attachments.map(a => a.Name));
    }

    if (tool === 'send_batch') {
      const raw = Array.isArray(args.messages) ? args.messages : [];
      if (!raw.length) {
        throw new Error('Provide a non-empty messages array.');
      }
      if (raw.length > MAX_BATCH) {
        throw new Error(
          `Postmark accepts at most ${MAX_BATCH} messages per batch — got ${raw.length}. Split the list and call again.`,
        );
      }

      const streamDefault = args.MessageStream ? String(args.MessageStream) : undefined;
      const messages = raw.map((m, i) => {
        try {
          const built = buildMessage(m as Record<string, unknown>, defaultFrom);
          if (streamDefault && !(m as Record<string, unknown>).MessageStream) {
            built.MessageStream = streamDefault;
          }
          return built;
        } catch (err) {
          throw new Error(
            `messages[${i}] is invalid: ${err instanceof Error ? err.message : 'unknown'} — nothing was sent.`,
          );
        }
      });

      const res = await pm('/email/batch', token, { method: 'POST', body: messages });
      const list = Array.isArray(res) ? res : [];
      // Postmark returns 200 for a batch where individual messages failed, so
      // the per-message ErrorCodes are the real result. Reporting only the HTTP
      // status here would claim a clean send for a half-rejected batch.
      const failed = list
        .map((r: any, i: number) => ({ i, code: Number(r?.ErrorCode ?? 0), message: r?.Message, to: messages[i]?.To }))
        .filter(r => r.code !== 0);

      return out({
        requested: messages.length,
        accepted: list.length - failed.length,
        rejected: failed.length,
        failures: failed.slice(0, 50),
        note: failed.length
          ? 'Accepted messages ARE already sending — only the listed ones failed. Do not resend the whole batch; resend only the failures.'
          : 'All messages accepted by Postmark and sending now.',
      });
    }

    if (tool === 'list_templates') {
      const res = await pm(`/templates?${qs(args, ['count', 'offset'], { count: '100', offset: '0' })}`, token);
      const list = (res.Templates ?? []) as any[];
      return out({
        total: res.TotalCount ?? list.length,
        templates: list.map(t => ({
          id: t.TemplateId,
          alias: t.Alias,
          name: t.Name,
          subject: t.Subject ?? null,
          active: t.Active,
        })),
      });
    }

    if (tool === 'search_messages') {
      const query = qs(
        args,
        ['recipient', 'tag', 'subject', 'status', 'fromdate', 'todate', 'messagestream', 'count', 'offset'],
        { count: '50', offset: '0' },
      );
      const res = await pm(`/messages/outbound?${query}`, token);
      const list = (res.Messages ?? []) as any[];
      return out({
        total: res.TotalCount ?? list.length,
        messages: list.map(m => ({
          messageId: m.MessageID,
          to: m.Recipients ?? m.To,
          subject: m.Subject,
          status: m.Status,
          tag: m.Tag ?? null,
          stream: m.MessageStream ?? null,
          sentAt: m.ReceivedAt,
        })),
        note: 'Status "sent" means Postmark handed it to the receiving server — not that a human read it. Use message_details for the delivery events.',
      });
    }

    if (tool === 'message_details') {
      const id = String(args.messageId ?? '').trim();
      if (!id) {
        throw new Error('Provide messageId.');
      }
      return out(await pm(`/messages/outbound/${encodeURIComponent(id)}/details`, token));
    }

    if (tool === 'delivery_stats') {
      const res = await pm('/deliverystats', token);
      return out({
        inactiveMails: res.InactiveMails ?? 0,
        bounces: (res.Bounces ?? []).map((b: any) => ({ type: b.Type ?? 'All', name: b.Name, count: b.Count })),
      });
    }

    if (tool === 'search_bounces') {
      const count = Math.min(Number(args.count) || 50, MAX_BOUNCE_COUNT);
      const query = qs(
        { ...args, count },
        ['emailFilter', 'type', 'inactive', 'tag', 'fromdate', 'todate', 'count', 'offset'],
        { count: String(count), offset: '0' },
      );
      const res = await pm(`/bounces?${query}`, token);
      const list = (res.Bounces ?? []) as any[];
      return out({
        total: res.TotalCount ?? list.length,
        bounces: list.map(b => ({
          id: b.ID,
          email: b.Email,
          type: b.Type,
          description: b.Description,
          details: b.Details,
          inactive: b.Inactive,
          canActivate: b.CanActivate,
          bouncedAt: b.BouncedAt,
        })),
        note: 'inactive=true means Postmark will refuse this address until it is reactivated. canActivate=false means it cannot be (spam complaints).',
      });
    }

    if (tool === 'activate_bounce') {
      const id = String(args.bounceId ?? '').trim();
      if (!id) {
        throw new Error('Provide bounceId (from search_bounces).');
      }
      const res = await pm(`/bounces/${encodeURIComponent(id)}/activate`, token, { method: 'PUT' });
      return out({
        reactivated: true,
        bounceId: id,
        message: res?.Message ?? null,
        email: res?.Bounce?.Email ?? null,
      });
    }

    if (tool === 'list_suppressions') {
      const stream = String(args.stream ?? 'outbound').trim() || 'outbound';
      const query = qs(args, ['origin', 'fromdate']);
      const res = await pm(
        `/message-streams/${encodeURIComponent(stream)}/suppressions/dump${query ? `?${query}` : ''}`,
        token,
      );
      const list = (res.Suppressions ?? []) as any[];
      return out({
        stream,
        count: list.length,
        suppressions: list.map(s => ({
          email: s.EmailAddress,
          reason: s.SuppressionReason,
          origin: s.Origin,
          createdAt: s.CreatedAt,
        })),
      });
    }

    if (tool === 'suppress_addresses' || tool === 'unsuppress_addresses') {
      const stream = String(args.stream ?? 'outbound').trim() || 'outbound';
      const emails = (Array.isArray(args.emails) ? args.emails : [args.emails])
        .map(e => String(e ?? '').trim())
        .filter(Boolean);
      if (!emails.length) {
        throw new Error('Provide at least one email address.');
      }
      if (emails.length > MAX_SUPPRESSIONS) {
        throw new Error(
          `Postmark accepts at most ${MAX_SUPPRESSIONS} addresses per call — got ${emails.length}. Split the list.`,
        );
      }

      const adding = tool === 'suppress_addresses';
      const path = `/message-streams/${encodeURIComponent(stream)}/suppressions${adding ? '' : '/delete'}`;
      const res = await pm(path, token, {
        method: 'POST',
        body: { Suppressions: emails.map(EmailAddress => ({ EmailAddress })) },
      });

      const results = (res.Suppressions ?? []) as any[];
      return out({
        stream,
        action: adding ? 'suppressed' : 'unsuppressed',
        results: results.map(r => ({
          email: r.EmailAddress,
          status: r.Status,
          message: r.Message ?? null,
        })),
        note: adding
          ? 'These addresses will no longer receive mail on this stream.'
          : 'Removal is asynchronous — re-check with list_suppressions. Spam-complaint suppressions cannot be removed.',
      });
    }

    if (tool === 'postmark_call') {
      const method = String(args.method ?? 'GET').toUpperCase();
      let path = String(args.path ?? '').trim();
      if (!path) {
        throw new Error('Provide a path, e.g. /message-streams');
      }
      if (!path.startsWith('/')) {
        path = `/${path}`;
      }
      if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) {
        throw new Error(`Unsupported method ${method}.`);
      }
      return out(
        await pm(path, token, {
          method,
          ...(args.body === undefined ? {} : { body: args.body }),
        }),
      );
    }

    throw new Error(`Unknown Postmark tool: ${tool}`);
  },
};
