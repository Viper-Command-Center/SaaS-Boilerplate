import { describe, expect, it, vi } from 'vitest';
import { inlineHtml, inlinePlain, parseMarkdown } from '@/libs/docs/markdown';
import { buildDocumentHtml, renderDocument } from '@/libs/docs/pdf';
import { renderFallbackPdf, winAnsi } from '@/libs/docs/pdfFallback';
import { extractPdfTextLayer } from '@/libs/docs/pdfText';

describe('markdown → blocks', () => {
  it('reads the shapes a business document is actually made of', () => {
    const blocks = parseMarkdown([
      '# Proposal',
      '',
      'Intro paragraph that runs',
      'across two source lines.',
      '',
      '## Costs',
      '',
      '| Item | Price |',
      '| --- | ----: |',
      '| Build | $4,000 |',
      '| Care | $250/mo |',
      '',
      '- first',
      '- second',
      '',
      '> a quote',
    ].join('\n'));

    expect(blocks.map(b => b.type)).toEqual([
      'heading',
      'paragraph',
      'heading',
      'table',
      'list',
      'quote',
    ]);

    const table = blocks.find(b => b.type === 'table');

    expect(table).toMatchObject({
      headers: ['Item', 'Price'],
      rows: [['Build', '$4,000'], ['Care', '$250/mo']],
    });
    // Soft-wrapped source lines must join into one paragraph, not two.
    expect(blocks[1]).toMatchObject({ text: 'Intro paragraph that runs across two source lines.' });
  });

  it('does not read markdown inside a fenced code block', () => {
    const blocks = parseMarkdown('```\n# not a heading\n- not a list\n```');

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('code');
  });

  it('treats a pipe in prose as prose, not a table', () => {
    const blocks = parseMarkdown('Use the A | B split test.');

    expect(blocks[0]?.type).toBe('paragraph');
  });

  it('takes an explicit page break in any of the forms a model will write', () => {
    for (const marker of ['\\pagebreak', '[pagebreak]', '<!-- pagebreak -->']) {
      expect(parseMarkdown(`a\n\n${marker}\n\nb`).map(b => b.type)).toContain('pagebreak');
    }
  });
});

describe('inline formatting', () => {
  it('escapes HTML before adding its own tags', () => {
    const html = inlineHtml('a <script>alert(1)</script> **bold**');

    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('<strong>bold</strong>');
  });

  it('keeps a link\'s URL when flattening to plain text', () => {
    expect(inlinePlain('see [our site](https://artivio.ai)')).toBe('see our site (https://artivio.ai)');
  });
});

describe('winAnsi', () => {
  it('transliterates what the standard fonts cannot encode instead of dropping it', () => {
    expect(winAnsi('done ✅ next → step')).toBe('done [x] next -> step');
  });

  it('drops characters with no equivalent rather than throwing later', () => {
    expect(winAnsi('ship it 🚀')).toBe('ship it ');
  });

  it('keeps ordinary punctuation intact', () => {
    expect(winAnsi('“quoted” — dash… €5')).toBe('“quoted” — dash… €5');
  });
});

describe('document HTML', () => {
  it('honours the requested page size and paints backgrounds when printing', () => {
    const html = buildDocumentHtml(
      {
        title: 'Q3',
        pageSize: 'a4',
      },
      parseMarkdown('# Hi'),
    );

    expect(html).toContain('size: 8.27in 11.69in');
    expect(html).toContain('print-color-adjust: exact');
  });

  it('normalises a themed colour written without the hash', () => {
    const html = buildDocumentHtml(
      {
        title: 'Branded',
        theme: { accent: '0f62fe' },
      },
      [],
    );

    expect(html).toContain('#0F62FE');
  });
});

describe('browser-free renderer', () => {
  const markdown = [
    '# Scope',
    '',
    'We will rebuild the site and migrate every post → no downtime.',
    '',
    '## Deliverables',
    '',
    '- Design system',
    '- Twelve templates',
    '',
    '| Phase | Weeks |',
    '| --- | --- |',
    '| Discovery | 2 |',
    '| Build | 6 |',
    '',
    '\\pagebreak',
    '',
    '# Terms',
    '',
    'Fifty percent on signature.',
  ].join('\n');

  it('produces a valid multi-page PDF containing the document text', async () => {
    const result = await renderFallbackPdf(
      {
        title: 'Website rebuild',
        subtitle: 'Prepared for Acme',
        markdown,
        footer: 'Confidential',
      },
      parseMarkdown(markdown),
    );

    expect(result.pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(result.pageCount).toBeGreaterThanOrEqual(2);

    // Round-trip through the reader: proves the bytes are a real PDF with a
    // real text layer, not just something that starts with the right header.
    const read = await extractPdfTextLayer(result.pdf);

    expect(read.pages).toBe(result.pageCount);
    expect(read.text).toContain('Website rebuild');
    expect(read.text).toContain('Discovery');
    expect(read.text).toContain('Fifty percent on signature.');
  }, 30_000);

  it('falls back to the browser-free renderer when no browser is available', async () => {
    // Forced, not inferred: on a machine that happens to have AWS credentials
    // the primary path would open a real AgentCore session, and a unit test
    // must never do that to prove a fallback works.
    vi.stubEnv('AWS_ACCESS_KEY_ID', '');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', '');
    try {
      const result = await renderDocument({
        title: 'Fallback path',
        markdown: '# Heading\n\nBody text.',
      });

      expect(result.engine).toBe('fallback');
      expect(result.note).toBeTruthy();
      expect(result.pdf.subarray(0, 5).toString()).toBe('%PDF-');
    } finally {
      vi.unstubAllEnvs();
    }
  }, 30_000);

  it('refuses an empty document rather than saving a blank file', async () => {
    await expect(renderDocument({
      title: 'Nothing',
      markdown: '   ',
    })).rejects.toThrow(/empty/i);
  });
});
