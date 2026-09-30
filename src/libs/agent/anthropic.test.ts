import { describe, expect, it } from 'vitest';
import { isThinkingModeMismatch, thinkingRequestFields } from '@/libs/agent/anthropic';

// Phase 48.6 (2026-09-30) — the Copetown mission paused twice on a real backend
// 400: Sonnet 5 (Claude 4.7+) rejects the legacy thinking:{type:'enabled',
// budget_tokens} shape and requires thinking:{type:'adaptive'} + output_config:
// {effort}. These tests pin the request-shape builder + the self-heal trigger.
describe('Mantle Anthropic thinking shape (Copetown 400 fix)', () => {
  describe('thinkingRequestFields', () => {
    it('high effort in adaptive mode sends type:adaptive + output_config.effort:high and NO budget/max_tokens floor', () => {
      const { extra, minMaxTokens } = thinkingRequestFields('adaptive', 'high');

      expect(extra).toEqual({ thinking: { type: 'adaptive' }, output_config: { effort: 'high' } });
      expect(minMaxTokens).toBe(0);
      expect(JSON.stringify(extra)).not.toContain('budget_tokens');
      expect(JSON.stringify(extra)).not.toContain('enabled');
    });

    it('medium effort in adaptive mode maps to output_config.effort:medium', () => {
      const { extra } = thinkingRequestFields('adaptive', 'medium');

      expect(extra).toEqual({ thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } });
    });

    it('high effort in legacy mode sends type:enabled + budget_tokens and a max_tokens floor above the budget', () => {
      const { extra, minMaxTokens } = thinkingRequestFields('legacy', 'high');

      expect(extra).toEqual({ thinking: { type: 'enabled', budget_tokens: 8_192 } });
      expect(minMaxTokens).toBe(8_192 + 1_024);
    });

    it('low / undefined effort sends NO thinking block in EITHER mode (chat stays cheap, mismatch never fires)', () => {
      for (const mode of ['adaptive', 'legacy'] as const) {
        expect(thinkingRequestFields(mode, 'low')).toEqual({ extra: {}, minMaxTokens: 0 });
        expect(thinkingRequestFields(mode, undefined)).toEqual({ extra: {}, minMaxTokens: 0 });
        expect(thinkingRequestFields(mode, 'minimal')).toEqual({ extra: {}, minMaxTokens: 0 });
      }
    });
  });

  describe('isThinkingModeMismatch', () => {
    it('matches the exact Bedrock Mantle 400 that paused Copetown (enabled not supported)', () => {
      const body = '{"type":"error","error":{"type":"invalid_request_error","message":"\\"thinking.type.enabled\\" is not supported for this model. Use \\"thinking.type.adaptive\\" and \\"output_config.effort\\" to control thinking behavior."}}';

      expect(isThinkingModeMismatch(400, body)).toBe(true);
    });

    it('matches the reverse direction (adaptive not supported on an older model) so the flip is symmetric', () => {
      expect(isThinkingModeMismatch(400, '"thinking.type.adaptive" is not supported for this model')).toBe(true);
    });

    it('does NOT treat unrelated 400s or transient 5xx as a mode mismatch', () => {
      expect(isThinkingModeMismatch(400, 'max_tokens must be greater than thinking budget')).toBe(false);
      expect(isThinkingModeMismatch(429, 'thinking.type.enabled is not supported')).toBe(false);
      expect(isThinkingModeMismatch(500, 'internal error')).toBe(false);
    });
  });
});
