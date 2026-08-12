/**
 * The persona slug is the stable key a seed or an import upserts on. If this
 * function's output ever changes for an existing name, the next import creates
 * a SECOND copy instead of updating the first — and the duplicate is invisible
 * until two identical-looking employees appear in the picker.
 */

import { describe, expect, it } from 'vitest';
import { personaSlug as slugify } from '@/libs/agent/personaSlug';

describe('slugify', () => {
  it.each([
    ['Noah', 'noah'],
    ['Max', 'max'],
    ['Nia', 'nia'],
    ['Ada Lovelace', 'ada-lovelace'],
    ['Dr. Ada Lovelace', 'dr-ada-lovelace'],
    ['  Spaced  Out  ', 'spaced-out'],
    ['Anne-Marie', 'anne-marie'],
    ['C3PO', 'c3po'],
  ])('%j becomes %j', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  // Accented names must not lose their letters — "José" becoming "jos" would
  // be a different person's identifier.
  it('folds accents rather than dropping the letter', () => {
    expect(slugify('José')).toBe('jose');
    expect(slugify('Zoë')).toBe('zoe');
    expect(slugify('Renée Über')).toBe('renee-uber');
  });

  it('collapses punctuation runs instead of leaving empty segments', () => {
    expect(slugify('Sam // Ops')).toBe('sam-ops');
    expect(slugify('!!!Nia!!!')).toBe('nia');
  });

  // The column is varchar(60). A longer name must be truncated here rather
  // than by the database, which would reject the insert outright.
  it('truncates to the column width', () => {
    expect(slugify('a'.repeat(100))).toHaveLength(60);
  });

  // The route treats an empty slug as a 400 with a readable message, so this
  // must return empty rather than something arbitrary.
  it.each(['', '   ', '!!!', '日本語'])('returns empty for %j so the route can explain why', (input) => {
    expect(slugify(input)).toBe('');
  });

  it('is stable — the same name always yields the same key', () => {
    expect(slugify('Noah')).toBe(slugify('Noah'));
    expect(slugify('Noah')).toBe(slugify(' noah '));
  });
});
