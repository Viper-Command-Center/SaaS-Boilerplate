/**
 * Postmark adapter — the things that are worth testing without a Postmark
 * account in front of you.
 *
 * The bias here is toward the failures that cannot be undone. A wrong query
 * against a read API is a wasted call; a wrong send has already reached a real
 * inbox by the time anyone notices. So the cases below concentrate on the
 * message that gets BUILT and on refusing to report success that did not
 * happen — not on Postmark's own behaviour, which is its problem.
 *
 * None of this touches the network: `pm` is exercised through a stubbed fetch.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { addressList, buildMessage, postmarkProvider } from '@/libs/plugins/postmark';

const FROM = 'news@clientdomain.com';
const TOKEN = 'server-token';

/** Stub global fetch with one canned response. */
function stubFetch(body: unknown, init?: { status?: number }) {
  const spy = vi.fn(async () => new Response(
    typeof body === 'string' ? body : JSON.stringify(body),
    { status: init?.status ?? 200, headers: { 'Content-Type': 'application/json' } },
  ));
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('addressList', () => {
  it('passes a single address through', () => {
    expect(addressList('a@b.com')).toBe('a@b.com');
  });

  it('joins an array the way Postmark expects', () => {
    expect(addressList(['a@b.com', 'c@d.com'])).toBe('a@b.com,c@d.com');
  });

  it('trims each address — a stray space is a 300 from Postmark', () => {
    expect(addressList([' a@b.com ', 'c@d.com '])).toBe('a@b.com,c@d.com');
  });

  it('treats empty and missing as absent rather than as an empty string', () => {
    expect(addressList('')).toBeUndefined();
    expect(addressList(undefined)).toBeUndefined();
    expect(addressList([])).toBeUndefined();
    expect(addressList(['', '  '])).toBeUndefined();
  });
});

describe('buildMessage', () => {
  it('falls back to the connection default From', () => {
    const m = buildMessage({ To: 'x@y.com', Subject: 'hi', TextBody: 'yo' }, FROM);

    expect(m.From).toBe(FROM);
  });

  it('lets an explicit From win — one server can hold several signatures', () => {
    const m = buildMessage({ To: 'x@y.com', Subject: 'hi', TextBody: 'yo', From: 'other@c.com' }, FROM);

    expect(m.From).toBe('other@c.com');
  });

  /**
   * With no default and no explicit From, Postmark would answer with error 400
   * ("Sender Signature not found") which reads as an account problem. Failing
   * here instead names the actual cause: nobody configured the connection.
   */
  it('refuses to build a message with no From at all', () => {
    expect(() => buildMessage({ To: 'x@y.com', Subject: 'hi', TextBody: 'yo' }, ''))
      .toThrow(/No From address/);
  });

  it('requires a recipient', () => {
    expect(() => buildMessage({ Subject: 'hi', TextBody: 'yo' }, FROM)).toThrow(/at least one To/);
  });

  /**
   * Postmark rejects a message with neither body, but only after it has been
   * accepted for processing — so the failure arrives detached from the call
   * that caused it. Catching it locally keeps the error next to the mistake.
   */
  it('requires at least one body', () => {
    expect(() => buildMessage({ To: 'x@y.com', Subject: 'hi' }, FROM)).toThrow(/HtmlBody, TextBody/);
  });

  it('accepts either body alone', () => {
    expect(buildMessage({ To: 'x@y.com', HtmlBody: '<p>hi</p>' }, FROM).HtmlBody).toBe('<p>hi</p>');
    expect(buildMessage({ To: 'x@y.com', TextBody: 'hi' }, FROM).TextBody).toBe('hi');
  });

  // Omitting MessageStream lets Postmark silently pick the transactional one.
  // Naming it means a bulk send on the wrong stream is visible in the payload.
  it('always names a message stream, defaulting to outbound', () => {
    expect(buildMessage({ To: 'x@y.com', TextBody: 'hi' }, FROM).MessageStream).toBe('outbound');
    expect(buildMessage({ To: 'x@y.com', TextBody: 'hi', MessageStream: 'broadcast' }, FROM).MessageStream).toBe('broadcast');
  });

  it('omits optional fields rather than sending empty ones', () => {
    const m = buildMessage({ To: 'x@y.com', TextBody: 'hi' }, FROM);

    expect(m).not.toHaveProperty('Cc');
    expect(m).not.toHaveProperty('Bcc');
    expect(m).not.toHaveProperty('ReplyTo');
    expect(m).not.toHaveProperty('Tag');
  });
});

describe('error translation', () => {
  it('names the real cause of a 401 instead of echoing "unauthorized"', async () => {
    stubFetch('', { status: 401 });

    await expect(postmarkProvider.call('delivery_stats', {}, TOKEN, FROM))
      .rejects.toThrow(/SERVER API Token/);
  });

  /**
   * 406 is the one an agent will otherwise retry forever: the address is
   * suppressed, so every attempt fails identically. The hint has to say that
   * retrying is not the fix.
   */
  it('explains an inactive recipient (406) and points at the fix', async () => {
    stubFetch({ ErrorCode: 406, Message: 'You tried to send to a recipient that has been marked as inactive.' }, { status: 422 });

    await expect(postmarkProvider.call('send_email', { To: 'x@y.com', Subject: 's', TextBody: 'b' }, TOKEN, FROM))
      .rejects.toThrow(/search_bounces/);
  });

  it('explains an unconfirmed Sender Signature (400)', async () => {
    stubFetch({ ErrorCode: 400, Message: 'Sender Signature not found.' }, { status: 422 });

    await expect(postmarkProvider.call('send_email', { To: 'x@y.com', Subject: 's', TextBody: 'b' }, TOKEN, FROM))
      .rejects.toThrow(/Sender Signature/);
  });

  it('keeps Postmark\'s own message for codes it has no hint for', async () => {
    stubFetch({ ErrorCode: 505, Message: 'Something specific and unusual.' }, { status: 422 });

    await expect(postmarkProvider.call('delivery_stats', {}, TOKEN, FROM))
      .rejects.toThrow(/Something specific and unusual/);
  });

  it('refuses to run at all without a token', async () => {
    await expect(postmarkProvider.call('delivery_stats', {}, '', FROM)).rejects.toThrow(/No Postmark server token/);
  });

  it('rejects an unknown tool name rather than silently no-oping', async () => {
    await expect(postmarkProvider.call('send_carrier_pigeon', {}, TOKEN, FROM)).rejects.toThrow(/Unknown Postmark tool/);
  });
});

describe('send_email', () => {
  it('posts to /email and reports the message id', async () => {
    const spy = stubFetch({ MessageID: 'abc-123', SubmittedAt: '2026-08-12T10:00:00Z', ErrorCode: 0 });

    const res = JSON.parse(await postmarkProvider.call(
      'send_email',
      { To: 'x@y.com', Subject: 'Hello', TextBody: 'Hi' },
      TOKEN,
      FROM,
    ) as string);

    expect(res.sent).toBe(true);
    expect(res.messageId).toBe('abc-123');

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];

    expect(url).toBe('https://api.postmarkapp.com/email');
    expect((init.headers as Record<string, string>)['X-Postmark-Server-Token']).toBe(TOKEN);
    expect(JSON.parse(init.body as string).From).toBe(FROM);
  });

  // The agent must never present a send as reversible, because it isn't.
  it('says plainly that the message cannot be recalled', async () => {
    stubFetch({ MessageID: 'abc-123', ErrorCode: 0 });

    const res = JSON.parse(await postmarkProvider.call(
      'send_email',
      { To: 'x@y.com', Subject: 'Hello', TextBody: 'Hi' },
      TOKEN,
      FROM,
    ) as string);

    expect(res.note).toMatch(/cannot be recalled/);
  });
});

describe('send_batch', () => {
  it('validates every message BEFORE sending any of them', async () => {
    const spy = stubFetch([]);

    await expect(postmarkProvider.call(
      'send_batch',
      { messages: [{ To: 'a@b.com', TextBody: 'ok' }, { To: '', TextBody: 'bad' }] },
      TOKEN,
      FROM,
    )).rejects.toThrow(/messages\[1\].*nothing was sent/);

    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses a batch over Postmark\'s 500 limit instead of letting it 422', async () => {
    const spy = stubFetch([]);
    const messages = Array.from({ length: 501 }, (_, i) => ({ To: `u${i}@b.com`, TextBody: 'hi' }));

    await expect(postmarkProvider.call('send_batch', { messages }, TOKEN, FROM)).rejects.toThrow(/at most 500/);
    expect(spy).not.toHaveBeenCalled();
  });

  /**
   * The case this whole tool exists to get right. Postmark answers a
   * half-rejected batch with HTTP 200, so trusting the status would report a
   * clean send while a third of the list never got the mail.
   */
  it('reports partial failure even though the HTTP status is 200', async () => {
    stubFetch([
      { ErrorCode: 0, MessageID: 'm1' },
      { ErrorCode: 406, Message: 'Inactive recipient' },
      { ErrorCode: 0, MessageID: 'm3' },
    ]);

    const res = JSON.parse(await postmarkProvider.call(
      'send_batch',
      {
        messages: [
          { To: 'a@b.com', TextBody: 'hi' },
          { To: 'dead@b.com', TextBody: 'hi' },
          { To: 'c@b.com', TextBody: 'hi' },
        ],
      },
      TOKEN,
      FROM,
    ) as string);

    expect(res.requested).toBe(3);
    expect(res.accepted).toBe(2);
    expect(res.rejected).toBe(1);
    expect(res.failures[0].to).toBe('dead@b.com');
    // Resending the whole batch would double-mail the two that succeeded.
    expect(res.note).toMatch(/only the failures/);
  });

  it('applies a batch-level stream to messages that do not set their own', async () => {
    const spy = stubFetch([{ ErrorCode: 0 }, { ErrorCode: 0 }]);

    await postmarkProvider.call(
      'send_batch',
      {
        messages: [
          { To: 'a@b.com', TextBody: 'hi' },
          { To: 'c@b.com', TextBody: 'hi', MessageStream: 'special' },
        ],
        MessageStream: 'broadcast',
      },
      TOKEN,
      FROM,
    );

    const sent = JSON.parse((spy.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);

    expect(sent[0].MessageStream).toBe('broadcast');
    expect(sent[1].MessageStream).toBe('special');
  });
});

describe('suppressions', () => {
  it('adds to the suppression list on the right stream', async () => {
    const spy = stubFetch({ Suppressions: [{ EmailAddress: 'a@b.com', Status: 'Suppressed' }] });

    await postmarkProvider.call('suppress_addresses', { emails: ['a@b.com'], stream: 'broadcast' }, TOKEN, FROM);

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];

    expect(url).toBe('https://api.postmarkapp.com/message-streams/broadcast/suppressions');
    expect(JSON.parse(init.body as string)).toEqual({ Suppressions: [{ EmailAddress: 'a@b.com' }] });
  });

  // Same payload, different path — posting a removal to the add endpoint would
  // suppress the very addresses someone asked to reinstate.
  it('routes removals to the /delete endpoint', async () => {
    const spy = stubFetch({ Suppressions: [] });

    await postmarkProvider.call('unsuppress_addresses', { emails: ['a@b.com'] }, TOKEN, FROM);

    expect((spy.mock.calls[0] as unknown as [string])[0])
      .toBe('https://api.postmarkapp.com/message-streams/outbound/suppressions/delete');
  });

  it('refuses more than Postmark\'s 50 per call', async () => {
    const spy = stubFetch({ Suppressions: [] });
    const emails = Array.from({ length: 51 }, (_, i) => `u${i}@b.com`);

    await expect(postmarkProvider.call('suppress_addresses', { emails }, TOKEN, FROM)).rejects.toThrow(/at most 50/);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('postmark_call escape hatch', () => {
  it('normalises a path missing its leading slash', async () => {
    const spy = stubFetch({ MessageStreams: [] });

    await postmarkProvider.call('postmark_call', { path: 'message-streams' }, TOKEN, FROM);

    expect((spy.mock.calls[0] as unknown as [string])[0]).toBe('https://api.postmarkapp.com/message-streams');
  });

  it('rejects a method outside the allowed set', async () => {
    await expect(postmarkProvider.call('postmark_call', { path: '/x', method: 'TRACE' }, TOKEN, FROM))
      .rejects.toThrow(/Unsupported method/);
  });
});

describe('provider wiring', () => {
  it('is per-connection with a non-URL target', () => {
    expect(postmarkProvider.perConnection).toBe(true);
    // The target is a From address; validating it as a URL would reject the
    // only correct answer (the Phase 30.1 failure).
    expect(postmarkProvider.targetIsUrl).toBe(false);
  });

  it('tells the agent, in guidance, that Postmark cannot schedule', () => {
    expect(postmarkProvider.guidance).toMatch(/CANNOT SCHEDULE/);
    expect(postmarkProvider.guidance).toMatch(/once=true/);
  });

  it('exposes no tool that could reach account-level endpoints', () => {
    const names = postmarkProvider.tools.map(t => t.name);

    expect(names).not.toContain('create_server');
    expect(names).not.toContain('list_servers');
  });
});
