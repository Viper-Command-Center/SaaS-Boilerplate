/**
 * Issue triage — turning a failure into the right action, automatically.
 *
 * The Kie.ai incident is the template for why this exists: the platform threw a
 * misleading error, the agent invented a plausible fix, and the human burned
 * time on a dead end. So:
 *
 *   1. CLASSIFY the failure honestly (who can actually fix this?)
 *      · config   → the client can fix it (bad key, wrong URL, expired token)
 *      · provider → the third party is down/rejecting; retry later
 *      · platform → OUR bug. The client cannot fix it and the agent must not
 *                   pretend otherwise.
 *   2. CAPTURE it with the real error + full context (never a paraphrase).
 *   3. ESCALATE platform-class issues to the operator by email, with a
 *      diagnostic bundle an engineer can act on without interviewing the client.
 */

import { db } from '@/libs/DB';
import { sendEmail } from '@/libs/email';
import { issues } from '@/models/Schema';

export type IssueKind = 'config' | 'provider' | 'platform';

export type Classified = {
  kind: IssueKind;
  /** What the CLIENT should be told — honest, no invented remediation. */
  clientMessage: string;
  /** True when a human operator (Ryan/engineer) must act. */
  escalate: boolean;
};

/**
 * Map an error to who can fix it. Deliberately conservative: anything we do not
 * positively recognise as a config or provider problem is treated as OUR bug,
 * because silently blaming the client for a platform defect is the failure mode
 * that costs the most trust.
 */
export function classifyToolError(err: unknown): Classified {
  const raw = err instanceof Error ? err.message : String(err ?? 'Unknown error');
  const m = raw.toLowerCase();

  // ── The client's credential or target is wrong ──
  if (
    /\b401\b|\b403\b|unauthorized|forbidden|invalid api key|invalid token|authentication|permission denied/.test(m)
  ) {
    return {
      kind: 'config',
      clientMessage: `The credential for this tool was rejected: "${raw}". Check the key in the Tools panel — it may be wrong, revoked, or lack the required scope.`,
      escalate: false,
    };
  }
  if (/\b404\b|not found|enotfound|econnrefused|getaddrinfo|dns|certificate|ssl/.test(m)) {
    return {
      kind: 'config',
      clientMessage: `The tool's endpoint could not be reached: "${raw}". Check the server URL in the Tools panel.`,
      escalate: false,
    };
  }
  if (/no credential|needs a site url|not configured|missing/.test(m)) {
    return {
      kind: 'config',
      clientMessage: `This tool is not fully configured: "${raw}".`,
      escalate: false,
    };
  }

  // ── The third party is unhappy, but nothing is misconfigured ──
  if (/\b429\b|rate limit|too many requests|quota|insufficient credit|no credit|\b402\b/.test(m)) {
    return {
      kind: 'provider',
      clientMessage: `The provider is rate-limiting or out of credit: "${raw}". This usually clears on its own — try again shortly.`,
      escalate: false,
    };
  }
  if (/\b5\d\d\b|timeout|timed out|econnreset|socket hang up|unavailable|maintenance/.test(m)) {
    return {
      kind: 'provider',
      clientMessage: `The provider failed or timed out: "${raw}". That's on their side; retrying later is the right move.`,
      escalate: false,
    };
  }

  // ── Anything else is ours until proven otherwise ──
  return {
    kind: 'platform',
    clientMessage: `This failed with an error that looks like a bug in Artivio itself, not something you can fix: "${raw}". It's been reported automatically — you don't need to do anything.`,
    escalate: true,
  };
}

/** Never let an argument value leak a secret into the issue log. */
function redact(args: unknown): unknown {
  if (!args || typeof args !== 'object') {
    return args;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    out[k] = /key|token|secret|password|authorization|credential/i.test(k)
      ? '[redacted]'
      : typeof v === 'string' && v.length > 300 ? `${v.slice(0, 300)}…` : v;
  }
  return out;
}

export type CaptureInput = {
  tenantId?: string | null;
  tenantSlug?: string;
  source: string; // tool name / connection / route
  error: unknown;
  detail?: Record<string, unknown>;
  reportedByAgent?: boolean;
};

/**
 * Record an issue and, if it's ours, email the operator. Never throws — issue
 * capture must not be able to break the thing it is reporting on.
 */
export async function captureIssue(input: CaptureInput): Promise<Classified> {
  const classified = classifyToolError(input.error);
  const message = input.error instanceof Error ? input.error.message : String(input.error ?? 'Unknown error');

  try {
    const detail = {
      ...(input.detail ?? {}),
      workspace: input.tenantSlug,
      stack: input.error instanceof Error ? input.error.stack?.slice(0, 2000) : undefined,
      args: redact((input.detail as Record<string, unknown> | undefined)?.args),
    };

    await db.insert(issues).values({
      tenantId: input.tenantId ?? null,
      kind: classified.kind,
      source: input.source.slice(0, 160),
      message: message.slice(0, 2000),
      detail,
      reportedByAgent: Boolean(input.reportedByAgent),
    });

    // Only OUR bugs page a human. Config and provider noise would train the
    // operator to ignore the inbox, which defeats the point.
    if (classified.escalate) {
      const bundle = buildBundle({
        source: input.source,
        workspace: input.tenantSlug ?? input.tenantId ?? 'unknown',
        message,
        detail,
      });
      await sendEmail({
        to: process.env.EMAIL_FROM || 'hello@artivio.ai',
        subject: `[Artivio] Platform issue: ${input.source}`.slice(0, 120),
        text: bundle,
        html: `<pre style="font:13px/1.5 ui-monospace,monospace;white-space:pre-wrap">${
          bundle.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] ?? c))
        }</pre>`,
      }).catch(() => {});
    }
  } catch {
    // swallow — reporting a failure must never cause one
  }

  return classified;
}

/** A copy-pasteable diagnostic an engineer can act on without interviewing anyone. */
export function buildBundle(a: {
  source: string;
  workspace: string;
  message: string;
  detail: unknown;
}): string {
  return [
    '# Artivio platform issue',
    '',
    `**Where:** ${a.source}`,
    `**Workspace:** ${a.workspace}`,
    `**When:** ${new Date().toISOString()}`,
    '',
    '## Error (verbatim)',
    '```',
    a.message,
    '```',
    '',
    '## Context',
    '```json',
    JSON.stringify(a.detail, null, 2).slice(0, 6000),
    '```',
  ].join('\n');
}
