/** Bounded recovery for safe reads only. Never replay an uncertain write. */
export type FailureKind = 'rate_limit' | 'timeout' | 'process_exit' | 'authentication' | 'input' | 'unknown';
export function failureKind(message: string): FailureKind {
  if (/rate.limit|too many requests|\b429\b/i.test(message)) {
    return 'rate_limit';
  }
  if (/timed? ?out/i.test(message)) {
    return 'timeout';
  }
  if (/server exited|not running|client disposed|failed to start/i.test(message)) {
    return 'process_exit';
  }
  if (/\b40[13]\b|unauthorized|authentication/i.test(message)) {
    return 'authentication';
  }
  if (/invalid|validation|missing|required|not_found|content_drift/i.test(message)) {
    return 'input';
  }
  return 'unknown';
}
const circuits = new Map<string, { failures: number; until: number }>();
/** Explicit allowlist: a newly added vendor tool is NEVER assumed idempotent. */
export function isSafeDiviRead(name: string): boolean {
  return /^diviops_(?:meta_(?:ping|info|find_icon)|page_(?:get|list|get_layout)|section_get|schema_(?:list_modules|get_module|get_settings)|template_(?:list|get)|library_(?:list|get)|variable_list|global_(?:color|font)_list|preset_(?:audit|inspect|audit_storage)|render_preview|validate_blocks)$/.test(name);
}
export async function withRecovery<T>(key: string, safeRead: boolean, call: () => Promise<T>, sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))): Promise<T> {
  const state = circuits.get(key);
  if (state && state.until > Date.now()) {
    throw new Error(`Connection recovery paused for ${Math.ceil((state.until - Date.now()) / 1000)}s. Save progress, stop issuing diagnostic calls, then resume the same plan.`);
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await call();
      circuits.delete(key);
      return result;
    } catch (error) {
      const kind = failureKind(error instanceof Error ? error.message : String(error));
      if (safeRead && attempt === 0 && ['timeout', 'process_exit'].includes(kind)) {
        await sleep(500);
        continue;
      }
      if (['rate_limit', 'timeout', 'process_exit'].includes(kind)) {
        const failures = (circuits.get(key)?.failures ?? 0) + 1;
        if (circuits.size > 2000) {
          circuits.clear();
        }
        circuits.set(key, { failures, until: kind === 'rate_limit' || failures >= 2 ? Date.now() + 30_000 : 0 });
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`[${kind}] ${message}${safeRead ? '' : ' Write was NOT retried; its outcome may be uncertain. Read back state before resuming.'}`);
    }
  }
}
export function resetRecovery(): void {
  circuits.clear();
}
