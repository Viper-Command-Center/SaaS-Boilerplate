/**
 * Cloudflare DNS — built-in provider (tier 2, one account-wide API token).
 *
 * 🔴 THIS IS THE HIGHEST-BLAST-RADIUS ADAPTER IN THE PLATFORM. Read this before
 * changing anything below.
 *
 * One token covers every zone on the account, and Cloudflare hosts DNS for all
 * of this agency's client sites. A wrong record here does not produce a broken
 * page in a CMS someone can undo: it takes a church's website and its email
 * offline simultaneously, for everyone, and it propagates to resolvers before
 * anybody notices. There is no equivalent of "restore the draft".
 *
 * The guardrails are therefore in the ADAPTER, not only in the approvals
 * gateway, because approval fatigue is real and a human clicking through a
 * change they do not understand is the normal case, not the exception:
 *
 *  · NS and SOA records cannot be touched at all. Editing them is how a domain
 *    stops resolving entirely, and no routine task needs it.
 *  · Deleting requires confirm_destructive, so the deletion is a visible
 *    argument in the approval a human reads rather than a verb in a URL.
 *  · MX and the zone apex are flagged in every response, because "the website
 *    is fine" and "email still works" are checked by different people, usually
 *    a day apart.
 *  · Writes never invent a TTL or a proxy setting silently; both are echoed
 *    back so the approval shows what will actually be stored.
 *
 * Cloudflare answers 200 with success:false for some failures, exactly like
 * SmarterMail — see the check in cf() before trusting a status.
 *
 * Credential: an API token with Zone → DNS → Edit and Zone → Zone → Read.
 * No target: the token itself scopes which zones are visible.
 */

import type { BuiltinProvider, BuiltinTool } from '@/libs/plugins/types';

const API = 'https://api.cloudflare.com/client/v4';
const MAX_OUTPUT = 60_000;

/**
 * Record types that define who is authoritative for the domain.
 *
 * Refused outright rather than gated behind a confirmation flag. A confirmation
 * only proves the agent set a boolean; it does not mean anyone understood that
 * rewriting NS delegates the entire domain elsewhere. Cloudflare's own UI does
 * not let you edit these from the records list either.
 */
const PROTECTED_TYPES = new Set(['NS', 'SOA']);

/** Changing one of these breaks something a different person will notice. */
const HIGH_IMPACT = new Set(['MX', 'TXT', 'A', 'AAAA', 'CNAME']);

function cap(value: unknown): string {
  const json = JSON.stringify(value);
  return json.length <= MAX_OUTPUT
    ? json
    : `${json.slice(0, MAX_OUTPUT)}\n…truncated. Narrow the query — filter by type or name.`;
}

/** One Cloudflare API call. */
async function cf(
  token: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<Record<string, any>> {
  const method = (init?.method ?? (init?.body === undefined ? 'GET' : 'POST')).toUpperCase();

  let resp: Response;
  try {
    resp = await fetch(`${API}${path}`, {
      method,
      signal: AbortSignal.timeout(30_000),
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch (e) {
    throw new Error(`Cloudflare: could not reach the API — ${e instanceof Error ? e.message : String(e)}`);
  }

  const body = await resp.json().catch(() => ({})) as Record<string, any>;

  if (!resp.ok || body.success === false) {
    const errors = Array.isArray(body.errors)
      ? body.errors.map((e: any) => `${e.code ?? '?'}: ${e.message ?? ''}`).join(' | ')
      : `HTTP ${resp.status}`;

    // The two failures worth translating, because Cloudflare's wording sends
    // people to the wrong screen.
    // ORDER MATTERS. An OAuth scope error also arrives as 403, so this must be
    // tested BEFORE the permission branch — otherwise the adapter confidently
    // reports the one cause that is definitely wrong, and sends someone off to
    // widen a token that is never consulted. That is the exact round trip this
    // hint exists to prevent.
    let hint = '';
    if (/insufficient_scope|user:read|account:read/i.test(errors)) {
      hint = ' — that is an OAuth error from Cloudflare\'s hosted MCP server, not this adapter. '
        + 'This connection should be the built-in Cloudflare DNS plugin with an API token, not an MCP URL. '
        + 'No API token, however permissive, will satisfy it.';
    } else if (resp.status === 403 || /9109|authentication|permission/i.test(errors)) {
      hint = ' — the API token is missing a permission. DNS needs Zone → DNS → Edit (or Read) AND '
        + 'Zone → Zone → Read, and the token\'s Zone Resources must include this domain.';
    }

    throw new Error(`Cloudflare rejected the request (${method} ${path}): ${errors}${hint}`);
  }

  return body;
}

/** Resolve a domain name to its zone id, so callers never handle zone ids. */
async function zoneIdFor(token: string, domain: string): Promise<{ id: string; name: string }> {
  const name = String(domain ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!name) {
    throw new Error('Cloudflare: which domain? Pass the zone name, e.g. examplechurch.org.');
  }

  const body = await cf(token, `/zones?name=${encodeURIComponent(name)}`);
  const zone = (body.result ?? [])[0];
  if (!zone?.id) {
    throw new Error(
      `Cloudflare: no zone called "${name}" is visible to this token. Either the domain is on a different `
      + 'Cloudflare account, or the token\'s Zone Resources do not include it. Use list_zones to see what is reachable.',
    );
  }
  return { id: String(zone.id), name: String(zone.name) };
}

/** Flag the records whose breakage is noticed by someone other than the asker. */
function impactNote(type: string, name: string, zone: string): string | undefined {
  const t = type.toUpperCase();
  if (t === 'MX') {
    return 'MX record — this controls where EMAIL for the domain is delivered. Getting it wrong stops mail arriving, silently, and senders get no bounce for hours.';
  }
  if (t === 'TXT') {
    return 'TXT record — SPF, DKIM and DMARC live here. A malformed one sends legitimate mail to spam without any visible error.';
  }
  if ((t === 'A' || t === 'AAAA' || t === 'CNAME') && (name === zone || name === `www.${zone}`)) {
    return 'This is the zone apex or www — it points the main website. A wrong value takes the whole site offline.';
  }
  return undefined;
}

const tools: BuiltinTool[] = [
  {
    name: 'list_zones',
    description: 'Every domain (zone) this Cloudflare token can see, with its status and nameservers. Start here — every other tool takes a domain name, not a zone id.',
    input_schema: {
      type: 'object',
      properties: { search: { type: 'string', description: 'Filter by name fragment' } },
    },
  },
  {
    name: 'list_records',
    description: 'DNS records for a domain. Use this before proposing ANY change — quote the current value so the human approving can see exactly what is being replaced.',
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'e.g. examplechurch.org' },
        type: { type: 'string', description: 'Filter: A, AAAA, CNAME, MX, TXT, NS…' },
        name: { type: 'string', description: 'Filter by record name' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'create_record',
    description: 'Add a DNS record. Check list_records first — a duplicate A or a second SPF TXT record breaks things in ways that look like something else entirely.',
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string' },
        type: { type: 'string', description: 'A, AAAA, CNAME, MX, TXT, SRV, CAA' },
        name: { type: 'string', description: 'Full name or "@" for the zone apex' },
        content: { type: 'string', description: 'The value — an IP for A, a hostname for CNAME/MX, the string for TXT' },
        ttl: { type: 'number', description: 'Seconds; 1 means automatic (default)' },
        priority: { type: 'number', description: 'MX and SRV only' },
        proxied: { type: 'boolean', description: 'Route through Cloudflare (orange cloud). Only valid for A, AAAA and CNAME.' },
      },
      required: ['domain', 'type', 'name', 'content'],
    },
  },
  {
    name: 'update_record',
    description: 'Change an existing record, found by its id from list_records. Only the fields you pass are altered.',
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string' },
        record_id: { type: 'string', description: 'From list_records' },
        content: { type: 'string' },
        ttl: { type: 'number' },
        priority: { type: 'number' },
        proxied: { type: 'boolean' },
      },
      required: ['domain', 'record_id'],
    },
  },
  {
    name: 'delete_record',
    description: 'Delete a DNS record. IRREVERSIBLE and it propagates. Requires confirm_destructive, and you must state to the human exactly which record — name, type and current value — before asking.',
    input_schema: {
      type: 'object',
      properties: {
        domain: { type: 'string' },
        record_id: { type: 'string', description: 'From list_records' },
        confirm_destructive: {
          type: 'boolean',
          description: 'Required. Setting it means a human has been told which record will be removed and what it currently points at.',
        },
      },
      required: ['domain', 'record_id'],
    },
  },
];

export const cloudflareDnsProvider: BuiltinProvider = {
  slug: 'cloudflare-dns',
  name: 'Cloudflare DNS',
  description:
    'Read and manage DNS across every domain on a Cloudflare account — records, mail routing, SPF/DKIM/DMARC and site pointers. Nameserver records are read-only, and deletions require explicit confirmation.',
  perConnection: true,
  credentialLabel:
    'A Cloudflare API token with Zone → DNS → Edit and Zone → Zone → Read (dash.cloudflare.com → My Profile → API Tokens). Paste the raw token; a "Bearer " prefix is stripped automatically.',
  // The token decides which zones are reachable, so there is nothing per-site to
  // configure. Declared explicitly so the connect form does not demand a URL.
  targetLabel: 'Not used — the API token decides which zones are visible',
  targetPlaceholder: 'Leave blank',
  targetIsUrl: false,

  guidance: [
    'DNS IS THE HIGHEST-CONSEQUENCE THING YOU CAN CHANGE HERE. One record takes a client\'s website and their email offline at the same time, it affects everyone at once, and it propagates before anyone notices. Nothing about a DNS task is routine.',
    'ALWAYS call list_records and quote the CURRENT value before proposing a change. An approval that says "update the A record" is not reviewable; one that says "change @ A from 203.0.113.10 to 198.51.100.5" is.',
    'NS and SOA records cannot be changed through this plugin at all. If a task seems to need it, stop and hand it to a human — that is the change that makes a domain stop resolving entirely.',
    'MX and TXT are email. Mail failures are silent and delayed: nobody gets an error, messages simply stop arriving, and it is usually noticed a day later by someone who was not in this conversation. Treat any MX or SPF/DKIM/DMARC edit as an email change, and say so.',
    'Adding a SECOND SPF record does not merge with the first — it invalidates both. Edit the existing TXT record instead of creating another.',
    '"proxied" (the orange cloud) only applies to A, AAAA and CNAME. Turning it on for a mail host breaks mail, because Cloudflare proxies HTTP only.',
    'This account holds DNS for many clients. State which domain you acted on in every message; a change applied to the wrong zone looks identical to one that worked.',
  ].join('\n'),

  tools,

  call: async (tool, args, credential): Promise<string> => {
    // Same forgiving parse as the analytics adapter: built-in providers take the
    // raw secret, but HTTP MCP connections need "Bearer " and people mix them up.
    const token = (credential ?? '').trim().replace(/^Bearer\s+/i, '').trim();
    if (!token) {
      throw new Error('No Cloudflare API token configured for this connection.');
    }

    if (tool === 'list_zones') {
      const body = await cf(token, '/zones?per_page=200');
      const search = args.search ? String(args.search).toLowerCase() : null;
      const zones = ((body.result ?? []) as any[])
        .filter(z => !search || String(z.name ?? '').toLowerCase().includes(search))
        .map(z => ({
          name: z.name,
          status: z.status,
          paused: z.paused,
          nameServers: z.name_servers,
        }));
      return cap({ count: zones.length, zones });
    }

    if (tool === 'list_records') {
      const zone = await zoneIdFor(token, String(args.domain));
      const qs = new URLSearchParams({ per_page: '500' });
      if (args.type) {
        qs.set('type', String(args.type).toUpperCase());
      }
      if (args.name) {
        qs.set('name', String(args.name));
      }
      const body = await cf(token, `/zones/${zone.id}/dns_records?${qs}`);
      const records = ((body.result ?? []) as any[]).map(r => ({
        id: r.id,
        type: r.type,
        name: r.name,
        content: r.content,
        ttl: r.ttl,
        priority: r.priority ?? null,
        proxied: r.proxied ?? null,
        editable: !PROTECTED_TYPES.has(String(r.type).toUpperCase()),
        note: impactNote(String(r.type), String(r.name), zone.name),
      }));
      return cap({
        domain: zone.name,
        count: records.length,
        records,
        note: 'Quote the current value of anything you propose to change. editable:false means this plugin will refuse to alter it.',
      });
    }

    if (tool === 'create_record') {
      const type = String(args.type ?? '').toUpperCase();
      if (PROTECTED_TYPES.has(type)) {
        throw new Error(
          `Cloudflare: ${type} records cannot be created through this plugin. They control which servers are `
          + 'authoritative for the domain, and a mistake stops it resolving entirely. This needs a human in the Cloudflare dashboard.',
        );
      }
      const zone = await zoneIdFor(token, String(args.domain));

      const record: Record<string, unknown> = {
        type,
        name: String(args.name),
        content: String(args.content),
        ttl: Number(args.ttl) || 1,
      };
      if (args.priority !== undefined) {
        record.priority = Number(args.priority);
      }
      // Cloudflare rejects `proxied` on record types that cannot be proxied, so
      // only send it where it means something.
      if (args.proxied !== undefined && ['A', 'AAAA', 'CNAME'].includes(type)) {
        record.proxied = Boolean(args.proxied);
      }

      const body = await cf(token, `/zones/${zone.id}/dns_records`, { method: 'POST', body: record });
      const r = body.result ?? {};
      return cap({
        created: true,
        domain: zone.name,
        record: { id: r.id, type: r.type, name: r.name, content: r.content, ttl: r.ttl, proxied: r.proxied ?? null },
        note: impactNote(type, String(r.name ?? ''), zone.name)
          ?? 'Record created. DNS changes propagate — allow a few minutes before testing.',
      });
    }

    if (tool === 'update_record') {
      const zone = await zoneIdFor(token, String(args.domain));
      const id = String(args.record_id ?? '').trim();
      if (!id) {
        throw new Error('Cloudflare: provide record_id (from list_records).');
      }

      // Read before write: refuse to touch a protected type, and report what the
      // value WAS. An approval that cannot show the previous value is not one.
      const existing = await cf(token, `/zones/${zone.id}/dns_records/${encodeURIComponent(id)}`);
      const current = existing.result ?? {};
      const type = String(current.type ?? '').toUpperCase();
      if (PROTECTED_TYPES.has(type)) {
        throw new Error(
          `Cloudflare: that is a ${type} record and this plugin will not change it. Nameserver and SOA records `
          + 'decide whether the domain resolves at all — a human must make this change in the Cloudflare dashboard.',
        );
      }

      const patch: Record<string, unknown> = {};
      if (args.content !== undefined) {
        patch.content = String(args.content);
      }
      if (args.ttl !== undefined) {
        patch.ttl = Number(args.ttl);
      }
      if (args.priority !== undefined) {
        patch.priority = Number(args.priority);
      }
      if (args.proxied !== undefined && ['A', 'AAAA', 'CNAME'].includes(type)) {
        patch.proxied = Boolean(args.proxied);
      }
      if (!Object.keys(patch).length) {
        throw new Error('Cloudflare: nothing to update — pass content, ttl, priority or proxied.');
      }

      const body = await cf(token, `/zones/${zone.id}/dns_records/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: patch,
      });
      const r = body.result ?? {};
      return cap({
        updated: true,
        domain: zone.name,
        previous: { type: current.type, name: current.name, content: current.content, ttl: current.ttl },
        now: { type: r.type, name: r.name, content: r.content, ttl: r.ttl, proxied: r.proxied ?? null },
        note: impactNote(type, String(r.name ?? ''), zone.name)
          ?? 'Updated. DNS changes propagate — allow a few minutes before testing.',
      });
    }

    if (tool === 'delete_record') {
      const zone = await zoneIdFor(token, String(args.domain));
      const id = String(args.record_id ?? '').trim();
      if (!id) {
        throw new Error('Cloudflare: provide record_id (from list_records).');
      }

      const existing = await cf(token, `/zones/${zone.id}/dns_records/${encodeURIComponent(id)}`);
      const current = existing.result ?? {};
      const type = String(current.type ?? '').toUpperCase();
      if (PROTECTED_TYPES.has(type)) {
        throw new Error(
          `Cloudflare: ${type} records cannot be deleted through this plugin — removing one stops the domain resolving.`,
        );
      }

      /**
       * The confirmation is NOT a security control; the agent sets it itself.
       * What it buys is that the deletion, and the value being destroyed, are
       * explicit in the approval a human reads — rather than a DELETE verb
       * hidden in a path they skim past.
       */
      if (args.confirm_destructive !== true) {
        throw new Error(
          `Cloudflare: deleting ${current.type} ${current.name} → "${current.content}" is irreversible and `
          + 'propagates to resolvers. Tell the human exactly this record and what it currently points at, then '
          + 'call again with confirm_destructive: true.',
        );
      }

      await cf(token, `/zones/${zone.id}/dns_records/${encodeURIComponent(id)}`, { method: 'DELETE' });
      return cap({
        deleted: true,
        domain: zone.name,
        record: { type: current.type, name: current.name, content: current.content },
        note: HIGH_IMPACT.has(type)
          ? 'Deleted. This was a high-impact record type — verify the site and email still work rather than assuming.'
          : 'Deleted.',
      });
    }

    throw new Error(`Unknown Cloudflare DNS tool: ${tool}`);
  },
};
