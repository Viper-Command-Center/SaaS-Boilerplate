import type { BatchPost, Prober } from './socialBatch';
import { describe, expect, it } from 'vitest';
import {

  checkBatch,
  hashtagCount,
  instagramRatioProblem,
  lintCaption,
  normalisePlatform,

  scheduleProblem,
} from './socialBatch';

const NOW = Date.parse('2026-10-08T12:00:00-04:00');
const ok: Prober = async () => ({ status: 200, contentType: 'image/png', length: 1000 });
const post = (over: Partial<BatchPost> = {}): BatchPost => ({
  id: 'p1',
  platform: 'x',
  scheduled_for: '2026-10-12T09:00:00-04:00',
  caption: 'Hello there',
  ...over,
});
const run = (posts: BatchPost[], probe: Prober = ok) => checkBatch(posts, { tenantId: 't1', now: NOW, probe });

describe('pure helpers', () => {
  it('normalises platform aliases', () => {
    expect(normalisePlatform('Twitter')).toBe('x');
    expect(normalisePlatform('IG')).toBe('instagram');
  });

  it('counts hashtags', () => {
    expect(hashtagCount('a #one #two, #three')).toBe(3);
    expect(hashtagCount('no tags, price is $5#')).toBe(0);
  });

  it('flags bad schedules', () => {
    expect(scheduleProblem('2026-10-12T09:00:00', NOW, 10)).toMatch(/UTC offset/);
    expect(scheduleProblem('2026-10-01T09:00:00-04:00', NOW, 10)).toMatch(/past/);
    expect(scheduleProblem('2027-01-01T09:00:00-04:00', NOW, 10)).toMatch(/days ahead/);
    expect(scheduleProblem('2026-10-12T09:00:00-04:00', NOW, 10)).toBeNull();
  });

  it('checks the Instagram ratio', () => {
    expect(instagramRatioProblem(1080, 1350)).toBeNull();
    expect(instagramRatioProblem(1080, 1920)).toMatch(/4:5/);
  });

  it('lints risky wording but allows a disclaimed tax post', () => {
    expect(lintCaption('Guaranteed savings!').length).toBeGreaterThan(0);
    expect(lintCaption('I saved $400 a month').length).toBeGreaterThan(0);
    expect(lintCaption('Tax season tips').length).toBe(1);
    expect(lintCaption('Tax season tips. Informational, not advice.')).toEqual([]);
    expect(lintCaption('Tax tips', { disclaimerOnScreen: true })).toEqual([]);
  });
});

describe('checkBatch', () => {
  it('passes a clean text post', async () => {
    const r = await run([post()]);

    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.notChecked.length).toBeGreaterThan(0);
  });

  it('refuses Instagram/TikTok/YouTube/Pinterest with no media', async () => {
    const r = await run(['instagram', 'tiktok', 'youtube', 'pinterest'].map((p, i) => post({ id: `m${i}`, platform: p })));

    expect(r.ok).toBe(false);
    expect(r.errors.filter(e => /requires media/.test(e.problem))).toHaveLength(4);
  });

  it('refuses over-length captions and unknown platforms', async () => {
    const r = await run([post({ caption: 'x'.repeat(281) }), post({ id: 'z', platform: 'myspace' })]);

    expect(r.errors.some(e => /280/.test(e.problem))).toBe(true);
    expect(r.errors.some(e => /Unknown platform/.test(e.problem))).toBe(true);
  });

  it('refuses a 404 and a non-media URL', async () => {
    const r404 = await run([post({ platform: 'tiktok', media: [{ url: 'https://example.com/a.mp4' }] })], async () => ({ status: 404, contentType: '', length: null }));

    expect(r404.errors.some(e => /HTTP 404/.test(e.problem))).toBe(true);

    const rHtml = await run([post({ platform: 'tiktok', media: [{ url: 'https://example.com/a' }] })], async () => ({ status: 200, contentType: 'text/html', length: 10 }));

    expect(rHtml.errors.some(e => /not an image or video/.test(e.problem))).toBe(true);
  });

  it('refuses a declared/actual type mismatch and a private URL', async () => {
    const r = await run([post({ platform: 'tiktok', media: [{ url: 'https://example.com/a.png', type: 'video' }] })]);

    expect(r.errors.some(e => /declared video/.test(e.problem))).toBe(true);

    const priv = await run([post({ platform: 'tiktok', media: [{ url: 'http://localhost/a.mp4' }] })]);

    expect(priv.ok).toBe(false);
  });

  it('refuses another workspace\'s library file', async () => {
    process.env.R2_PUBLIC_URL = 'https://files.example.com';
    const foreign = await run([post({ platform: 'tiktok', media: [{ url: 'https://files.example.com/tenants/other/a.mp4' }] })]);

    expect(foreign.errors.some(e => /DIFFERENT workspace/.test(e.problem))).toBe(true);

    const own = await run([post({ platform: 'tiktok', media: [{ url: 'https://files.example.com/tenants/t1/a.mp4' }] })]);

    expect(own.errors).toEqual([]);

    delete process.env.R2_PUBLIC_URL;
  });

  it('warns on close spacing and duplicate captions', async () => {
    const r = await run([
      post({ id: 'a', scheduled_for: '2026-10-12T09:00:00-04:00' }),
      post({ id: 'b', scheduled_for: '2026-10-12T10:00:00-04:00' }),
    ]);

    expect(r.warnings.some(w => /3 hours/.test(w.problem))).toBe(true);
    expect(r.warnings.some(w => /Identical caption/.test(w.problem))).toBe(true);
    expect(r.ok).toBe(true);
  });

  it('notes AI-generated content and empty input', async () => {
    const r = await run([post({ ai_generated: true })]);

    expect(r.info).toHaveLength(1);
    expect((await run([])).ok).toBe(false);
  });
});
