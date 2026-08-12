/**
 * The stable identifier for an AI employee.
 *
 * Deliberately its own module with NO imports. The obvious home for this is
 * the /api/admin/personas route beside its only caller — but then a unit test
 * would have to import that route, which pulls in the database client and
 * opens a connection at module load. A pure function that decides an
 * identifier should be testable without Postgres running.
 */

/**
 * "Noah" -> "noah", "Dr. Ada Lovelace" -> "dr-ada-lovelace".
 *
 * 🔴 This is the key a seed or an import upserts on. If its output ever
 * changes for a name that already exists, the next run inserts a SECOND
 * persona instead of updating the first — and the duplicate is invisible until
 * two identical-looking employees show up in the picker.
 */
export function personaSlug(name: string): string {
  return String(name ?? '')
    .normalize('NFKD')
    // Strip combining marks so "José" becomes "jose", not "jos".
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    // Truncation can leave a trailing hyphen behind; a slug must not end in one.
    .replace(/-+$/, '');
}
