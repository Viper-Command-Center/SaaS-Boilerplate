/**
 * WHMCS adapter — the three decisions that are worth testing without a WHMCS
 * installation in front of you: was the credential understood, is this call
 * safe to make, and is an empty list real.
 *
 * None of this touches the network.
 */

import { describe, expect, it } from 'vitest';
import { guardAction, parseCredential, unwrap } from '@/libs/plugins/whmcs';

describe('parseCredential', () => {
  it('reads identifier and secret', () => {
    expect(parseCredential('abc123:sh4redsecret')).toEqual({
      identifier: 'abc123',
      secret: 'sh4redsecret',
      accessKey: undefined,
    });
  });

  it('reads the optional access key', () => {
    expect(parseCredential('abc123:sh4redsecret:myAccessKey').accessKey).toBe('myAccessKey');
  });

  /**
   * The access key is a passphrase a human invents, so it may contain colons —
   * which is precisely why it goes LAST. Splitting on every colon would
   * truncate it silently and surface as an authentication failure that looks
   * nothing like "your access key was cut in half".
   */
  it('lets the access key contain colons without corrupting the secret', () => {
    const c = parseCredential('abc123:sh4redsecret:a:b:c');

    expect(c.accessKey).toBe('a:b:c');
    expect(c.secret).toBe('sh4redsecret');
  });

  it('trims surrounding whitespace', () => {
    expect(parseCredential('  abc123 : sh4redsecret  ')).toMatchObject({
      identifier: 'abc123',
      secret: 'sh4redsecret',
    });
  });

  // A trailing colon must not send accesskey='' — WHMCS would reject a request
  // that looks perfectly correct to whoever pasted it.
  it('treats a trailing colon as no access key', () => {
    expect(parseCredential('a:b:').accessKey).toBeUndefined();
  });

  it.each([
    ['justtheidentifier', /identifier:secret/],
    ['', /identifier:secret/],
    [':secret', /identifier:secret/],
    ['abc123:', /missing the identifier or the secret/],
  ])('rejects %j', (input, message) => {
    expect(() => parseCredential(input)).toThrow(message);
  });
});

describe('unwrap', () => {
  it('reads the doubly-nested list WHMCS actually returns', () => {
    expect(unwrap({ clients: { client: [{ id: 1 }, { id: 2 }] } }, 'clients', 'client')).toHaveLength(2);
  });

  // Some builds collapse a single row to a bare object. Read naively that has
  // no .length, and reports as nothing found.
  it('handles a single row returned as a bare object', () => {
    expect(unwrap({ clients: { client: { id: 7 } } }, 'clients', 'client')).toHaveLength(1);
  });

  it('handles an array directly under the plural key', () => {
    expect(unwrap({ domains: [{ id: 3 }] }, 'domains', 'domain')).toHaveLength(1);
  });

  it.each([
    ['missing key', { result: 'success' }],
    ['empty string container', { clients: '' }],
    ['empty object container', { clients: {} }],
    ['null body', null],
    ['undefined body', undefined],
  ])('returns an empty array for %s rather than throwing', (_label, body) => {
    expect(unwrap(body, 'clients', 'client')).toEqual([]);
  });

  /**
   * 🔴 The regression this function exists to prevent. Reading one level too
   * shallow does not throw — it yields undefined, which renders downstream as
   * "this customer has no invoices". A confident, wrong statement about
   * somebody's billing is worse than an error, because nobody goes looking.
   */
  it('finds invoices where the naive read finds none', () => {
    const body = { invoices: { invoice: [{ id: 11 }, { id: 12 }, { id: 13 }] } };

    expect(Array.isArray(body.invoices)).toBe(false); // the naive read
    expect(unwrap(body, 'invoices', 'invoice')).toHaveLength(3);
  });
});

describe('guardAction', () => {
  it.each(['GetClients', 'AddClient', 'CreateInvoice', 'UpdateClientProduct'])(
    'allows %s',
    (action) => {
      expect(() => guardAction(action, false)).not.toThrow();
    },
  );

  it.each(['DeleteClient', 'TerminateModule', 'SuspendModule', 'CancelOrder', 'CloseClient'])(
    'blocks %s by default',
    (action) => {
      expect(() => guardAction(action, false)).toThrow(/blocked by default/);
    },
  );

  it('matches the action name case-insensitively', () => {
    expect(() => guardAction('deleteclient', false)).toThrow(/blocked by default/);
  });

  it('lets a confirmed destructive action through', () => {
    expect(() => guardAction('DeleteClient', true)).not.toThrow();
  });

  /**
   * DecryptPassword returns a customer's stored password in plaintext, into a
   * transcript and a tool log that both persist. No agent task needs one, so
   * the confirmation flag must NOT open it — a flag the caller can set is not
   * a control, and treating it as one would be the dangerous kind of theatre.
   */
  it('blocks DecryptPassword even when confirmed', () => {
    expect(() => guardAction('DecryptPassword', false)).toThrow(/cannot be enabled/);
    expect(() => guardAction('DecryptPassword', true)).toThrow(/cannot be enabled/);
  });

  it('rejects an empty action', () => {
    expect(() => guardAction('   ', false)).toThrow(/no action was given/);
  });

  /**
   * classifyToolError() treats an unrecognised message as an Artivio bug and
   * emails the operator. "rejected the request" is what keeps a bad argument
   * from being reported to Ryan as a platform defect — three of those in one
   * afternoon is what the phrasing is worth.
   */
  it('phrases its refusal so classifyToolError sees a client-fixable fault', () => {
    expect(() => guardAction('', false)).toThrow(/rejected the request/);
  });
});
