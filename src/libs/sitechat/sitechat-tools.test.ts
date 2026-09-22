import { describe, expect, it } from 'vitest';
import { isSiteChatToolAllowed } from './toolset';

describe('site chat allow-list (Phase 47.1 regression)', () => {
  const bound = { layout: ['diviops-build-9'], wpSites: ['WordPress Sites'] };

  it('lets the allow-listed WordPress tools through under the real connection name', () => {
    expect(isSiteChatToolAllowed('mcp__wordpress-sites__wp-content-list', bound)).toBe(true);
    expect(isSiteChatToolAllowed('mcp__wordpress-sites__wp-upload-media', bound)).toBe(true);
    expect(isSiteChatToolAllowed('mcp__wordpress-sites__wp-cli', bound)).toBe(false);
    expect(isSiteChatToolAllowed('mcp__wordpress-sites__wp-snapshot', bound)).toBe(false);
  });

  it('tiers DiviOps tools on the bound layout connection', () => {
    expect(isSiteChatToolAllowed('mcp__diviops-build-9__diviops-page-create', bound)).toBe(true);
    expect(isSiteChatToolAllowed('mcp__diviops-build-9__diviops-tb-layout-update', bound)).toBe(false);
    expect(isSiteChatToolAllowed('mcp__diviops-build-9__diviops-preset-delete', bound)).toBe(false);
  });
});
