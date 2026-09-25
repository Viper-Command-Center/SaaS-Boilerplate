import { describe, expect, it } from 'vitest';
import { htmlToMarkdown, parsePageHtml } from '@/libs/migration/duda/htmlParser';
import {
  buildCurrentDesignMarkdown,
  buildNewDesignBriefSkeleton,
  buildOverviewMarkdown,
  buildPageMarkdown,
  buildPostMarkdown,
  slugify,
} from '@/libs/migration/duda/markdown';

describe('migration — slugify', () => {
  it('normalises paths and titles to url-safe slugs', () => {
    expect(slugify('/About Us')).toBe('about-us');
    expect(slugify('Our Story!')).toBe('our-story');
    expect(slugify('https://x.com/contact-us')).toBe('contact-us');
    expect(slugify('')).toBe('page');
  });
});

describe('migration — HTML parser', () => {
  const html = `<!doctype html><html><head>
      <title>About Us</title>
      <meta name="description" content="Who we are">
    </head><body>
      <header><nav><a href="/about">About</a><a href="/give">Give</a></nav></header>
      <main>
        <h1>About Us</h1>
        <p>We are a friendly church.</p>
        <h2>Our Story</h2>
        <p>It started in 1990.</p>
        <img src="/img/hero.jpg" alt="Congregation">
        <a href="/visit">Plan a Visit</a>
        <script>var x = 1;</script>
      </main>
      <footer><a href="/privacy">Privacy</a></footer>
    </body></html>`;

  const parsed = parsePageHtml(html, 'https://example.com/about');

  it('pulls title and meta description', () => {
    expect(parsed.title).toBe('About Us');
    expect(parsed.metaDescription).toBe('Who we are');
  });

  it('extracts headings and paragraphs in order, ignoring scripts', () => {
    const kinds = parsed.blocks.map(b => b.kind);

    expect(kinds).toContain('heading');
    expect(kinds).toContain('paragraph');

    const paras = parsed.blocks.filter(b => b.kind === 'paragraph').map(b => (b as { text: string }).text);

    expect(paras).toContain('We are a friendly church.');
    expect(JSON.stringify(parsed.blocks)).not.toContain('var x');
  });

  it('absolutises image and link URLs and captures alt text', () => {
    expect(parsed.images[0]).toEqual({ src: 'https://example.com/img/hero.jpg', alt: 'Congregation' });
    expect(parsed.links.some(l => l.href === 'https://example.com/visit' && l.text === 'Plan a Visit')).toBe(true);
  });

  it('collects nav links from header/footer once', () => {
    const hrefs = parsed.nav.map(n => n.href);

    expect(hrefs).toContain('https://example.com/about');
    expect(hrefs).toContain('https://example.com/give');
    expect(hrefs).toContain('https://example.com/privacy');
  });

  it('converts blog HTML to readable markdown', () => {
    const md = htmlToMarkdown('<h2>Easter</h2><p>Join us <a href="/rsvp">RSVP</a>.</p><ul><li>9am</li><li>11am</li></ul>');

    expect(md).toContain('### Easter');
    expect(md).toContain('[RSVP](/rsvp)');
    expect(md).toContain('- 9am');
  });
});

describe('migration — markdown builders', () => {
  it('page file keeps page_type unknown and includes required sections', () => {
    const md = buildPageMarkdown({
      sourcePath: '/about-us',
      targetSlug: 'about-us',
      title: 'About Us',
      seoTitle: 'About | Church',
      seoDescription: 'About the church',
      blocks: [
        { kind: 'heading', level: 2, text: 'Our Story' },
        { kind: 'paragraph', text: 'Founded 1990.' },
        { kind: 'image', src: 'https://x/hero.jpg', alt: 'Hero' },
        { kind: 'link', text: 'Plan a Visit', href: '/visit' },
      ],
      nav: [{ text: 'About', href: '/about' }],
      mediaMap: new Map([['https://x/hero.jpg', { path: 'media/abc.jpg', alt: 'Hero' }]]),
    });

    expect(md).toContain('page_type: unknown');
    expect(md).toContain('source_path: /about-us');
    expect(md).toContain('status: extracted');
    expect(md).toContain('## Our Story');
    expect(md).toContain('media/abc.jpg');
    expect(md).toContain('## Notes for rebuild');
    expect(md).toContain('## Site navigation');
  });

  it('post file carries front matter and body', () => {
    const md = buildPostMarkdown({
      date: '2026-03-02',
      author: 'Pastor',
      tags: ['events', 'easter'],
      featuredImage: 'media/easter.jpg',
      title: 'Easter Service Times',
      bodyMarkdown: 'Full body here.',
    });

    expect(md).toContain('date: 2026-03-02');
    expect(md).toContain('tags: [events, easter]');
    expect(md).toContain('featured_image: media/easter.jpg');
    expect(md).toContain('# Easter Service Times');
    expect(md).toContain('Full body here.');
  });

  it('overview has both tables and the literal review checklist', () => {
    const md = buildOverviewMarkdown({
      siteName: 'yourtown',
      businessName: 'Yourtown Church',
      pages: [{ slug: 'about-us', title: 'About', sourcePath: '/about-us', status: 'extracted' }],
      posts: [{ date: '2026-03-02', title: 'Easter', file: '2026-03-02-easter.md', status: 'extracted' }],
      mediaCount: 5,
      collections: ['Team_Members'],
    });

    expect(md).toContain('- [ ] Pages reviewed');
    expect(md).toContain('- [ ] Blog posts reviewed');
    expect(md).toContain('- [ ] Images reviewed');
    expect(md).toContain('- [ ] Current design documented');
    expect(md).toContain('- [ ] New design approved');
    expect(md).toContain('[About](pages/about-us.md)');
    expect(md).toContain('2026-03-02-easter.md');
  });

  it('current-design fills auto fields and marks human TODOs', () => {
    const md = buildCurrentDesignMarkdown({
      businessName: 'Yourtown Church',
      businessDescription: 'A warm community',
      category: 'Church',
      address: '123 Maple St',
      phones: ['555-1234'],
      emails: ['hi@x.com'],
      socials: [{ network: 'facebook', url: 'https://fb/x' }],
      logos: ['media/logo.png'],
      colors: [{ label: 'Accent Gold', value: 'rgba(201,154,59,1)' }],
      fonts: ['Lora'],
    });

    expect(md).toContain('rgba(201,154,59,1)');
    expect(md).toContain('Accent Gold');
    expect(md).toContain('Lora');
    expect(md).toContain('TODO (human)');
    expect(md).toContain('123 Maple St');
  });

  it('new-design brief is a clearly-marked placeholder', () => {
    const md = buildNewDesignBriefSkeleton();

    expect(md).toContain('Placeholder');
    expect(md).toContain('Phase 2');
  });
});
