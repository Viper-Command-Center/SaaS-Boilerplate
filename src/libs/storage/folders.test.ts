import { describe, expect, it } from 'vitest';
import { normaliseFolder } from '@/libs/storage/files';

describe('library folders (Phase 40)', () => {
  it('normalises names: trims, collapses, strips slashes, empty → root', () => {
    expect(normaliseFolder('  Halloween  book ')).toBe('Halloween book');
    expect(normaliseFolder('a/b\\c')).toBe('a b c');
    expect(normaliseFolder('')).toBeNull();
    expect(normaliseFolder(undefined)).toBeNull();
    expect(normaliseFolder(null)).toBeNull();
    expect(normaliseFolder('x'.repeat(200))).toHaveLength(80);
  });
});
