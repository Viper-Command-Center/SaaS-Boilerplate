import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { uniqueName } from '@/libs/storage/zip';

describe('files zip download (2026-09-08)', () => {
  it('dedupes entry names and strips path characters', () => {
    const taken = new Set<string>();

    expect(uniqueName('page.png', taken)).toBe('page.png');
    expect(uniqueName('page.png', taken)).toBe('page (2).png');
    expect(uniqueName('page.png', taken)).toBe('page (3).png');
    expect(uniqueName('../a/b:c.md', taken)).toBe('-a-b-c.md');
  });

  it('streams a zip whose entries are promises (what the route does)', async () => {
    const zip = new JSZip();
    zip.file('a.txt', Promise.resolve(Buffer.from('hello')), { compression: 'STORE' });
    zip.file('b.txt', Promise.resolve(Buffer.from('world')), { compression: 'STORE' });
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'STORE' })
        .on('data', (c: Buffer) => chunks.push(c))
        .on('end', resolve)
        .on('error', reject);
    });
    const back = await JSZip.loadAsync(Buffer.concat(chunks));

    expect(Object.keys(back.files).sort()).toEqual(['a.txt', 'b.txt']);
    expect(await back.file('b.txt')!.async('string')).toBe('world');
  });
});
