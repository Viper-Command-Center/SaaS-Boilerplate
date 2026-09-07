/**
 * Book rows — tenant-scoped CRUD. Every read takes the tenantId so one
 * workspace can never touch another's book by guessing an id (same rule as
 * files.ts). Nothing here renders; see interior.ts / cover.ts.
 */

import type { InkType, PaperType, TrimSize } from './kdp';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/libs/DB';
import { books } from '@/models/Schema';
import { parseTrim } from './kdp';

export type BookPage
  = | { kind: 'art'; fileId: string; label?: string }
    | { kind: 'text'; heading?: string; lines?: string[]; label?: string }
    | { kind: 'blank' };

export type BookCover = {
  frontArtFileId?: string;
  backArtFileId?: string;
  background?: string;
  spineColor?: string;
  textColor?: string;
  blurb?: string;
  spineText?: boolean;
  titlePosition?: 'top' | 'bottom';
  titleBand?: boolean;
  backFooter?: string;
  /** The front art already carries title/author (a finished Canva cover): draw NO text on the front. */
  frontArtIsFinal?: boolean;
};

export type BookListing = {
  description?: string;
  keywords?: string[];
  categories?: string[];
  priceUsd?: number;
  language?: string;
  ageRange?: string;
};

export type BookKind = 'coloring' | 'illustrated' | 'text';

export type Book = {
  id: string;
  tenantId: string;
  title: string;
  subtitle: string | null;
  author: string | null;
  kind: BookKind;
  trim: TrimSize;
  bleed: boolean;
  paper: PaperType;
  ink: InkType;
  singleSided: boolean;
  pages: BookPage[];
  cover: BookCover;
  listing: BookListing;
  status: 'draft' | 'ready' | 'published';
  interiorFileId: string | null;
  coverFileId: string | null;
  coverPreviewFileId: string | null;
  lastPreflight: unknown;
  createdAt: Date;
  updatedAt: Date;
};

type Row = typeof books.$inferSelect;

function toBook(r: Row): Book {
  const trim = parseTrim({ widthIn: Number(r.trimWidthIn), heightIn: Number(r.trimHeightIn) })!;
  return {
    id: r.id,
    tenantId: r.tenantId,
    title: r.title,
    subtitle: r.subtitle,
    author: r.author,
    kind: (r.kind as BookKind) ?? 'coloring',
    trim,
    bleed: r.bleed,
    paper: r.paper as PaperType,
    ink: r.ink as InkType,
    singleSided: r.singleSided,
    pages: Array.isArray(r.pages) ? (r.pages as BookPage[]) : [],
    cover: (r.cover ?? {}) as BookCover,
    listing: (r.listing ?? {}) as BookListing,
    status: r.status as Book['status'],
    interiorFileId: r.interiorFileId,
    coverFileId: r.coverFileId,
    coverPreviewFileId: r.coverPreviewFileId,
    lastPreflight: r.lastPreflight,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export async function listBooks(tenantId: string): Promise<Book[]> {
  const rows = await db.select().from(books).where(eq(books.tenantId, tenantId)).orderBy(desc(books.updatedAt)).limit(100);
  return rows.map(toBook);
}

export async function getBook(tenantId: string, id: string): Promise<Book | null> {
  const [row] = await db.select().from(books).where(and(eq(books.tenantId, tenantId), eq(books.id, id))).limit(1);
  return row ? toBook(row) : null;
}

/** Agents reason in titles; accept an id OR an exact (case-insensitive) title. */
export async function resolveBook(tenantId: string, ref: string): Promise<Book> {
  const value = ref.trim();
  if (!value) {
    throw new Error('Which book? Pass its id or exact title (list_books shows both).');
  }
  if (/^[0-9a-f-]{36}$/i.test(value)) {
    const b = await getBook(tenantId, value);
    if (b) {
      return b;
    }
  }
  const all = await listBooks(tenantId);
  const hit = all.find(b => b.title.toLowerCase() === value.toLowerCase());
  if (!hit) {
    throw new Error(`No book called "${value}" in this workspace. Existing books: ${all.map(b => `"${b.title}" (${b.id})`).join(', ') || 'none — create one with create_book'}.`);
  }
  return hit;
}

export async function createBook(a: {
  tenantId: string;
  title: string;
  subtitle?: string;
  author?: string;
  kind: BookKind;
  trim: TrimSize;
  bleed: boolean;
  paper: PaperType;
  ink: InkType;
  singleSided: boolean;
  createdBy?: string;
}): Promise<Book> {
  const [row] = await db
    .insert(books)
    .values({
      tenantId: a.tenantId,
      title: a.title.slice(0, 300),
      subtitle: a.subtitle?.slice(0, 300) ?? null,
      author: a.author?.slice(0, 200) ?? null,
      kind: a.kind,
      trimWidthIn: String(a.trim.widthIn),
      trimHeightIn: String(a.trim.heightIn),
      bleed: a.bleed,
      paper: a.paper,
      ink: a.ink,
      singleSided: a.singleSided,
      createdBy: a.createdBy,
    })
    .returning();
  return toBook(row!);
}

export type BookPatch = Partial<{
  title: string;
  subtitle: string | null;
  author: string | null;
  kind: BookKind;
  trim: TrimSize;
  bleed: boolean;
  paper: PaperType;
  ink: InkType;
  singleSided: boolean;
  pages: BookPage[];
  cover: BookCover;
  listing: BookListing;
  status: Book['status'];
  interiorFileId: string | null;
  coverFileId: string | null;
  coverPreviewFileId: string | null;
  lastPreflight: unknown;
}>;

export async function updateBook(tenantId: string, id: string, patch: BookPatch): Promise<Book> {
  const set: Partial<typeof books.$inferInsert> = { updatedAt: new Date() };
  if (patch.title !== undefined) {
    set.title = patch.title.slice(0, 300);
  }
  if (patch.subtitle !== undefined) {
    set.subtitle = patch.subtitle?.slice(0, 300) ?? null;
  }
  if (patch.author !== undefined) {
    set.author = patch.author?.slice(0, 200) ?? null;
  }
  if (patch.kind !== undefined) {
    set.kind = patch.kind;
  }
  if (patch.trim !== undefined) {
    set.trimWidthIn = String(patch.trim.widthIn);
    set.trimHeightIn = String(patch.trim.heightIn);
  }
  if (patch.bleed !== undefined) {
    set.bleed = patch.bleed;
  }
  if (patch.paper !== undefined) {
    set.paper = patch.paper;
  }
  if (patch.ink !== undefined) {
    set.ink = patch.ink;
  }
  if (patch.singleSided !== undefined) {
    set.singleSided = patch.singleSided;
  }
  if (patch.pages !== undefined) {
    set.pages = patch.pages;
  }
  if (patch.cover !== undefined) {
    set.cover = patch.cover;
  }
  if (patch.listing !== undefined) {
    set.listing = patch.listing;
  }
  if (patch.status !== undefined) {
    set.status = patch.status;
  }
  if (patch.interiorFileId !== undefined) {
    set.interiorFileId = patch.interiorFileId;
  }
  if (patch.coverFileId !== undefined) {
    set.coverFileId = patch.coverFileId;
  }
  if (patch.coverPreviewFileId !== undefined) {
    set.coverPreviewFileId = patch.coverPreviewFileId;
  }
  if (patch.lastPreflight !== undefined) {
    set.lastPreflight = patch.lastPreflight;
  }
  const [row] = await db
    .update(books)
    .set(set)
    .where(and(eq(books.tenantId, tenantId), eq(books.id, id)))
    .returning();
  if (!row) {
    throw new Error('Book not found in this workspace.');
  }
  return toBook(row);
}

export async function deleteBook(tenantId: string, id: string): Promise<boolean> {
  const rows = await db.delete(books).where(and(eq(books.tenantId, tenantId), eq(books.id, id))).returning({ id: books.id });
  return rows.length > 0;
}
