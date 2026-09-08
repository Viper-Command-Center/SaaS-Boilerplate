/** Helpers for the Files-page zip download (see app/api/files/download). */

export const MAX_ZIP_FILES = 300;
export const MAX_ZIP_BYTES = 1024 * 1024 * 1024; // 1 GB — beyond that, two downloads

/** Zip entry names must be unique; "page.png" twice becomes "page (2).png". */
export function uniqueName(name: string, taken: Set<string>): string {
  const clean = name.replace(/[\\/:*?"<>|]+/g, '-').replace(/^\.+/, '').slice(0, 180) || 'file';
  if (!taken.has(clean)) {
    taken.add(clean);
    return clean;
  }
  const dot = clean.lastIndexOf('.');
  const stem = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot) : '';
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  return `${stem}-${Date.now()}${ext}`;
}
