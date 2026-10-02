import { describe, expect, it } from 'vitest';
import { parseDiviBlocks } from './blocks';
import { compilePage, PATTERNS } from './patterns';

describe('native page patterns', () => {
  const section = (pattern: typeof PATTERNS[number]) => ({ pattern, title: 'Welcome', body: 'Real copy, not invented HTML', image: { src: 'https://example.com/wp-content/uploads/hero.jpg', alt: 'Exterior' }, button: { text: 'Contact us', url: '/contact' }, items: [{ title: 'Service', body: 'Details' }, { title: 'Other', body: 'Details' }] });

  it.each(PATTERNS)('%s compiles with no required presets and correct native nesting', (pattern) => {
    const r = compilePage({ title: 'Home', slug: 'home', builderVersion: '5.4.1', sections: [section(pattern)] }, 'example.com');

    expect(parseDiviBlocks(r.markup).errors).toEqual([]);
    expect(r.stats.codeModules).toBe(0);
    expect(r.markup).toContain('phone');
    expect(r.markup).not.toContain('preset-uuid');
  });

  it('builds a six-section page under the structural cap', () => {
    const r = compilePage({ title: 'Home', slug: 'home', builderVersion: '5.4.1', sections: PATTERNS.slice(0, 6).map(section) }, 'example.com');

    expect(r.stats.blocks).toBeLessThan(200);
  });

  it('uses render-consumed button background and inline padding paths', () => {
    const r = compilePage({ title: 'Home', slug: 'home', builderVersion: '5.4.1', sections: [section('cta')] }, 'example.com');
    const tree = parseDiviBlocks(r.markup);
    const button = tree.roots[0]!.children[0]!.children[0]!.children[0]!.children.find(b => b.name === 'divi/button')!;

    expect(button.attrs).toMatchObject({ button: { decoration: { background: { desktop: { value: { color: '#4338ca' } } } } }, module: { decoration: { spacing: { desktop: { value: { padding: { left: '24px' } } } } } } });
    expect(JSON.stringify(button.attrs)).not.toContain('backgroundColor');
  });

  it('refuses offsite/private media, invalid links, missing images and version guesses', () => {
    const plan = { title: 'Home', slug: 'home', builderVersion: '5.4.1', sections: [section('hero-split')] };

    expect(() => compilePage(plan, 'another-site.com')).toThrow(/hosted/);
    expect(() => compilePage({ ...plan, builderVersion: 'unknown' }, 'example.com')).toThrow();
    expect(() => compilePage({ ...plan, sections: [{ ...section('hero-split'), image: undefined }] }, 'example.com')).toThrow(/requires/);
    expect(() => compilePage({ ...plan, sections: [{ ...section('cta'), button: { text: 'Bad', url: 'javascript:alert(1)' } }] }, 'example.com')).toThrow();
  });

  it('escapes content without turning user text into code', () => {
    const r = compilePage({ title: 'Home', slug: 'home', builderVersion: '5.4.1', sections: [{ pattern: 'cta', title: 'Safe', body: '<script>alert(1)</script> -- text' }] }, 'example.com');

    expect(r.markup).not.toContain('<script>');
    expect(r.markup).toContain('lt;script');
  });
});
