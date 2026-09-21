import { describe, expect, it } from 'vitest';
import { loadReferenceLibrary, MAX_REFERENCE_CHARS, parseSections, ReferenceLibrary } from '@/libs/mcp/references';
import { STDIO_SERVERS } from '@/libs/mcp/stdioCatalog';

const SAMPLE = `# Title
intro

## Tier 3 — Module Reference (element maps)
tier intro

### Content Modules

#### Text *(VB-verified 2026-03-19)*
**Elements**: \`module\`
- body of text

#### Blurb *(VB-verified 2026-03-20)*
- title is an OBJECT {text}

\`\`\`
#### not a heading inside a fence
\`\`\`

## Other
tail
`;

describe('reference parsing (Phase 45)', () => {
  it('splits by headings, keeps crumbs, strips verification notes, ignores fenced "headings"', () => {
    const s = parseSections('f.md', SAMPLE);
    const blurb = s.find(x => x.title === 'Blurb')!;

    expect(blurb.level).toBe(4);
    expect(blurb.note).toBe('VB-verified 2026-03-20');
    expect(blurb.crumbs).toBe('Tier 3 — Module Reference (element maps) > Content Modules > Blurb');
    expect(blurb.body).toContain('not a heading inside a fence');
    expect(s.some(x => x.title.includes('not a heading'))).toBe(false);
  });

  it('module lookup is case/suffix tolerant and section lookup includes children', () => {
    const lib = new ReferenceLibrary({ dir: '', toolName: 't', description: '', moduleFile: 'f.md', moduleLevel: 4 }, [{ file: 'f.md', text: SAMPLE }]);

    expect(lib.lookup({ module: 'blurb module' })).toContain('title is an OBJECT');
    expect(lib.lookup({ module: 'nope' })).toContain('Available: Text, Blurb');
    expect(lib.lookup({ file: 'f', section: 'Tier 3' })).toContain('#### Blurb');
    expect(lib.lookup({ query: 'object' })).toContain('Blurb');
    expect(lib.lookup({})).toContain('Module maps (2');
  });
});

describe('vendored DiviOps skill bundle', () => {
  const spec = STDIO_SERVERS.diviops!.references!;
  const lib = loadReferenceLibrary(spec);

  it('loads the real files and answers the calls the guidance promises', () => {
    expect(lib.files).toContain('divi-5-builder/references/module-formats.md');
    expect(lib.modules().length).toBeGreaterThan(20);

    const blurb = lib.lookup({ module: 'Blurb' });

    expect(blurb).toContain('Blurb');
    expect(blurb.length).toBeLessThanOrEqual(MAX_REFERENCE_CHARS + 200);
    expect(lib.lookup({ file: 'module-formats', section: 'Gradient background' })).toContain('gradient');
    expect(lib.lookup({ query: 'hover padding button' })).toContain('button');
    expect(lib.lookup({}).length).toBeLessThan(MAX_REFERENCE_CHARS);
  });
});
