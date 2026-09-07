import { describe, expect, it } from 'vitest';
import { renderPlaybooks, SCOPE_RE, selectPlaybooks } from '@/libs/agent/playbooks';

describe('playbooks (Phase 37)', () => {
  const rows = [
    { scope: '*', enabled: true, title: 'All', body: 'a' },
    { scope: 'wp-sites', enabled: true, title: 'WP', body: 'b' },
    { scope: 'wp-sites', enabled: false, title: 'WP off', body: 'c' },
    { scope: 'elementor', enabled: true, title: 'El', body: 'd' },
    { scope: 'stdio:diviops', enabled: true, title: 'Divi', body: 'e' },
  ];

  it('picks "*" plus the enabled providers only, and skips disabled rows', () => {
    const chosen = selectPlaybooks(rows, ['wp-sites', 'stdio:diviops']);

    expect(chosen.map(r => r.title)).toEqual(['All', 'WP', 'Divi']);
  });

  it('a workspace with no providers still gets "*"', () => {
    expect(selectPlaybooks(rows, []).map(r => r.title)).toEqual(['All']);
  });

  it('renders as one section and nothing when empty', () => {
    expect(renderPlaybooks([])).toBe('');

    const out = renderPlaybooks([rows[0]!, rows[1]!]);

    expect(out).toMatch(/^## Operator playbooks/);
    expect(out).toContain('### All\na');
    expect(out).toContain('### WP (wp-sites)\nb');
  });

  it('scope validation accepts *, slugs and stdio keys; rejects junk', () => {
    for (const ok of ['*', 'wp-sites', 'stdio:diviops', 'book-publisher']) {
      expect(SCOPE_RE.test(ok)).toBe(true);
    }
    for (const bad of ['', 'WP Sites', 'stdio:', '../x', 'a']) {
      expect(SCOPE_RE.test(bad)).toBe(false);
    }
  });
});
