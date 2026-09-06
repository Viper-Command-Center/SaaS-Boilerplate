/**
 * Secret redaction for everything that leaves the WordPress Sites adapter —
 * tool results, error messages, audit detail, test reports.
 *
 * Two passes, because each catches what the other cannot:
 *  1. LITERAL: every known secret (the app password, its base64 Basic form,
 *     the SSH private key body) is replaced wherever it appears. A WordPress
 *     error that echoes the header back, a `wp config get` that prints a key —
 *     both are caught even though no pattern would predict them.
 *  2. PATTERN: `Authorization: Basic|Bearer …` values and PEM blocks are
 *     masked even when the secret is one we do not hold (a site that leaks a
 *     third-party token in a response body).
 */

const PATTERNS: RegExp[] = [
  /(authorization["']?\s*[:=]\s*["']?)(?:basic|bearer)\s+[\w+/=.-]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // A WordPress application password in display form: 6 groups of 4.
  /\b(?:[a-z0-9]{4} ){5}[a-z0-9]{4}\b/gi,
];

export function redactSecrets(text: string, secrets: Array<string | null | undefined>): string {
  let out = text ?? '';
  for (const s of secrets) {
    const v = (s ?? '').trim();
    if (v.length < 6) {
      continue; // a 3-char "secret" would redact ordinary words
    }
    out = out.split(v).join('[redacted]');
    // The Basic-auth base64 of "user:secret" contains the secret only after
    // encoding, so also mask its base64 form and a bare base64 of the secret.
    const b64 = Buffer.from(v).toString('base64');
    if (b64.length >= 8) {
      out = out.split(b64).join('[redacted]');
    }
    // Display-spaced app password (xxxx xxxx …) when we stored the compact one.
    if (v.length === 24 && /^[a-z0-9]+$/i.test(v)) {
      const spaced = v.match(/.{1,4}/g)?.join(' ');
      if (spaced) {
        out = out.split(spaced).join('[redacted]');
      }
    }
  }
  for (const re of PATTERNS) {
    out = out.replace(re, (m, prefix?: string) => (typeof prefix === 'string' && m.startsWith(prefix) ? `${prefix}[redacted]` : '[redacted]'));
  }
  return out;
}

/** Wrap an unknown error so its message is redacted before it propagates. */
export function redactError(err: unknown, secrets: Array<string | null | undefined>): Error {
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(redactSecrets(msg, secrets));
}
