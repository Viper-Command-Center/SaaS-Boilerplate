/**
 * WHMCS — built-in provider (per-installation, bring-your-own credential).
 *
 * WHMCS publishes no MCP server, and its API is not REST: every call is a
 * form-encoded POST to `includes/api.php` carrying an `action` name, and the
 * response comes back 200 OK whether it worked or not. So this is an adapter,
 * not an HTTP connection.
 *
 * Per-connection config (stored on the mcp_connection, not the catalog):
 *   url        = the WHMCS installation root, e.g. https://billing.example.com
 *   credential = "identifier:secret" or "identifier:secret:accesskey"
 *
 * 🔴 TWO THINGS ABOUT WHMCS THAT COST A DEBUGGING SESSION IF YOU DO NOT KNOW
 *    THEM, and which shape most of the code below:
 *
 * 1. THE API IS IP-RESTRICTED BY DEFAULT. WHMCS answers a call from an
 *    unlisted address with an error, not a 403 — and Railway's outbound
 *    address is not stable, so an allowlist cannot hold. The supported way out
 *    is `$api_access_key` in the installation's configuration.php, sent as the
 *    `accesskey` parameter. That is why the credential has an optional third
 *    field.
 *
 * 2. EVERY RESPONSE IS HTTP 200. Authentication failure, unknown action,
 *    missing parameter, IP rejection — all 200, distinguished only by
 *    `result: "error"` in the body. Nothing downstream can infer anything from
 *    the transport status, so `call()` inspects the body and throws.
 */

import type { BuiltinProvider } from '@/libs/plugins/types';

/** Cap on what we hand back to the model. WHMCS list calls can be enormous. */
const MAX_OUTPUT = 120_000;

/** Never more than this per list call, whatever the caller asks for. */
const MAX_ROWS = 100;

type Credential = {
  identifier: string;
  secret: string;
  accessKey?: string;
};

/**
 * Split "identifier:secret" or "identifier:secret:accesskey".
 *
 * Splits on the FIRST two colons only, so the access key may itself contain
 * colons — it is a passphrase the admin chooses, unlike the identifier and
 * secret, which WHMCS generates as alphanumeric strings. Ordering the fields
 * this way is the whole reason the free-form value goes last.
 */
export function parseCredential(raw: string): Credential {
  const value = (raw ?? '').trim();
  const first = value.indexOf(':');
  if (first < 1) {
    throw new Error(
      'WHMCS: the credential must be "identifier:secret" (or "identifier:secret:accesskey"). '
      + 'Generate the pair in WHMCS → Configuration → System Settings → API Credentials; '
      + 'the admin role attached to it needs the "API Access" permission.',
    );
  }
  const identifier = value.slice(0, first).trim();
  const rest = value.slice(first + 1);
  const second = rest.indexOf(':');

  const secret = (second < 0 ? rest : rest.slice(0, second)).trim();
  const accessKey = second < 0 ? undefined : rest.slice(second + 1).trim() || undefined;

  if (!identifier || !secret) {
    throw new Error('WHMCS: the credential is missing the identifier or the secret.');
  }
  return { identifier, secret, accessKey };
}

/**
 * WHMCS wraps list results one level deeper than you expect:
 *   GetClients  → { clients:  { client:  [ … ] } }
 *   GetInvoices → { invoices: { invoice: [ … ] } }
 *
 * ...and it is not consistent about the empty and single-row cases: an empty
 * result can be `{}`, `""` or the key missing entirely, and some builds return
 * a bare object rather than a one-element array.
 *
 * 🔴 Reading the wrong depth here does NOT throw. It returns undefined, which
 * renders as "this client has no invoices" — a confident, wrong answer about
 * someone's billing. That exact failure mode (a shape mismatch that produces
 * plausible empty data instead of an error) is what made DataForSEO report
 * real keywords with null search volume beside them.
 */
export function unwrap(body: unknown, plural: string, singular: string): unknown[] {
  const outer = (body as Record<string, unknown> | null)?.[plural];
  if (outer == null || outer === '') {
    return [];
  }
  const inner = (outer as Record<string, unknown>)?.[singular];
  if (Array.isArray(inner)) {
    return inner;
  }
  if (inner && typeof inner === 'object') {
    return [inner];
  }
  // Some actions return the array directly under the plural key.
  if (Array.isArray(outer)) {
    return outer;
  }
  return [];
}

/**
 * Actions that destroy or irreversibly change a customer's account.
 *
 * Blocked in `whmcs_call` unless the caller passes `confirm_destructive: true`.
 * That flag is NOT a security control — an agent can set it — and pretending
 * otherwise would be worse than not having it. What it buys is that the
 * destruction becomes an explicit, visible argument in the approval request a
 * human sees, instead of hiding inside an action name in a long parameter blob.
 */
const DESTRUCTIVE_PREFIXES = ['delete', 'terminate', 'suspend', 'cancel', 'close'];

/**
 * Blocked outright, with no override.
 *
 * `DecryptPassword` returns a customer's stored password in plaintext. There is
 * no agent task that needs one, and the result would be written into a chat
 * transcript and a tool-call log that both persist. A capability nobody should
 * use is not worth a confirmation flag.
 */
const FORBIDDEN_ACTIONS = new Set(['decryptpassword']);

export function guardAction(action: string, confirmed: boolean): void {
  const name = action.trim().toLowerCase();
  if (!name) {
    throw new Error('WHMCS rejected the request: no action was given.');
  }
  if (FORBIDDEN_ACTIONS.has(name)) {
    throw new Error(
      `WHMCS: the "${action}" action is blocked by Artivio and cannot be enabled. `
      + 'It returns a stored customer password in plaintext, which would then live in the '
      + 'conversation transcript and the tool log. Reset the password instead.',
    );
  }
  if (!confirmed && DESTRUCTIVE_PREFIXES.some(p => name.startsWith(p))) {
    throw new Error(
      `WHMCS: "${action}" permanently changes or removes a customer record, so it is blocked by default. `
      + 'If this is genuinely intended, call it again with confirm_destructive: true — and say in your '
      + 'message to the human what will be destroyed, because they are approving the consequence, not the '
      + 'action name.',
    );
  }
}

/** One API call. Throws with a message classifyToolError() can read. */
async function api(
  baseUrl: string | undefined,
  credential: string,
  action: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  if (!baseUrl) {
    throw new Error('WHMCS: this connection has no WHMCS URL set. Add it in the Tools panel.');
  }
  const { identifier, secret, accessKey } = parseCredential(credential);

  const base = baseUrl.replace(/\/+$/, '');
  // Accept either the installation root or a URL already pointing at api.php,
  // because both are things a person reasonably pastes.
  const endpoint = /\/api\.php$/i.test(base) ? base : `${base}/includes/api.php`;

  const form = new URLSearchParams();
  form.set('identifier', identifier);
  form.set('secret', secret);
  if (accessKey) {
    form.set('accesskey', accessKey);
  }
  form.set('action', action);
  form.set('responsetype', 'json');
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    form.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }

  let resp: Response;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
  } catch (e) {
    throw new Error(`WHMCS: could not reach ${endpoint} — ${e instanceof Error ? e.message : String(e)}`);
  }

  const text = await resp.text();

  if (!resp.ok) {
    throw new Error(`WHMCS: HTTP ${resp.status} from ${endpoint}${text ? ` — ${text.slice(0, 300)}` : ''}`);
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /**
     * HTML back from api.php almost always means the URL points at the WHMCS
     * front end rather than the installation root — the client area happily
     * returns 200 and a login page, so without this check the failure surfaces
     * as an unparseable blob rather than "your URL is one directory off".
     */
    const looksLikeHtml = /^\s*<(?:!doctype|html)/i.test(text);
    throw new Error(
      `WHMCS: ${endpoint} did not return JSON${looksLikeHtml ? ' — it returned an HTML page' : ''}. `
      + 'The connection URL should be the WHMCS installation root (the folder containing includes/api.php), '
      + `e.g. https://example.com/whmcs or https://billing.example.com. Received: ${text.slice(0, 200)}`,
    );
  }

  /**
   * 🔴 200 OK IS NOT SUCCESS. WHMCS signals every failure in the body.
   *
   * The phrasing "rejected the request" is deliberate: classifyToolError()
   * reads these strings, and an unrecognised message is treated as an Artivio
   * bug and emailed to the operator. A wrong client id is not an Artivio bug,
   * and three false escalations in one afternoon is what that costs.
   */
  const result = String(body.result ?? '').toLowerCase();
  if (result && result !== 'success') {
    const message = String(body.message ?? '(no message)');
    let hint = '';

    if (/invalid ip|ip not allowed|access denied/i.test(message)) {
      hint = ' — WHMCS restricts API access by IP address, and this call came from a cloud host whose '
        + 'outbound address changes. Add $api_access_key to the installation\'s configuration.php and append '
        + 'it to the credential as "identifier:secret:accesskey". An IP allowlist cannot work here.';
    } else if (/authentication|invalid.*credential|invalid identifier|invalid secret/i.test(message)) {
      hint = ' — check the API credential pair, and that the admin role it belongs to has the '
        + '"API Access" permission ticked.';
    } else if (/permission|not permitted|unauthori/i.test(message)) {
      hint = ` — the admin role behind this credential is not allowed to run "${action}". `
        + 'Grant it in WHMCS → Configuration → Administrator Roles.';
    } else if (/invalid action|action not found/i.test(message)) {
      hint = ` — "${action}" is not an action this WHMCS version exposes. `
        + 'Check the exact spelling and casing at developers.whmcs.com/api-reference.';
    }

    throw new Error(`WHMCS rejected the request (${action}): ${message}${hint}`);
  }

  return body;
}

/** Trim a result to something worth spending context on. */
function cap(value: unknown): string {
  const json = JSON.stringify(value);
  if (json.length <= MAX_OUTPUT) {
    return json;
  }
  return `${json.slice(0, MAX_OUTPUT)}\n…truncated. Narrow the query — use a search term, a status filter, or a smaller limit.`;
}

function rows(args: Record<string, unknown>): number {
  const asked = Number(args.limit ?? args.limitnum ?? 25);
  return Math.min(Number.isFinite(asked) && asked > 0 ? asked : 25, MAX_ROWS);
}

/** Keep the fields a person actually asks about; drop WHMCS's long tail. */
function slimClient(c: any) {
  return {
    id: c?.id ?? c?.userid ?? c?.client_id,
    company: c?.companyname || null,
    name: [c?.firstname, c?.lastname].filter(Boolean).join(' ') || null,
    email: c?.email ?? null,
    status: c?.status ?? null,
    country: c?.country ?? null,
    credit: c?.credit ?? null,
    datecreated: c?.datecreated ?? null,
  };
}

export const whmcsProvider: BuiltinProvider = {
  slug: 'whmcs',
  name: 'WHMCS',
  description:
    'Run the hosting/billing business in WHMCS — clients, invoices and payments, orders, services, domains and support tickets. Any other WHMCS API action is reachable through whmcs_call.',
  credentialLabel:
    'WHMCS API credentials as "identifier:secret" — or "identifier:secret:accesskey" if you have set $api_access_key in configuration.php (required from a cloud host, see the hint)',
  perConnection: true,
  targetLabel: 'WHMCS installation URL',
  targetPlaceholder: 'https://billing.example.com',

  guidance: `WHMCS connection:
- WHMCS answers HTTP 200 to everything, including failures. A result is only real if the tool returned without error; never infer success from "the call went through".
- List results are nested one level deeper than they look ({ clients: { client: [...] } }). The tools here already unwrap that — but if you use whmcs_call, read the raw shape rather than assuming a top-level array, because reading the wrong depth yields an empty list rather than an error, and an empty list reads as "this customer has no invoices".
- Ids are not interchangeable. A client id, a service id (from client_services), an invoice id and an order id are four different numbering systems. Passing the wrong one usually returns a valid-looking "not found", not a type error.
- whmcs_call reaches any action in the WHMCS API reference (developers.whmcs.com/api-reference); action names are case-sensitive, e.g. "GetClientsDetails". Actions beginning Delete/Terminate/Suspend/Cancel/Close are blocked unless confirm_destructive is set — and if you set it, state plainly in your message what will be destroyed, because that is what the human is approving.
- Money moves for real. add_invoice_payment records a payment against a customer's invoice and changes what they owe; it does not charge a card, and it cannot be undone from here. Only run it when someone has asked for that specific payment to be recorded.
- Before reporting revenue, prefer get_stats over adding up invoices yourself — invoice totals include cancelled and refunded rows, so a hand-summed figure reads high and gets quoted to a client.`,

  tools: [
    // ── Clients ────────────────────────────────────────────────────────────
    {
      name: 'list_clients',
      description: 'List clients, newest first. Optional search matches name, email or company.',
      input_schema: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          status: { type: 'string', description: 'Active | Inactive | Closed' },
          limit: { type: 'number', description: 'Max 100 (default 25)' },
          offset: { type: 'number' },
        },
      },
    },
    {
      name: 'get_client',
      description: 'Full detail for one client — contact, balance, currency and account status. Give client_id or email.',
      input_schema: {
        type: 'object',
        properties: {
          client_id: { type: 'number' },
          email: { type: 'string' },
          include_stats: { type: 'boolean', description: 'Also return lifetime totals (default true)' },
        },
      },
    },
    {
      name: 'create_client',
      description: 'Create a client account. Sends no welcome email unless noemail is false.',
      input_schema: {
        type: 'object',
        properties: {
          firstname: { type: 'string' },
          lastname: { type: 'string' },
          email: { type: 'string' },
          companyname: { type: 'string' },
          address1: { type: 'string' },
          city: { type: 'string' },
          state: { type: 'string' },
          postcode: { type: 'string' },
          country: { type: 'string', description: 'Two-letter ISO code, e.g. CA' },
          phonenumber: { type: 'string' },
          password2: { type: 'string', description: 'Their portal password. Omit to have WHMCS generate one.' },
          noemail: { type: 'boolean', description: 'true (default) = do not send the welcome email' },
        },
        required: ['firstname', 'lastname', 'email'],
      },
    },
    {
      name: 'update_client',
      description: 'Change fields on an existing client. Only the fields you pass are touched.',
      input_schema: {
        type: 'object',
        properties: {
          client_id: { type: 'number' },
          firstname: { type: 'string' },
          lastname: { type: 'string' },
          email: { type: 'string' },
          companyname: { type: 'string' },
          address1: { type: 'string' },
          city: { type: 'string' },
          state: { type: 'string' },
          postcode: { type: 'string' },
          country: { type: 'string' },
          phonenumber: { type: 'string' },
          status: { type: 'string', description: 'Active | Inactive | Closed' },
          notes: { type: 'string' },
        },
        required: ['client_id'],
      },
    },
    {
      name: 'client_services',
      description: 'Products/services a client owns, with status, billing cycle, next due date and price. The "id" here is a SERVICE id — not the client id and not the product id.',
      input_schema: {
        type: 'object',
        properties: {
          client_id: { type: 'number' },
          service_id: { type: 'number', description: 'Fetch one specific service' },
          limit: { type: 'number' },
        },
      },
    },
    {
      name: 'update_service',
      description: 'Change a client service — status, next due date, recurring amount, billing cycle. Use the service id from client_services.',
      input_schema: {
        type: 'object',
        properties: {
          service_id: { type: 'number' },
          status: { type: 'string', description: 'Pending | Active | Suspended | Terminated | Cancelled' },
          nextduedate: { type: 'string', description: 'YYYY-MM-DD' },
          recurringamount: { type: 'number' },
          billingcycle: { type: 'string', description: 'Monthly | Quarterly | Annually …' },
          domain: { type: 'string' },
          notes: { type: 'string' },
        },
        required: ['service_id'],
      },
    },

    // ── Billing ────────────────────────────────────────────────────────────
    {
      name: 'list_invoices',
      description: 'List invoices, newest first. Filter by client and/or status to find what is actually owed.',
      input_schema: {
        type: 'object',
        properties: {
          client_id: { type: 'number' },
          status: { type: 'string', description: 'Draft | Unpaid | Paid | Overdue | Cancelled | Refunded | Collections' },
          limit: { type: 'number' },
          offset: { type: 'number' },
        },
      },
    },
    {
      name: 'get_invoice',
      description: 'One invoice in full, including its line items and any payments recorded against it.',
      input_schema: {
        type: 'object',
        properties: { invoice_id: { type: 'number' } },
        required: ['invoice_id'],
      },
    },
    {
      name: 'create_invoice',
      description: 'Raise an invoice for a client. Line items are passed as an array of {description, amount, taxed}. Defaults to Unpaid and does NOT email the client unless sendinvoice is true.',
      input_schema: {
        type: 'object',
        properties: {
          client_id: { type: 'number' },
          duedate: { type: 'string', description: 'YYYY-MM-DD' },
          items: {
            type: 'array',
            description: 'Line items: [{ description, amount, taxed }]',
            items: {
              type: 'object',
              properties: {
                description: { type: 'string' },
                amount: { type: 'number' },
                taxed: { type: 'boolean' },
              },
            },
          },
          paymentmethod: { type: 'string' },
          notes: { type: 'string' },
          sendinvoice: { type: 'boolean', description: 'true = email it to the client (default false)' },
        },
        required: ['client_id', 'items'],
      },
    },
    {
      name: 'add_invoice_payment',
      description: 'Record a payment against an invoice. This changes what a customer owes and cannot be reversed from here — it does not charge a card, it records money already received. Only use it when someone asked for this specific payment to be recorded.',
      input_schema: {
        type: 'object',
        properties: {
          invoice_id: { type: 'number' },
          amount: { type: 'number', description: 'Omit to mark the full balance paid' },
          transaction_id: { type: 'string', description: 'Reference from the payment processor' },
          fees: { type: 'number' },
          date: { type: 'string', description: 'YYYY-MM-DD HH:MM:SS' },
          gateway: { type: 'string' },
        },
        required: ['invoice_id', 'transaction_id'],
      },
    },
    {
      name: 'list_transactions',
      description: 'Payment transactions — what actually came in, by client, invoice or date range.',
      input_schema: {
        type: 'object',
        properties: {
          client_id: { type: 'number' },
          invoice_id: { type: 'number' },
          transaction_id: { type: 'string' },
          limit: { type: 'number' },
        },
      },
    },

    // ── Orders ─────────────────────────────────────────────────────────────
    {
      name: 'list_orders',
      description: 'Orders, newest first. Status "Pending" is the queue of things waiting to be provisioned.',
      input_schema: {
        type: 'object',
        properties: {
          client_id: { type: 'number' },
          status: { type: 'string', description: 'Pending | Active | Fraud | Cancelled' },
          limit: { type: 'number' },
          offset: { type: 'number' },
        },
      },
    },
    {
      name: 'accept_order',
      description: 'Accept a pending order, which provisions the service. By default this does NOT run the module create or send the welcome email — set them explicitly if that is what you want.',
      input_schema: {
        type: 'object',
        properties: {
          order_id: { type: 'number' },
          autosetup: { type: 'boolean', description: 'Run the provisioning module (default false)' },
          sendemail: { type: 'boolean', description: 'Send the product welcome email (default false)' },
        },
        required: ['order_id'],
      },
    },

    // ── Catalogue ──────────────────────────────────────────────────────────
    {
      name: 'list_products',
      description: 'The product/service catalogue — what can be sold, with pricing by billing cycle.',
      input_schema: {
        type: 'object',
        properties: {
          group_id: { type: 'number' },
          module: { type: 'string' },
        },
      },
    },

    // ── Domains ────────────────────────────────────────────────────────────
    {
      name: 'list_domains',
      description: 'Domains under management, with registrar, expiry and auto-renew state. Omit client_id for every domain on the installation.',
      input_schema: {
        type: 'object',
        properties: {
          client_id: { type: 'number' },
          domain_id: { type: 'number' },
          limit: { type: 'number' },
        },
      },
    },

    // ── Support ────────────────────────────────────────────────────────────
    {
      name: 'list_tickets',
      description: 'Support tickets, newest first. Filter by status to find what is waiting on a reply.',
      input_schema: {
        type: 'object',
        properties: {
          client_id: { type: 'number' },
          status: { type: 'string', description: 'Open | Answered | Customer-Reply | Closed | "Awaiting Reply"' },
          department_id: { type: 'number' },
          limit: { type: 'number' },
        },
      },
    },
    {
      name: 'get_ticket',
      description: 'One ticket with its full reply thread.',
      input_schema: {
        type: 'object',
        properties: { ticket_id: { type: 'number' } },
        required: ['ticket_id'],
      },
    },
    {
      name: 'reply_ticket',
      description: 'Post a reply on a ticket. The customer is emailed unless noemail is true — treat this as sending a message to a real customer, not a draft.',
      input_schema: {
        type: 'object',
        properties: {
          ticket_id: { type: 'number' },
          message: { type: 'string' },
          status: { type: 'string', description: 'Status to set after replying, e.g. Answered' },
          noemail: { type: 'boolean' },
          markdown: { type: 'boolean' },
        },
        required: ['ticket_id', 'message'],
      },
    },
    {
      name: 'open_ticket',
      description: 'Open a new ticket on a client\'s behalf, e.g. to notify them of scheduled work.',
      input_schema: {
        type: 'object',
        properties: {
          client_id: { type: 'number' },
          department_id: { type: 'number' },
          subject: { type: 'string' },
          message: { type: 'string' },
          priority: { type: 'string', description: 'Low | Medium | High' },
        },
        required: ['department_id', 'subject', 'message'],
      },
    },

    // ── Reporting ──────────────────────────────────────────────────────────
    {
      name: 'get_stats',
      description: 'The admin dashboard figures — income today/this month/this year, order and ticket counts. Use this for revenue rather than summing invoices, which double-counts cancelled and refunded rows.',
      input_schema: { type: 'object', properties: {} },
    },

    // ── Escape hatch ───────────────────────────────────────────────────────
    {
      name: 'whmcs_call',
      description:
        'Call any WHMCS API action directly, for anything the tools above do not cover. Action names are case-sensitive and listed at developers.whmcs.com/api-reference (e.g. "GetActivityLog", "AddOrder", "ModuleCreate"). Returns the raw response — read its actual shape rather than assuming a top-level array.',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'Exact WHMCS action name, e.g. GetClientsDetails' },
          params: { type: 'object', description: 'Parameters for that action, as documented by WHMCS' },
          confirm_destructive: {
            type: 'boolean',
            description: 'Required for actions beginning Delete/Terminate/Suspend/Cancel/Close. Setting it means a human has been told exactly what will be destroyed.',
          },
        },
        required: ['action'],
      },
    },
  ],

  call: async (tool, args, credential, baseUrl) => {
    const run = (action: string, params: Record<string, unknown> = {}) =>
      api(baseUrl, credential, action, params);

    switch (tool) {
      // ── Clients ──
      case 'list_clients': {
        const body = await run('GetClients', {
          limitstart: Number(args.offset) || 0,
          limitnum: rows(args),
          search: args.search,
          status: args.status,
        });
        return cap({
          total: body.totalresults ?? null,
          clients: unwrap(body, 'clients', 'client').map(slimClient),
        });
      }

      case 'get_client': {
        if (!args.client_id && !args.email) {
          throw new Error('WHMCS rejected the request: get_client needs client_id or email.');
        }
        return cap(await run('GetClientsDetails', {
          clientid: args.client_id,
          email: args.email,
          stats: args.include_stats === false ? false : true,
        }));
      }

      case 'create_client': {
        return cap(await run('AddClient', {
          firstname: args.firstname,
          lastname: args.lastname,
          email: args.email,
          companyname: args.companyname,
          address1: args.address1,
          city: args.city,
          state: args.state,
          postcode: args.postcode,
          country: args.country,
          phonenumber: args.phonenumber,
          password2: args.password2,
          // Default to NOT emailing: a welcome mail to a real customer is a
          // side effect nobody asked for when the agent is only creating a
          // record, and it cannot be unsent.
          noemail: args.noemail === false ? false : true,
          skipvalidation: true,
        }));
      }

      case 'update_client': {
        const { client_id: clientId, ...fields } = args;
        return cap(await run('UpdateClient', { clientid: clientId, ...fields }));
      }

      case 'client_services': {
        const body = await run('GetClientsProducts', {
          clientid: args.client_id,
          serviceid: args.service_id,
          limitnum: rows(args),
        });
        return cap({
          total: body.totalresults ?? null,
          services: unwrap(body, 'products', 'product'),
        });
      }

      case 'update_service': {
        const { service_id: serviceId, ...fields } = args;
        return cap(await run('UpdateClientProduct', { serviceid: serviceId, ...fields }));
      }

      // ── Billing ──
      case 'list_invoices': {
        const body = await run('GetInvoices', {
          userid: args.client_id,
          status: args.status,
          limitstart: Number(args.offset) || 0,
          limitnum: rows(args),
        });
        return cap({
          total: body.totalresults ?? null,
          invoices: unwrap(body, 'invoices', 'invoice'),
        });
      }

      case 'get_invoice':
        return cap(await run('GetInvoice', { invoiceid: args.invoice_id }));

      case 'create_invoice': {
        /**
         * WHMCS numbers invoice line items rather than taking an array:
         * itemdescription1, itemamount1, itemtaxed1, itemdescription2 …
         * An array passed straight through is silently dropped and you get an
         * invoice with no lines and a zero total, which looks like it worked.
         */
        const items = Array.isArray(args.items) ? args.items : [];
        if (items.length === 0) {
          throw new Error('WHMCS rejected the request: create_invoice needs at least one line item in "items".');
        }
        const lines: Record<string, unknown> = {};
        items.forEach((raw, i) => {
          const item = raw as Record<string, unknown>;
          const n = i + 1;
          lines[`itemdescription${n}`] = item.description ?? '';
          lines[`itemamount${n}`] = item.amount ?? 0;
          lines[`itemtaxed${n}`] = item.taxed ? 1 : 0;
        });
        return cap(await run('CreateInvoice', {
          userid: args.client_id,
          duedate: args.duedate,
          paymentmethod: args.paymentmethod,
          notes: args.notes,
          sendinvoice: args.sendinvoice ? 1 : 0,
          ...lines,
        }));
      }

      case 'add_invoice_payment':
        return cap(await run('AddInvoicePayment', {
          invoiceid: args.invoice_id,
          transid: args.transaction_id,
          amount: args.amount,
          fees: args.fees,
          gateway: args.gateway,
          date: args.date,
        }));

      case 'list_transactions': {
        const body = await run('GetTransactions', {
          clientid: args.client_id,
          invoiceid: args.invoice_id,
          transid: args.transaction_id,
          limitnum: rows(args),
        });
        return cap({
          total: body.totalresults ?? null,
          transactions: unwrap(body, 'transactions', 'transaction'),
        });
      }

      // ── Orders ──
      case 'list_orders': {
        const body = await run('GetOrders', {
          userid: args.client_id,
          status: args.status,
          limitstart: Number(args.offset) || 0,
          limitnum: rows(args),
        });
        return cap({
          total: body.totalresults ?? null,
          orders: unwrap(body, 'orders', 'order'),
        });
      }

      case 'accept_order':
        return cap(await run('AcceptOrder', {
          orderid: args.order_id,
          autosetup: args.autosetup ? true : false,
          sendemail: args.sendemail ? true : false,
        }));

      // ── Catalogue ──
      case 'list_products': {
        const body = await run('GetProducts', { gid: args.group_id, module: args.module });
        return cap({ products: unwrap(body, 'products', 'product') });
      }

      // ── Domains ──
      case 'list_domains': {
        const body = await run('GetClientsDomains', {
          clientid: args.client_id,
          domainid: args.domain_id,
          limitnum: rows(args),
        });
        return cap({
          total: body.totalresults ?? null,
          domains: unwrap(body, 'domains', 'domain'),
        });
      }

      // ── Support ──
      case 'list_tickets': {
        const body = await run('GetTickets', {
          clientid: args.client_id,
          status: args.status,
          deptid: args.department_id,
          limitnum: rows(args),
        });
        return cap({
          total: body.totalresults ?? null,
          tickets: unwrap(body, 'tickets', 'ticket'),
        });
      }

      case 'get_ticket':
        return cap(await run('GetTicket', { ticketid: args.ticket_id }));

      case 'reply_ticket':
        return cap(await run('AddTicketReply', {
          ticketid: args.ticket_id,
          message: args.message,
          status: args.status,
          noemail: args.noemail ? true : false,
          markdown: args.markdown ? true : false,
        }));

      case 'open_ticket':
        return cap(await run('OpenTicket', {
          clientid: args.client_id,
          deptid: args.department_id,
          subject: args.subject,
          message: args.message,
          priority: args.priority ?? 'Medium',
        }));

      // ── Reporting ──
      case 'get_stats':
        return cap(await run('GetStats'));

      // ── Escape hatch ──
      case 'whmcs_call': {
        const action = String(args.action ?? '');
        guardAction(action, args.confirm_destructive === true);
        const params = (args.params && typeof args.params === 'object')
          ? args.params as Record<string, unknown>
          : {};
        return cap(await run(action, params));
      }

      default:
        throw new Error(`Unknown WHMCS tool: ${tool}`);
    }
  },
};
