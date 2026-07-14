/**
 * Amazon Bedrock AgentCore Browser — a real Chrome, in AWS, driven over CDP.
 *
 * This is what lets the agent operate web apps that have no API (Duda's editor,
 * a client's Stripe dashboard) — including in unattended 3am missions, which a
 * browser on someone's laptop cannot do.
 *
 * Flow (per the AWS data-plane API):
 *   1. PUT  /browsers/{browserId}/sessions/start   → sessionId + automationStream
 *   2. connect to streams.automationStream.streamEndpoint (wss://) — the upgrade
 *      request must carry SigV4 HEADERS, which is why we need `ws` (Node's
 *      native WebSocket cannot send custom headers).
 *   3. speak CDP over that socket (Target.attachToTarget → Page.navigate → …)
 *   4. PUT  /browsers/{browserId}/sessions/stop
 *
 * Cost is per session-second, so every session is stopped in a `finally`.
 */

import { Buffer } from 'node:buffer';
import WebSocket from 'ws';
import { awsCreds, awsRegion, signRequest } from '@/libs/aws/sigv4';

const SERVICE = 'bedrock-agentcore';

/** Falls back to AWS's managed system browser if no custom one is configured. */
export function browserId(): string {
  return process.env.AGENTCORE_BROWSER_ID || 'aws.browser.v1';
}

export function browserConfigured(): boolean {
  return awsCreds() !== null;
}

type StartedSession = {
  sessionId: string;
  wsEndpoint: string;
  liveViewUrl?: string;
};

async function dataPlane(path: string, method: 'PUT' | 'GET' | 'POST', body?: unknown) {
  const creds = awsCreds();
  if (!creds) {
    throw new Error('AWS credentials are not configured (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY).');
  }
  const region = awsRegion();
  const url = `https://${SERVICE}.${region}.amazonaws.com${path}`;
  const payload = body === undefined ? '' : JSON.stringify(body);

  const headers = signRequest({
    method,
    url,
    service: SERVICE,
    region,
    body: payload,
    creds,
    extraHeaders: { 'content-type': 'application/json' },
  });

  const resp = await fetch(url, {
    method,
    headers,
    ...(payload ? { body: payload } : {}),
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`AgentCore ${resp.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : {};
}

export async function startSession(timeoutSeconds = 300): Promise<StartedSession> {
  const id = browserId();
  const data = await dataPlane(
    `/browsers/${encodeURIComponent(id)}/sessions/start`,
    'PUT',
    {
      name: `artivio-${Date.now()}`,
      sessionTimeoutSeconds: timeoutSeconds,
      viewPort: { width: 1456, height: 819 },
    },
  ) as {
    sessionId: string;
    streams?: {
      automationStream?: { streamEndpoint?: string };
      liveViewStream?: { streamEndpoint?: string };
    };
  };

  const wsEndpoint = data.streams?.automationStream?.streamEndpoint;
  if (!data.sessionId || !wsEndpoint) {
    throw new Error('AgentCore did not return an automation stream for the session.');
  }
  return {
    sessionId: data.sessionId,
    wsEndpoint,
    liveViewUrl: data.streams?.liveViewStream?.streamEndpoint,
  };
}

export async function stopSession(sessionId: string): Promise<void> {
  const id = browserId();
  await dataPlane(
    `/browsers/${encodeURIComponent(id)}/sessions/stop?sessionId=${encodeURIComponent(sessionId)}`,
    'PUT',
  ).catch(() => {
    // A session we cannot stop will still time out on its own — never let this
    // mask the real result of the work the user asked for.
  });
}

// ─── Minimal CDP client ──────────────────────────────────────────────────────
// Only what the agent actually needs. Hand-rolled rather than pulling in
// Playwright (which would drag a browser driver into the server bundle for a
// browser that lives in AWS).

class Cdp {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.on('message', (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) {
            p.reject(new Error(msg.error.message ?? 'CDP error'));
          } else {
            p.resolve(msg.result);
          }
        }
      } catch {
        // ignore malformed frames
      }
    });
  }

  static connect(wsEndpoint: string): Promise<Cdp> {
    const creds = awsCreds();
    if (!creds) {
      throw new Error('AWS credentials are not configured.');
    }
    // The WebSocket upgrade is an HTTP GET and must be SigV4-signed.
    const headers = signRequest({
      method: 'GET',
      url: wsEndpoint,
      service: SERVICE,
      region: awsRegion(),
      creds,
    });

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsEndpoint, { headers });
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('Timed out connecting to the browser automation stream.'));
      }, 30_000);

      ws.on('open', () => {
        clearTimeout(timer);
        resolve(new Cdp(ws));
      });
      ws.on('error', (err: Error) => {
        clearTimeout(timer);
        reject(new Error(`Browser stream connection failed: ${err.message}`));
      });
    });
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) {
      payload.sessionId = sessionId;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser command timed out: ${method}`));
      }, 45_000);

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });

      this.ws.send(JSON.stringify(payload));
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // already gone
    }
  }
}

/** Attach to a page target so we can drive it. */
async function attachPage(cdp: Cdp): Promise<string> {
  const { targetInfos } = await cdp.send('Target.getTargets') as {
    targetInfos: Array<{ targetId: string; type: string }>;
  };
  let target = targetInfos.find(t => t.type === 'page');

  if (!target) {
    const created = await cdp.send('Target.createTarget', { url: 'about:blank' }) as { targetId: string };
    target = { targetId: created.targetId, type: 'page' };
  }

  const { sessionId } = await cdp.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  }) as { sessionId: string };

  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  return sessionId;
}

export type PageResult = {
  url: string;
  title: string;
  text: string;
  /** Seconds the browser session was alive — this is what we bill. */
  sessionSeconds: number;
};

/**
 * Open a page in a real browser, let JavaScript run, and return the rendered
 * text. Stateless: the session is started and stopped inside this call, so we
 * never leak a paid-for browser.
 */
export async function renderPage(a: {
  url: string;
  waitMs?: number;
  selectors?: string[];
}): Promise<PageResult> {
  const started = Date.now();
  const session = await startSession(300);
  let cdp: Cdp | undefined;

  try {
    cdp = await Cdp.connect(session.wsEndpoint);
    const pageSession = await attachPage(cdp);

    await cdp.send('Page.navigate', { url: a.url }, pageSession);

    // Give the page's JavaScript time to render. Crude but predictable; the
    // alternative (waiting on lifecycle events) is far more code for little gain.
    await new Promise(r => setTimeout(r, Math.min(Math.max(a.waitMs ?? 3000, 500), 15_000)));

    const expression = a.selectors?.length
      ? `JSON.stringify(${JSON.stringify(a.selectors)}.map(function(s){
           return { selector: s, matches: Array.from(document.querySelectorAll(s)).slice(0, 50).map(function(e){ return (e.innerText || e.textContent || '').trim(); }) };
         }))`
      : 'document.body ? (document.body.innerText || "") : ""';

    const [{ result: textResult }, { result: titleResult }, { result: urlResult }] = await Promise.all([
      cdp.send('Runtime.evaluate', { expression, returnByValue: true }, pageSession),
      cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, pageSession),
      cdp.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, pageSession),
    ]) as [
      { result: { value?: string } },
      { result: { value?: string } },
      { result: { value?: string } },
    ];

    return {
      url: String(urlResult?.value ?? a.url),
      title: String(titleResult?.value ?? ''),
      text: String(textResult?.value ?? '').slice(0, 40_000),
      sessionSeconds: Math.max(1, Math.round((Date.now() - started) / 1000)),
    };
  } finally {
    cdp?.close();
    // Always stop — an orphaned session bills until its timeout expires.
    await stopSession(session.sessionId);
  }
}
