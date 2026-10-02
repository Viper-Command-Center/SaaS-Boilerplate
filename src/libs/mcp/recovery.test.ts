import { beforeEach, describe, expect, it, vi } from 'vitest';
import { failureKind, isSafeDiviRead, resetRecovery, withRecovery } from './recovery';

describe('bounded connection recovery', () => {
  beforeEach(resetRecovery);

  it('retries a safe read once after an exited process', async () => {
    const call = vi.fn().mockRejectedValueOnce(new Error('server exited')).mockResolvedValue('ok');

    expect(await withRecovery('x', true, call, async () => {})).toBe('ok');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('never retries writes after a timeout', async () => {
    const call = vi.fn().mockRejectedValue(new Error('timed out'));

    await expect(withRecovery('x', false, call)).rejects.toThrow(/NOT retried/);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('rate limits open a circuit without diagnostic retries', async () => {
    const call = vi.fn().mockRejectedValue(new Error('429 too many requests'));

    await expect(withRecovery('x', true, call)).rejects.toThrow(/rate_limit/);
    await expect(withRecovery('x', true, call)).rejects.toThrow(/paused/);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('unknown/new vendor tools are not safe reads', () => {
    expect(isSafeDiviRead('diviops_page_get')).toBe(true);
    expect(isSafeDiviRead('diviops_page_update_meta')).toBe(false);
    expect(isSafeDiviRead('diviops_new_mutation')).toBe(false);
    expect(failureKind('401 unauthorized')).toBe('authentication');
  });
});
