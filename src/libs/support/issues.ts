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
import { issues } from '@/models/Schema';
import { notifyOperator } from './notify';


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

const SECRET_KEY_RE = /key|token|secret|password|authorization|credential|apikey|bearer/i;

/**
 * Never let a value leak a secret into a log or an email. RECURSES into nested
 * objects/arrays — a secret is just as dangerous one level down (e.g.
 * `{ headers: { Authorization: '…' } }`), and the shallow version missed it.
 * Exported so the audit log uses the exact same redaction as issue capture.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value == null) {
    return value;
  }
  if (typeof value === 'string') {
    return value.length > 300 ? `${value.slice(0, 300)}…` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map(v => redact(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export type CaptureInput = {
  tenantId?: string | null;
  tenantSlug?: string;
  source: string; // tool name / connection / route
  error: unknown;
  detail?: Record<string, unknown>;
  reportedByAgent?: boolean;
  /** Force the class (e.g. a known-benign reconciliation flag → 'provider', so it logs without emailing). */
  forceKind?: IssueKind;
};

/**
 * Record an issue and, if it's ours, email the operator. Never throws — issue
 * capture must not be able to break the thing it is reporting on.
 */
export async function captureIssue(input: CaptureInput): Promise<Classified> {
  const classified = input.forceKind
    ? { ...classifyToolError(input.error), kind: input.forceKind, escalate: input.forceKind === 'platform' }
    : classifyToolError(input.error);
  const message = input.error instanceof Error ? input.error.message : String(input.error ?? 'Unknown error');

  try {
    // Redact the ENTIRE detail object, not just detail.args — a secret in any
    // field (headers, config, a nested credential) must never reach the log or
    // the escalation email.
    const detail = {
      ...(redact(input.detail ?? {}) as Record<string, unknown>),
      workspace: input.tenantSlug,
      stack: input.error instanceof Error ? input.error.stack?.slice(0, 2000) : undefined,
    };

    await db.insert(issues).values({
      tenantId: input.tenantId ?? null,
      kind: classified.kind,
      source: input.source.slice(0, 160),
      message: message.slice(0, 2000),
      detail,
      reportedByAgent: Boolean(input.reportedByAgent),
    });

    // Only OUR bugs page a human — anything that could affect all clients gets
    // oversight (Ryan's rule). Config and provider noise would train the
    // operator to ignore the inbox, so those are logged but never pushed.
    if (classified.escalate) {
      const workspace = input.tenantSlug ?? input.tenantId ?? 'unknown';
      const bundle = buildBundle({ source: input.source, workspace, message, detail });
      await notifyOperator({
        subject: `[Artivio] Platform issue: ${input.source}`,
        short: `${message.slice(0, 200)}\n(workspace: ${workspace})`,
        full: bundle,
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
