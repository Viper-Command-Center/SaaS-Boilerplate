/**
 * Loops adapter — what is worth testing without a Loops account.
 *
 * Same bias as the Postmark tests: toward the failures that cannot be undone.
 * So the cases concentrate on (1) the body the adapter BUILDS, because Loops'
 * LMX is the thing a model gets wrong first; (2) every path that could put an
 * email in a real inbox — previews, scheduling, transactional — refusing when
 * it should, BEFORE any request is made; and (3) never reporting "sent" for
 * something that is still a draft.
 *
 * Nothing touches the network: `fetch` is stubbed with a small router.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyAlwaysAsk } from '@/libs/plugins/alwaysAsk';
import {
  audienceBody,
  checkFilter,
  contactVariables,
  lintLmx,
  LOOPS_ALWAYS_ASK,
  loopsProvider,
  markdownToLmx,
  parseRecipients,
  previewRecipients,
  senderLocalPart,
} from '@/libs/plugins/loops';

vi.mock('@/libs/storage/files', () => ({
  getFile: vi.fn(async (_tenant: string, id: string) =>
    id === 'png'
      ? { name: 'hero.png', mime: 'image/png', r2Key: 'tenants/t/hero.png' }
      : id === 'pdf'
        ? { name: 'deck.pdf', mime: 'application/pdf', r2Key: 'tenants/t/deck.pdf' }
        : undefined),
}));
vi.mock('@/libs/storage/r2', () => ({
  getObject: vi.fn(async () => ({ body: Buffer.from('fake-image-bytes'), contentType: 'image/png' })),
}));

const KEY = 'loops-key';
const PREVIEW_TO = 'owner@client.com, second@client.com';
const API = 'https://app.loops.so/api/v1';

type Call = { url: string; method: string; headers: Record<string, string>; body: any };
type Route = (call: Call) => { status?: number; body?: unknown } | undefined;

/** Stub fetch with a router; returns the list of calls made. */
function route(handler: Route): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: any) => {
    let body: any;
    try {
      body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    } catch {
      body = init?.body;
    }
    const call: Call = {
      url: String(input),
      method: String(init?.method ?? 'GET'),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body,
    };
    calls.push(call);
    const res = handler(call) ?? { status: 404, body: { message: `unrouted ${call.method} ${call.url}` } };
    return new Response(res.body === undefined ? '' : JSON.stringify(res.body), {
      status: res.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }));
  return calls;
}

const run = (tool: string, args: Record<string, unknown>, target: string = PREVIEW_TO) =>
  loopsProvider.call(tool, args, KEY, target, { tenantId: 't' }) as Promise<string>;

const draft = (over: Record<string, unknown> = {}) => ({
  id: 'camp1',
  name: 'October update',
  status: 'Draft',
  url: 'https://app.loops.so/campaigns/camp1',
  emailMessageId: 'em1',
  mailingListId: 'list1',
  audienceSegmentId: null,
  audienceFilter: null,
  scheduling: null,
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('markdownToLmx', () => {
  it('turns the Markdown a model writes into LMX blocks', () => {
    const lmx = markdownToLmx([
      '# Welcome, {contact.firstName}',
      '',
      'We shipped **three** things and *one* fix.',
      '',
      '- Faster chat',
      '- New themes',
      '',
      '1. Open settings',
      '2. Pick a colour',
      '',
      '---',
      '',
      '> A quote',
    ].join('\n'));

    expect(lmx).toContain('<H1>Welcome, {contact.firstName}</H1>');
    expect(lmx).toContain('<Paragraph>We shipped <Strong>three</Strong> things and <Em>one</Em> fix.</Paragraph>');
    expect(lmx).toContain('<UnorderedList><ListItem>Faster chat</ListItem><ListItem>New themes</ListItem></UnorderedList>');
    expect(lmx).toContain('<OrderedList><ListItem>Open settings</ListItem><ListItem>Pick a colour</ListItem></OrderedList>');
    expect(lmx).toContain('<Divider />');
    expect(lmx).toContain('<Quote>A quote</Quote>');
  });

  it('produces output its own lint accepts', () => {
    const lmx = markdownToLmx('## Hi {contact.firstName}\n\nRead [the docs](https://x.io/a?b=1&c=2) or `run this`.\n\n[button: Open the app](https://app.x.io)');

    expect(lintLmx(lmx)).toEqual([]);
  });

  it('keeps a single newline as a line break — a sign-off is two lines, not one', () => {
    expect(markdownToLmx('Thanks,\nRyan')).toBe('<Paragraph>Thanks,<Br />Ryan</Paragraph>');
  });

  it('escapes text so a stray < or & cannot break the XML', () => {
    expect(markdownToLmx('Fees < 1% & falling')).toBe('<Paragraph>Fees &lt; 1% &amp; falling</Paragraph>');
  });

  it('escapes & inside link URLs and keeps variables in them', () => {
    const lmx = markdownToLmx('[Open](https://app.x.io/u/{contact.userId}?a=1&b=2)');

    expect(lmx).toBe('<Paragraph><Link href="https://app.x.io/u/{contact.userId}?a=1&amp;b=2">Open</Link></Paragraph>');
  });

  it('makes a button from the button convention, with a plain-text label', () => {
    expect(markdownToLmx('[button: **Start** free](https://x.io/go)'))
      .toBe('<Button href="https://x.io/go" align="center">Start free</Button>');
  });

  it('turns an image line into an Image block', () => {
    expect(markdownToLmx('![Launch banner](https://images.vialoops.com/a/b.png)'))
      .toBe('<Image src="https://images.vialoops.com/a/b.png" alt="Launch banner" />');
  });

  it('links bare URLs, without swallowing the full stop after them', () => {
    expect(markdownToLmx('See https://x.io/pricing.'))
      .toBe('<Paragraph>See <Link href="https://x.io/pricing">https://x.io/pricing</Link>.</Paragraph>');
  });

  it('passes a raw LMX block through untouched, so components can be mixed in', () => {
    const lmx = markdownToLmx('<Component componentId="logo" />\n\n# Title');

    expect(lmx).toBe('<Component componentId="logo" />\n<H1>Title</H1>');
  });

  it('handles code inside a link without leaving a placeholder behind', () => {
    const lmx = markdownToLmx('[the `api` docs](https://x.io)');

    expect(lmx).toBe('<Paragraph><Link href="https://x.io">the <Code>api</Code> docs</Link></Paragraph>');
    expect(lmx).not.toMatch(/[\uE000\uE001]/);
  });

  it('does not treat a line of bold text as a bullet', () => {
    expect(markdownToLmx('**Note:** read this')).toBe('<Paragraph><Strong>Note:</Strong> read this</Paragraph>');
  });
});

describe('lintLmx', () => {
  it('accepts valid LMX', () => {
    expect(lintLmx('<Style themeId="st_default" />\n<H1>Hi {contact.firstName}</H1>\n<Paragraph>Body <Strong>bold</Strong></Paragraph>')).toEqual([]);
  });

  it('names the LMX tag to use when it is handed HTML', () => {
    const problems = lintLmx('<p>Hello <a href="https://x.io">there</a></p>');

    expect(problems.join(' ')).toContain('<Paragraph>');
    expect(problems.join(' ')).toContain('<Link href');
  });

  it('flags an unprefixed variable and says what to write instead', () => {
    expect(lintLmx('<Paragraph>Hi {firstName}</Paragraph>').join(' ')).toContain('{contact.firstName}');
  });

  it('flags inline fallbacks — Loops has no such syntax', () => {
    expect(lintLmx('<Paragraph>Hi {contact.firstName|there}</Paragraph>').join(' ')).toContain('fallbacks');
    expect(lintLmx('<Paragraph>Hi {firstName || "there"}</Paragraph>').join(' ')).toContain('fallbacks');
  });

  it('refuses workflow and transactional variables in a campaign', () => {
    expect(lintLmx('<Paragraph>Order {event.orderId}</Paragraph>').join(' ')).toContain('cannot be used in a campaign');
    expect(lintLmx('<Paragraph>Reset: {data.resetLink}</Paragraph>').join(' ')).toContain('cannot be used in a campaign');
  });

  it('ignores whatever is inside a code block', () => {
    expect(lintLmx('<CodeBlock>&lt;div&gt; {anything} <p></CodeBlock>')).toEqual([]);
  });

  it('reports an empty body', () => {
    expect(lintLmx('   ')).toEqual(['The email body is empty.']);
  });

  it('lists the contact variables a body uses', () => {
    expect(contactVariables('<H1>{contact.firstName}</H1><Paragraph>{contact.plan} {contact.firstName}</Paragraph>').sort())
      .toEqual(['firstName', 'plan']);
  });
});

describe('preview recipients', () => {
  it('parses the connection target into a clean list', () => {
    expect(parseRecipients(' Owner@Client.com ; second@client.com, not-an-email ')).toEqual(['owner@client.com', 'second@client.com']);
  });

  it('defaults to every configured address', () => {
    expect(previewRecipients(PREVIEW_TO, undefined)).toEqual(['owner@client.com', 'second@client.com']);
  });

  it('allows a subset of the configured addresses', () => {
    expect(previewRecipients(PREVIEW_TO, ['SECOND@client.com'])).toEqual(['second@client.com']);
  });

  it('refuses an address the connection owner did not configure', () => {
    expect(() => previewRecipients(PREVIEW_TO, ['customer@elsewhere.com'])).toThrow(/only go to the addresses configured/);
  });

  it('refuses outright when nothing is configured', () => {
    expect(() => previewRecipients('', undefined)).toThrow(/no preview recipients configured/);
  });
});

describe('small builders', () => {
  it('reduces a full sender address to the part Loops wants', () => {
    expect(senderLocalPart('ryan@client.com')).toBe('ryan');
    expect(senderLocalPart('news')).toBe('news');
    expect(senderLocalPart('')).toBeUndefined();
  });

  it('builds an audience that is exactly what the call describes', () => {
    expect(audienceBody({ mailingListId: 'l1' })).toEqual({ mailingListId: 'l1', audienceSegmentId: null, audienceFilter: null });
    expect(audienceBody({ allContacts: true })).toEqual({ mailingListId: null, audienceSegmentId: null, audienceFilter: null });
    expect(audienceBody({})).toBeNull();
  });

  it('will not combine "everyone" with a narrower audience', () => {
    expect(() => audienceBody({ allContacts: true, mailingListId: 'l1' })).toThrow(/do not combine/);
  });

  it('rejects a malformed filter with the shape spelled out', () => {
    expect(() => checkFilter({ match: 'both', conditions: [] })).toThrow(/"all" or "any"/);
    expect(() => checkFilter({ match: 'all', conditions: [{ type: 'plan' }] })).toThrow(/property/);
    expect(checkFilter({ match: 'all', conditions: [{ type: 'property', key: 'userGroup', operator: 'notEquals', value: 'canceled' }] }).match).toBe('all');
  });
});

describe('alwaysAsk', () => {
  it('covers every tool that reaches a real inbox or changes a contact', () => {
    expect(LOOPS_ALWAYS_ASK).toEqual(expect.arrayContaining(['set_campaign_schedule', 'send_event', 'send_transactional', 'upsert_contact']));
    expect(loopsProvider.alwaysAsk).toBe(LOOPS_ALWAYS_ASK);

    const names = loopsProvider.tools.map(t => t.name);
    for (const t of LOOPS_ALWAYS_ASK) {
      expect(names).toContain(t);
    }
  });

  it('tightens Auto to Ask, and never loosens anything', () => {
    expect(applyAlwaysAsk('auto', LOOPS_ALWAYS_ASK, 'set_campaign_schedule')).toBe('approval');
    expect(applyAlwaysAsk('auto', LOOPS_ALWAYS_ASK, 'list_campaigns')).toBe('auto');
    expect(applyAlwaysAsk('deny', LOOPS_ALWAYS_ASK, 'set_campaign_schedule')).toBe('deny');
    expect(applyAlwaysAsk('approval', LOOPS_ALWAYS_ASK, 'list_campaigns')).toBe('approval');
    expect(applyAlwaysAsk('auto', undefined, 'anything')).toBe('auto');
  });
});

describe('loopsProvider.call — connection', () => {
  it('refuses to run without a key', async () => {
    await expect(loopsProvider.call('loops_status', {}, '  ', PREVIEW_TO)).rejects.toThrow(/No Loops API key/);
  });

  it('strips a pasted "Bearer " prefix instead of sending it twice', async () => {
    const calls = route(c => (c.url.endsWith('/api-key') ? { body: { success: true, teamName: 'Client Co' } } : { body: { data: [], pagination: {} } }));

    await loopsProvider.call('loops_status', {}, 'Bearer loops-key', PREVIEW_TO);

    expect(calls[0]!.headers.Authorization).toBe('Bearer loops-key');
  });

  it('reports a valid key with the Content API off as exactly that', async () => {
    route(c => (c.url.endsWith('/api-key')
      ? { body: { success: true, teamName: 'Client Co' } }
      : { status: 401, body: { message: 'Invalid API key or content API not enabled for this team.' } }));

    const res = JSON.parse(await run('loops_status', {}));

    expect(res.connected).toBe(true);
    expect(res.team).toBe('Client Co');
    expect(res.contentApi).toBe('NOT AVAILABLE');
    expect(res.previewRecipients).toEqual(['owner@client.com', 'second@client.com']);
  });

  it('explains a rejected key', async () => {
    route(() => ({ status: 401, body: { error: 'Invalid API key' } }));

    await expect(run('loops_status', {})).rejects.toThrow(/wrong or was revoked/);
  });
});

describe('loopsProvider.call — create_campaign', () => {
  it('rejects a bad body before creating anything', async () => {
    const calls = route(() => ({ body: {} }));

    await expect(run('create_campaign', { name: 'X', subject: 'Hi', lmx: '<p>Hello</p>' })).rejects.toThrow(/nothing was saved/);
    expect(calls).toHaveLength(0);
  });

  it('refuses markdown and lmx together', async () => {
    const calls = route(() => ({ body: {} }));

    await expect(run('create_campaign', { name: 'X', subject: 'Hi', markdown: 'a', lmx: '<Paragraph>a</Paragraph>' })).rejects.toThrow(/not both/);
    expect(calls).toHaveLength(0);
  });

  it('creates a draft, saves the converted body against the new revision, and never schedules', async () => {
    const calls = route((c) => {
      if (c.method === 'POST' && c.url === `${API}/campaigns`) {
        return { status: 201, body: draft({ mailingListId: null, emailMessageContentRevisionId: 'rev0' }) };
      }
      if (c.method === 'POST' && c.url === `${API}/email-messages/em1`) {
        return { body: { id: 'em1', contentRevisionId: 'rev1' } };
      }
      if (c.url.endsWith('/guardian')) {
        return { body: { errors: [], warnings: [] } };
      }
      return undefined;
    });

    const res = JSON.parse(await run('create_campaign', {
      name: 'October update',
      subject: 'What is new',
      fromEmail: 'ryan@client.com',
      markdown: '# Hi {contact.firstName}\n\nNews.',
      fallbacks: { firstName: 'there' },
    }));

    const create = calls.find(c => c.url === `${API}/campaigns`)!;

    expect(create.body).toEqual({ name: 'October update' });
    expect(create.body.scheduling).toBeUndefined();

    const save = calls.find(c => c.url === `${API}/email-messages/em1` && c.method === 'POST')!;

    expect(save.body.expectedRevisionId).toBe('rev0');
    expect(save.body.subject).toBe('What is new');
    expect(save.body.fromEmail).toBe('ryan');
    expect(save.body.lmx).toBe('<H1>Hi {contact.firstName}</H1>\n<Paragraph>News.</Paragraph>');
    expect(save.body.contactPropertiesFallbacks).toEqual({ firstName: 'there' });

    expect(res.created).toBe(true);
    expect(res.status).toBe('Draft');
    expect(res.audience).toMatch(/ALL subscribed contacts/);
    expect(res.missingFallbacks).toBeUndefined();
    expect(res.note).toMatch(/has not been sent to anyone/);
  });

  it('points out variables that were given no fallback', async () => {
    route((c) => {
      if (c.url === `${API}/campaigns`) {
        return { status: 201, body: draft({ emailMessageContentRevisionId: 'rev0' }) };
      }
      if (c.url.endsWith('/guardian')) {
        return { body: { errors: [], warnings: [] } };
      }
      return { body: { contentRevisionId: 'rev1' } };
    });

    const res = JSON.parse(await run('create_campaign', { name: 'X', subject: 'Hi', markdown: 'Hi {contact.firstName}' }));

    expect(res.missingFallbacks).toEqual(['firstName']);
  });

  it('says the draft EXISTS when only the content save failed — so it is not created twice', async () => {
    route((c) => {
      if (c.url === `${API}/campaigns`) {
        return { status: 201, body: draft({ emailMessageContentRevisionId: 'rev0' }) };
      }
      return { status: 422, body: { message: 'LMX failed to compile' } };
    });

    await expect(run('create_campaign', { name: 'October update', subject: 'Hi', markdown: 'Hello' }))
      .rejects
      .toThrow(/WAS created \(campaignId camp1[\s\S]*Do NOT call create_campaign again/);
  });
});

describe('loopsProvider.call — update_campaign', () => {
  it('will not edit the email of a campaign that is no longer a draft', async () => {
    const calls = route(c => (c.url === `${API}/campaigns/camp1` ? { body: draft({ status: 'Sent' }) } : undefined));

    await expect(run('update_campaign', { campaignId: 'camp1', subject: 'New' })).rejects.toThrow(/only a Draft's email can be edited/);
    expect(calls.every(c => c.method === 'GET')).toBe(true);
  });

  it('reads the current revision when the agent did not supply one', async () => {
    const calls = route((c) => {
      if (c.url === `${API}/campaigns/camp1`) {
        return { body: draft() };
      }
      if (c.url === `${API}/email-messages/em1` && c.method === 'GET') {
        return { body: { id: 'em1', contentRevisionId: 'rev7' } };
      }
      if (c.url === `${API}/email-messages/em1`) {
        return { body: { id: 'em1', contentRevisionId: 'rev8' } };
      }
      return { body: { errors: [], warnings: [] } };
    });

    const res = JSON.parse(await run('update_campaign', { campaignId: 'camp1', subject: 'New subject' }));
    const save = calls.find(c => c.url === `${API}/email-messages/em1` && c.method === 'POST')!;

    expect(save.body).toEqual({ subject: 'New subject', expectedRevisionId: 'rev7' });
    expect(res.changed).toEqual(['subject']);
    expect(res.contentRevisionId).toBe('rev8');
  });

  it('uses the revision the agent read, and refuses rather than overwrite a newer edit', async () => {
    const calls = route((c) => {
      if (c.url === `${API}/campaigns/camp1`) {
        return { body: draft() };
      }
      if (c.url === `${API}/email-messages/em1` && c.method === 'POST') {
        return { status: 409, body: { message: 'contentRevisionId is stale' } };
      }
      return undefined;
    });

    await expect(run('update_campaign', { campaignId: 'camp1', markdown: 'New body', expectedRevisionId: 'rev-old' }))
      .rejects
      .toThrow(/changed in Loops since it was read/);

    const save = calls.find(c => c.method === 'POST')!;

    expect(save.body.expectedRevisionId).toBe('rev-old');
    // No silent re-read-and-overwrite.
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(1);
    expect(calls.some(c => c.method === 'GET' && c.url === `${API}/email-messages/em1`)).toBe(false);
  });

  it('refuses a call that changes nothing', async () => {
    const calls = route(() => ({ body: {} }));

    await expect(run('update_campaign', { campaignId: 'camp1' })).rejects.toThrow(/Nothing to change/);
    expect(calls).toHaveLength(0);
  });
});

describe('loopsProvider.call — send_preview', () => {
  it('sends only to the configured recipients', async () => {
    const calls = route((c) => {
      if (c.url === `${API}/campaigns/camp1`) {
        return { body: draft() };
      }
      if (c.url.endsWith('/preview')) {
        return { body: { id: 'p1' } };
      }
      return undefined;
    });

    const res = JSON.parse(await run('send_preview', { campaignId: 'camp1', contactProperties: { firstName: 'Alex' } }));
    const preview = calls.find(c => c.url.endsWith('/preview'))!;

    expect(preview.body).toEqual({ emails: ['owner@client.com', 'second@client.com'], contactProperties: { firstName: 'Alex' } });
    expect(res.previewSent).toBe(true);
    expect(res.note).toMatch(/has not been sent to anyone/);
  });

  it('refuses an address that is not on the connection — before any request', async () => {
    const calls = route(() => ({ body: {} }));

    await expect(run('send_preview', { campaignId: 'camp1', to: ['customer@elsewhere.com'] })).rejects.toThrow(/Not sent to: customer@elsewhere.com/);
    expect(calls).toHaveLength(0);
  });
});

describe('loopsProvider.call — set_campaign_schedule', () => {
  const ready = (campaign: Record<string, unknown>, guardianBody: unknown = { errors: [], warnings: [] }): Route => (c) => {
    if (c.url === `${API}/campaigns/camp1` && c.method === 'GET') {
      return { body: campaign };
    }
    if (c.url === `${API}/email-messages/em1`) {
      return { body: { id: 'em1', subject: 'Hi', lmx: '<Paragraph>Hi</Paragraph>', contentRevisionId: 'r' } };
    }
    if (c.url.endsWith('/guardian')) {
      return { body: guardianBody };
    }
    if (c.url === `${API}/campaigns/camp1` && c.method === 'POST') {
      return { body: { ...campaign, scheduling: c.body.scheduling } };
    }
    return undefined;
  };
  const posted = (calls: Call[]) => calls.filter(c => c.method === 'POST');

  it('rejects a time in the past without calling Loops', async () => {
    const calls = route(() => ({ body: {} }));

    await expect(run('set_campaign_schedule', { campaignId: 'camp1', when: '2020-01-01T00:00:00Z' })).rejects.toThrow(/not in the future/);
    await expect(run('set_campaign_schedule', { campaignId: 'camp1', when: 'next tuesday-ish' })).rejects.toThrow(/not a time Loops understands/);
    expect(calls).toHaveLength(0);
  });

  it('refuses a campaign that is not a draft', async () => {
    const calls = route(ready(draft({ status: 'Sent' })));

    await expect(run('set_campaign_schedule', { campaignId: 'camp1', when: 'now' })).rejects.toThrow(/already Sent/);
    expect(posted(calls)).toHaveLength(0);
  });

  it('refuses when Loops\' own checks report an error', async () => {
    const calls = route(ready(draft(), { errors: [{ rule: 'missingFallbackContactProperties', title: 'Missing fallbacks', items: [{ label: 'firstName' }] }], warnings: [] }));

    await expect(run('set_campaign_schedule', { campaignId: 'camp1', when: 'now' })).rejects.toThrow(/Missing fallbacks \(firstName\)/);
    expect(posted(calls)).toHaveLength(0);
  });

  it('refuses to target the whole audience without an explicit confirmation', async () => {
    const calls = route(ready(draft({ mailingListId: null })));

    await expect(run('set_campaign_schedule', { campaignId: 'camp1', when: 'now' })).rejects.toThrow(/EVERY subscribed contact/);
    expect(posted(calls)).toHaveLength(0);
  });

  it('allows the whole audience once it is confirmed', async () => {
    const calls = route(ready(draft({ mailingListId: null })));

    await run('set_campaign_schedule', { campaignId: 'camp1', when: 'now', confirmAllContacts: true });

    expect(posted(calls)).toHaveLength(1);
    expect(posted(calls)[0]!.body).toEqual({ scheduling: { method: 'now' } });
  });

  it('says STILL A DRAFT — not "sent" — when Loops leaves the campaign a draft', async () => {
    route(ready(draft()));

    const res = JSON.parse(await run('set_campaign_schedule', { campaignId: 'camp1', when: 'now' }));

    expect(res.status).toBe('Draft');
    expect(res.nextStep).toMatch(/STILL A DRAFT/);
    expect(res.nextStep).toMatch(/press Send/);
    expect(res.nextStep).toMatch(/nothing has been sent or queued/);
    expect(res.sent).toBeUndefined();
  });

  it('sends a normalised future timestamp', async () => {
    const calls = route(ready(draft()));
    const future = new Date(Date.now() + 86_400_000).toISOString();

    await run('set_campaign_schedule', { campaignId: 'camp1', when: future });

    expect(posted(calls)[0]!.body).toEqual({ scheduling: { method: 'schedule', timestamp: future } });
  });
});

describe('loopsProvider.call — contacts, events, transactional', () => {
  it('will not silently re-subscribe someone who opted out', async () => {
    const calls = route(c => (c.url.includes('/contacts/find') ? { body: [{ id: 'c1', email: 'a@b.com', subscribed: false }] } : { body: { success: true, id: 'c1' } }));

    await expect(run('upsert_contact', { email: 'a@b.com', subscribed: true })).rejects.toThrow(/UNSUBSCRIBED/);
    expect(calls.some(c => c.method === 'PUT')).toBe(false);
  });

  it('re-subscribes only with the explicit confirmation', async () => {
    const calls = route(() => ({ body: { success: true, id: 'c1' } }));

    await run('upsert_contact', { email: 'a@b.com', subscribed: true, confirmResubscribe: true });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ email: 'a@b.com', subscribed: true });
  });

  it('leaves "subscribed" out unless the call is about subscription', async () => {
    const calls = route(() => ({ body: { success: true, id: 'c1' } }));

    await run('upsert_contact', { email: 'a@b.com', firstName: 'Ana', properties: { planName: 'pro' } });

    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.body).toEqual({ planName: 'pro', email: 'a@b.com', firstName: 'Ana' });
    expect('subscribed' in calls[0]!.body).toBe(false);
  });

  it('does not let a custom property overwrite a reserved field', async () => {
    const calls = route(() => ({ body: {} }));

    await expect(run('upsert_contact', { email: 'a@b.com', properties: { subscribed: true } })).rejects.toThrow(/not a custom property/);
    expect(calls).toHaveLength(0);
  });

  it('passes the idempotency key on an event', async () => {
    const calls = route(() => ({ body: { success: true } }));

    await run('send_event', { email: 'a@b.com', eventName: 'trial_started', eventProperties: { plan: 'pro' }, idempotencyKey: 'evt-1' });

    expect(calls[0]!.url).toBe(`${API}/events/send`);
    expect(calls[0]!.headers['Idempotency-Key']).toBe('evt-1');
    expect(calls[0]!.body).toEqual({ email: 'a@b.com', eventName: 'trial_started', eventProperties: { plan: 'pro' } });
  });

  it('sends transactional mail to exactly one address', async () => {
    const calls = route(() => ({ body: { success: true } }));

    await expect(run('send_transactional', { email: 'a@b.com, c@d.com', transactionalId: 't1' })).rejects.toThrow(/exactly one recipient/);
    expect(calls).toHaveLength(0);

    await run('send_transactional', { email: 'a@b.com', transactionalId: 't1', dataVariables: { resetLink: 'https://x.io/r' } });

    expect(calls[0]!.body).toEqual({ email: 'a@b.com', transactionalId: 't1', dataVariables: { resetLink: 'https://x.io/r' } });
  });

  it('reports a reused idempotency key as "not sent again", not as a failure to retry', async () => {
    route(() => ({ status: 409, body: { message: 'Idempotency key has been used.' } }));

    await expect(run('send_transactional', { email: 'a@b.com', transactionalId: 't1', idempotencyKey: 'k' })).rejects.toThrow(/NOT sent again/);
  });
});

describe('loopsProvider.call — reads', () => {
  it('filters campaigns by status client-side, since Loops cannot', async () => {
    route(() => ({
      body: {
        pagination: { nextCursor: null },
        data: [draft(), draft({ id: 'camp2', name: 'Old one', status: 'Sent' })],
      },
    }));

    const res = JSON.parse(await run('list_campaigns', { status: 'Draft' }));

    expect(res.count).toBe(1);
    expect(res.campaigns[0].campaignId).toBe('camp1');
  });

  it('adds rates to a sent campaign and keeps the body out when asked', async () => {
    route((c) => {
      if (c.url === `${API}/campaigns/camp1`) {
        return { body: draft({ status: 'Sent' }) };
      }
      if (c.url === `${API}/email-messages/em1`) {
        return { body: { subject: 'Hi', lmx: '<Paragraph>Hi</Paragraph>', contentRevisionId: 'r1' } };
      }
      if (c.url.endsWith('/metrics')) {
        return { body: { sends: 200, opens: 100, clicks: 20, unsubscribes: 2, spamReports: 0, hardBounces: 1, softBounces: 0 } };
      }
      return undefined;
    });

    const res = JSON.parse(await run('get_campaign', { campaignId: 'camp1', includeContent: false }));

    expect(res.metrics.openRate).toBe('50.0%');
    expect(res.metrics.clickRate).toBe('10.0%');
    expect(res.email.lmx).toBeUndefined();
    expect(res.email.contentRevisionId).toBe('r1');
  });

  it('walks a workflow from its trigger so the steps read in order', async () => {
    route(() => ({
      body: {
        id: 'w1',
        name: 'Onboarding',
        status: 'Sending',
        rootNodeId: 'a',
        nodes: {
          c: { typeName: 'SendEmailAction', nextNodeIds: [], emailMessageId: 'em9', subject: 'Welcome' },
          a: { typeName: 'EventTrigger', nextNodeIds: ['b'], eventName: 'signup' },
          b: { typeName: 'TimerAction', nextNodeIds: ['c'] },
        },
      },
    }));

    const res = JSON.parse(await run('get_workflow', { workflowId: 'w1' }));

    expect(res.steps.map((s: any) => s.nodeId)).toEqual(['a', 'b', 'c']);
    expect(res.statusMeaning).toMatch(/LIVE/);
    expect(res.steps[0].nextNodeIds).toBeUndefined();
  });
});

describe('loopsProvider.call — upload_image', () => {
  it('uploads the file and never sends the API key to the storage URL', async () => {
    const calls = route((c) => {
      if (c.url === `${API}/uploads`) {
        return { body: { emailAssetId: 'as1', presignedUrl: 'https://storage.example/put?sig=abc' } };
      }
      if (c.url.startsWith('https://storage.example/')) {
        return { status: 200 };
      }
      if (c.url === `${API}/uploads/as1/complete`) {
        return { body: { emailAssetId: 'as1', finalUrl: 'https://images.vialoops.com/t/as1.png' } };
      }
      return undefined;
    });

    const res = JSON.parse(await run('upload_image', { fileId: 'png' }));
    const create = calls.find(c => c.url === `${API}/uploads`)!;
    const put = calls.find(c => c.url.startsWith('https://storage.example/'))!;

    expect(create.body).toEqual({ contentType: 'image/png', contentLength: Buffer.from('fake-image-bytes').length });
    expect(put.method).toBe('PUT');
    expect(put.headers.Authorization).toBeUndefined();
    expect(JSON.stringify(put.headers)).not.toContain(KEY);
    expect(res.url).toBe('https://images.vialoops.com/t/as1.png');
  });

  it('refuses a file that is not an image, before asking Loops for anything', async () => {
    const calls = route(() => ({ body: {} }));

    await expect(run('upload_image', { fileId: 'pdf' })).rejects.toThrow(/JPEG, PNG, GIF or WebP/);
    expect(calls).toHaveLength(0);
  });

  it('refuses a file id that is not in this workspace', async () => {
    route(() => ({ body: {} }));

    await expect(run('upload_image', { fileId: 'someone-elses' })).rejects.toThrow(/No file someone-elses in this workspace/);
  });
});

describe('the tool surface', () => {
  it('has no tool that deletes contacts or edits live workflow emails', () => {
    const names = loopsProvider.tools.map(t => t.name);

    expect(names).not.toContain('delete_contact');
    expect(names.some(n => /delete|remove/.test(n))).toBe(false);

    // Email content is reachable only through a campaign id — never a raw
    // emailMessageId, which could belong to a workflow that is already live.
    for (const t of loopsProvider.tools) {
      expect(Object.keys((t.input_schema as any).properties ?? {})).not.toContain('emailMessageId');
    }
  });

  it('is a per-connection provider whose target is not a URL', () => {
    expect(loopsProvider.perConnection).toBe(true);
    expect(loopsProvider.targetIsUrl).toBe(false);
    expect(loopsProvider.usageMetering).toBeUndefined();
  });
});
