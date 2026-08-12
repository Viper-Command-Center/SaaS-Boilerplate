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

export type LayoutIssue = {
  type: 'horizontal-overflow' | 'widow' | 'text-overflow' | 'tiny-text';
  tag?: string;
  text?: string;
  detail: string;
};

export type ViewportReport = {
  width: number;
  issues: LayoutIssue[];
  elements: Array<{
    tag: string;
    text: string;
    fontSizePx: number;
    lines: number;
    lastLineWords: number;
    lastLine: string;
  }>;
};

export type LayoutResult = {
  url: string;
  title: string;
  viewports: ViewportReport[];
  sessionSeconds: number;
};

export const DEFAULT_LAYOUT_SELECTORS = [
  'h1',
  'h2',
  'h3',
  '.elementor-heading-title',
  '.elementor-button-text',
];

/**
 * The in-page measurement pass.
 *
 * MEASUREMENT, NOT VISION — and that is the point. "The last line of the
 * headline is one orphaned word" is a fact about rendered line boxes, so it can
 * be COMPUTED rather than eyeballed. A screenshot costs ~1,500 tokens, shows one
 * viewport, and still leaves the model interpreting pixels; this returns a few
 * hundred tokens of JSON, is deterministic, and covers every width in one pass.
 *
 * Written in ES5 with NO regular expressions and NO template literals, because
 * this string lives inside a TypeScript template literal before it is shipped
 * over CDP. A lone backslash would be eaten silently on the way — `\S` becomes
 * `S`, quietly turning a non-whitespace matcher into an S matcher, with no error
 * anywhere. Hand-rolled word splitting has no escaping surface at all.
 */
const LAYOUT_SCRIPT = `(function(){
  var out = { issues: [], elements: [] };
  var vw = window.innerWidth;
  var de = document.documentElement;

  if (de && de.scrollWidth > vw + 2) {
    out.issues.push({
      type: 'horizontal-overflow',
      detail: 'the page scrolls sideways by ' + (de.scrollWidth - vw) + 'px at ' + vw + 'px wide'
    });
  }

  function wordsIn(el) {
    var found = [];
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = walker.nextNode())) {
      var t = node.nodeValue;
      if (!t) { continue; }
      var start = -1;
      for (var i = 0; i <= t.length; i++) {
        var ch = i < t.length ? t.charAt(i) : ' ';
        var code = ch.charCodeAt(0);
        var space = (ch === ' ' || code === 10 || code === 9 || code === 13 || code === 160);
        if (!space && start === -1) { start = i; }
        else if (space && start !== -1) {
          var range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, i);
          var rect = range.getBoundingClientRect();
          if (rect.width > 0 || rect.height > 0) {
            found.push({ w: t.slice(start, i), top: Math.round(rect.top) });
          }
          start = -1;
        }
      }
    }
    return found;
  }

  var picked = [];
  SELECTORS.forEach(function (s) {
    var nodes = document.querySelectorAll(s);
    for (var i = 0; i < nodes.length && i < 6; i++) {
      if (picked.indexOf(nodes[i]) === -1) { picked.push(nodes[i]); }
    }
  });

  picked.slice(0, 12).forEach(function (el) {
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) { return; }
    var cs = window.getComputedStyle(el);
    var ws = wordsIn(el);
    if (!ws.length) { return; }

    var lines = [];
    ws.forEach(function (w) {
      var last = lines[lines.length - 1];
      if (last && Math.abs(last.top - w.top) <= 3) { last.words.push(w.w); }
      else { lines.push({ top: w.top, words: [w.w] }); }
    });

    var lastLine = lines[lines.length - 1];
    var rec = {
      tag: el.tagName.toLowerCase(),
      text: ws.map(function (w) { return w.w; }).join(' ').slice(0, 80),
      fontSizePx: Math.round(parseFloat(cs.fontSize) || 0),
      lines: lines.length,
      lastLineWords: lastLine ? lastLine.words.length : 0,
      lastLine: lastLine ? lastLine.words.join(' ').slice(0, 40) : ''
    };

    if (lines.length > 1 && rec.lastLineWords === 1) {
      out.issues.push({
        type: 'widow',
        tag: rec.tag,
        text: rec.text,
        detail: 'wraps onto ' + lines.length + ' lines and the last line is the single word "' + rec.lastLine + '"'
      });
    }
    if (el.scrollWidth > el.clientWidth + 2) {
      out.issues.push({
        type: 'text-overflow',
        tag: rec.tag,
        text: rec.text,
        detail: 'content is ' + (el.scrollWidth - el.clientWidth) + 'px wider than its box'
      });
    }
    if (vw <= 480 && rec.fontSizePx > 0 && rec.fontSizePx < 12) {
      out.issues.push({
        type: 'tiny-text',
        tag: rec.tag,
        text: rec.text,
        detail: 'renders at ' + rec.fontSizePx + 'px on a ' + vw + 'px viewport'
      });
    }

    out.elements.push(rec);
  });

  return JSON.stringify(out);
})()`;

/**
 * Measure how a page actually LAYS OUT, at several viewport widths, in ONE
 * browser session.
 *
 * Multi-width in a single session is the economic argument: session cost is
 * dominated by start-up, so checking desktop, tablet and mobile costs barely
 * more than checking one — and the headline that reads perfectly at 1440px is
 * precisely the one that breaks at 390px.
 */
export async function inspectLayout(a: {
  url: string;
  selectors?: string[];
  widths?: number[];
  waitMs?: number;
}): Promise<LayoutResult> {
  const started = Date.now();
  const selectors = (a.selectors?.length ? a.selectors : DEFAULT_LAYOUT_SELECTORS).slice(0, 10);
  const widths = (a.widths?.length ? a.widths : [1440, 768, 390])
    .map(w => Math.min(Math.max(Math.round(w), 320), 2560))
    .slice(0, 4);

  const session = await startSession(300);
  let cdp: Cdp | undefined;

  try {
    cdp = await Cdp.connect(session.wsEndpoint);
    const pageSession = await attachPage(cdp);

    await cdp.send('Page.navigate', { url: a.url }, pageSession);
    await new Promise(r => setTimeout(r, Math.min(Math.max(a.waitMs ?? 3000, 500), 15_000)));

    const [{ result: titleResult }, { result: urlResult }] = await Promise.all([
      cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, pageSession),
      cdp.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, pageSession),
    ]) as [{ result: { value?: string } }, { result: { value?: string } }];

    const expression = LAYOUT_SCRIPT.replace('SELECTORS', JSON.stringify(selectors));
    const viewports: ViewportReport[] = [];

    for (const width of widths) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: width <= 480,
      }, pageSession);

      // Reflow plus any width-driven JS needs a beat to settle. Responsive CSS
      // alone is instant; carousels and sticky headers are not.
      await new Promise(r => setTimeout(r, 600));

      const { result } = await cdp.send(
        'Runtime.evaluate',
        { expression, returnByValue: true },
        pageSession,
      ) as { result: { value?: string } };

      let parsed: { issues?: LayoutIssue[]; elements?: ViewportReport['elements'] } = {};
      try {
        parsed = JSON.parse(String(result?.value ?? '{}')) as typeof parsed;
      } catch {
        // A page that breaks the measurement script must not break the whole
        // report — the other widths are still worth having.
      }

      viewports.push({
        width,
        issues: parsed.issues ?? [],
        elements: parsed.elements ?? [],
      });
    }

    return {
      url: String(urlResult?.value ?? a.url),
      title: String(titleResult?.value ?? ''),
      viewports,
      sessionSeconds: Math.max(1, Math.round((Date.now() - started) / 1000)),
    };
  } finally {
    cdp?.close();
    await stopSession(session.sessionId);
  }
}

/**
 * Open a page in a real browser, let JavaScript run, and return the rendered
 * text. Stateless: the session is started and stopped inside this call, so we
 * never leak a paid-for browser.
 */
export type PdfResult = {
  pdf: Buffer;
  bytes: number;
  /** Seconds the browser session was alive — this is what we bill. */
  sessionSeconds: number;
};

/**
 * Render HTML (or a live URL) to a PDF, in the same AWS Chrome everything else
 * here uses.
 *
 * WHY THIS AND NOT A PDF LIBRARY. The alternatives are worse for this codebase.
 * Puppeteer or Playwright at runtime means shipping a ~300MB Chromium into the
 * Railway image, which the Nixpacks build does not currently install and which
 * would slow every deploy for a feature used occasionally. A pure-JS library
 * (pdfkit, pdf-lib) draws boxes and text but does not do CSS layout, so the
 * agent would have to compute positions by hand — hopeless for a slide deck.
 * We already pay for a real headless Chrome that speaks CDP, and `Page.printToPDF`
 * is one more command on the socket we already have open. No new dependency,
 * no image bloat, full CSS.
 *
 * Cost: a render is a few browser-seconds, so fractions of a cent at the usual
 * $0.11/hour — but it is metered like every other session, not free.
 */
export async function renderPdf(a: {
  /** Inline HTML. Ignored when `url` is set. */
  html?: string;
  /** Render a live page instead of inline HTML. */
  url?: string;
  landscape?: boolean;
  /** Inches. Default US Letter; a 16:9 slide is 13.333 x 7.5. */
  paperWidthIn?: number;
  paperHeightIn?: number;
  marginIn?: number;
  waitMs?: number;
  /**
   * Let the document's own `@page { size: … }` win over paperWidth/Height.
   * On by default: a deck that declares its own page size is the common case,
   * and silently overriding it produces slides cropped to Letter.
   */
  preferCssPageSize?: boolean;
  /**
   * 'screen' (default) or 'print'. Chrome switches to print media for
   * printToPDF unless told otherwise, which strips the screen styling that
   * agent-authored HTML is invariably written in — dark slide backgrounds
   * vanish and the deck comes out white.
   */
  media?: 'screen' | 'print';
}): Promise<PdfResult> {
  if (!a.html && !a.url) {
    throw new Error('renderPdf needs html or url.');
  }

  const started = Date.now();
  const session = await startSession(300);
  let cdp: Cdp | undefined;

  try {
    cdp = await Cdp.connect(session.wsEndpoint);
    const pageSession = await attachPage(cdp);

    if (a.url) {
      await cdp.send('Page.navigate', { url: a.url }, pageSession);
    } else {
      // setDocumentContent needs the frame it is replacing; there is no
      // "current frame" shorthand in CDP.
      const { frameTree } = await cdp.send('Page.getFrameTree', {}, pageSession) as {
        frameTree: { frame: { id: string } };
      };
      await cdp.send(
        'Page.setDocumentContent',
        { frameId: frameTree.frame.id, html: a.html },
        pageSession,
      );
    }

    await cdp.send('Emulation.setEmulatedMedia', { media: a.media ?? 'screen' }, pageSession);

    // Same crude wait as renderPage. It matters more here: setDocumentContent
    // resolves as soon as the HTML is parsed, NOT when its webfonts and images
    // have loaded, so printing immediately yields a PDF in fallback fonts with
    // blank image boxes — and it looks like a styling bug, not a timing one.
    await new Promise(r => setTimeout(r, Math.min(Math.max(a.waitMs ?? 2000, 250), 15_000)));

    const { data } = await cdp.send('Page.printToPDF', {
      landscape: Boolean(a.landscape),
      printBackground: true,
      preferCSSPageSize: a.preferCssPageSize !== false,
      paperWidth: a.paperWidthIn ?? 8.5,
      paperHeight: a.paperHeightIn ?? 11,
      marginTop: a.marginIn ?? 0.4,
      marginBottom: a.marginIn ?? 0.4,
      marginLeft: a.marginIn ?? 0.4,
      marginRight: a.marginIn ?? 0.4,
    }, pageSession) as { data: string };

    if (!data) {
      throw new Error('Chrome returned an empty PDF.');
    }

    const pdf = Buffer.from(data, 'base64');
    // A valid PDF starts with %PDF-. Checking here turns a silent zero-byte or
    // truncated download into an error at the point it happened.
    if (pdf.length < 1000 || pdf.subarray(0, 5).toString() !== '%PDF-') {
      throw new Error(`Chrome returned ${pdf.length} bytes that are not a PDF.`);
    }

    return {
      pdf,
      bytes: pdf.length,
      sessionSeconds: Math.max(1, Math.round((Date.now() - started) / 1000)),
    };
  } finally {
    cdp?.close();
    // Always stop — an orphaned session bills until its timeout expires.
    await stopSession(session.sessionId);
  }
}

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
