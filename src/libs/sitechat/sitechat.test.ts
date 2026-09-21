import { describe, expect, it } from 'vitest';
import { externalKeyFor, hashSiteToken, mintSiteToken, normaliseSiteUser } from '@/libs/sitechat/auth';
import { isSiteChatToolAllowed } from '@/libs/sitechat/toolset';

describe('site chat allow-list (Phase 46)', () => {
  const bound = { layout: ['diviops-build-9'], wpSites: ['wp-sites'] };

  it('lets through the site\'s own content tools, its bound layout connection and the read-only platform tools', () => {
    expect(isSiteChatToolAllowed('mcp__wp-sites__wp-content-update', bound)).toBe(true);
    expect(isSiteChatToolAllowed('mcp__wp-sites__wp-upload-media', bound)).toBe(true);
    expect(isSiteChatToolAllowed('mcp__diviops-build-9__diviops-page-list', bound)).toBe(true);
    expect(isSiteChatToolAllowed('diviops_reference', bound)).toBe(true);
    expect(isSiteChatToolAllowed('search_stock_photos', bound)).toBe(true);
  });

  it('refuses account-wide, other-site and other-system tools', () => {
    expect(isSiteChatToolAllowed('mcp__wp-sites__wp-cli', bound)).toBe(false);
    expect(isSiteChatToolAllowed('mcp__wp-sites__wp-search-replace', bound)).toBe(false);
    expect(isSiteChatToolAllowed('mcp__wp-sites__wp-write-file', bound)).toBe(false);
    expect(isSiteChatToolAllowed('mcp__wp-sites__wp-sites', bound)).toBe(false);
    expect(isSiteChatToolAllowed('mcp__diviops__diviops-page-list', bound)).toBe(false); // another site's DiviOps
    expect(isSiteChatToolAllowed('mcp__whmcs__list-clients', bound)).toBe(false);
    expect(isSiteChatToolAllowed('mcp__postgres__query', bound)).toBe(false);
    expect(isSiteChatToolAllowed('list_files', bound)).toBe(false);
    expect(isSiteChatToolAllowed('update_memory', bound)).toBe(false);
    expect(isSiteChatToolAllowed('start_mission', bound)).toBe(false);
  });

  it('does not let a foreign server in by naming a tool like a WordPress Sites tool', () => {
    expect(isSiteChatToolAllowed('mcp__evil__wp-content-update', bound)).toBe(false);
  });
});

describe('site chat tokens + speakers', () => {
  it('mints a recognisable token and stores only its hash', () => {
    const { token, hash } = mintSiteToken();

    expect(token.startsWith('asc_')).toBe(true);
    expect(hash).toHaveLength(64);
    expect(hashSiteToken(token)).toBe(hash);
    expect(hash).not.toContain(token.slice(4, 12));
  });

  it('normalises the asserted WordPress user into a bounded key', () => {
    const u = normaliseSiteUser({ id: 12, name: 'Pastor <b>Dave</b>\n', role: 'administrator' })!;

    expect(externalKeyFor(u)).toBe('wp:12');
    expect(u.name).toBe('Pastor <b>Dave</b>');
    expect(normaliseSiteUser({ id: '' })).toBeNull();
    expect(normaliseSiteUser({ id: '../x' })!.id).toBe('..x');
  });
});
