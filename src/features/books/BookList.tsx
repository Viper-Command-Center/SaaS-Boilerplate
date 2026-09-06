import Link from 'next/link';

export type BookRow = {
  id: string;
  title: string;
  subtitle: string | null;
  author: string | null;
  kind: string;
  trim: string;
  bleed: boolean;
  paper: string;
  ink: string;
  singleSided: boolean;
  logicalPages: number;
  status: string;
  interiorFileId: string | null;
  coverFileId: string | null;
  coverPreviewFileId: string | null;
  preflight: { ok?: boolean; errors?: number; warnings?: number } | null;
  updatedAt: string;
};

const STATUS: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground',
  ready: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  published: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200',
};

/**
 * Read-only on purpose: pages, cover and listing are edited through the
 * agent (it is the only path that runs preflight and keeps the spine width
 * in step with the page count). This page answers "where is my book and
 * what do I download".
 */
export const BookList = (props: { tenantSlug: string; books: BookRow[] }) => {
  if (props.books.length === 0) {
    return (
      <div className="
        rounded-lg border border-dashed p-8 text-center text-sm
        text-muted-foreground
      "
      >
        No books yet. Tell the agent something like
        {' '}
        <span className="font-medium text-foreground">“Start an 8.5x8.5 coloring book called Happy Cats”</span>
        {' '}
        and it will create the project, then add pages from your uploads or generate new ones.
      </div>
    );
  }

  return (
    <div className="
      grid gap-4
      md:grid-cols-2
    "
    >
      {props.books.map((b) => {
        const physical = b.logicalPages ? Math.ceil((b.singleSided ? b.logicalPages * 2 : b.logicalPages) / 2) * 2 : 0;
        return (
          <div key={b.id} className="flex gap-4 rounded-lg border bg-card p-4">
            <div className="w-28 shrink-0">
              {b.coverPreviewFileId
                ? (
                    // eslint-disable-next-line next/no-img-element
                    <img
                      src={`/api/files/${b.coverPreviewFileId}/content?tenant=${props.tenantSlug}`}
                      alt={`${b.title} cover`}
                      className="w-28 rounded-sm border object-cover"
                    />
                  )
                : (
                    <div className="
                      flex size-28 items-center justify-center rounded-sm border
                      border-dashed text-xs text-muted-foreground
                    "
                    >
                      no cover yet
                    </div>
                  )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-semibold">{b.title}</div>
                  {b.subtitle && (
                    <div className="truncate text-sm text-muted-foreground">
                      {b.subtitle}
                    </div>
                  )}
                  {b.author && (
                    <div className="text-xs text-muted-foreground">
                      by
                      {' '}
                      {b.author}
                    </div>
                  )}
                </div>
                <span className={`
                  shrink-0 rounded-full px-2 py-0.5 text-xs font-medium
                  ${STATUS[b.status] ?? STATUS.draft}
                `}
                >
                  {b.status}
                </span>
              </div>

              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                <dt className="text-muted-foreground">Trim</dt>
                <dd>
                  {b.trim}
                  {b.bleed ? ' · bleed' : ' · no bleed'}
                </dd>
                <dt className="text-muted-foreground">Interior</dt>
                <dd>
                  {b.ink === 'black' ? 'Black & white' : b.ink === 'color-premium' ? 'Premium colour' : 'Standard colour'}
                  {' · '}
                  {b.paper}
                  {' paper'}
                </dd>
                <dt className="text-muted-foreground">Pages</dt>
                <dd>
                  {b.logicalPages}
                  {' drawn'}
                  {physical ? ` · ${physical} printed${b.singleSided ? ' (single-sided)' : ''}` : ''}
                </dd>
                <dt className="text-muted-foreground">Preflight</dt>
                <dd>
                  {b.preflight
                    ? b.preflight.ok
                      ? `passes${b.preflight.warnings ? ` · ${b.preflight.warnings} warning(s)` : ''}`
                      : `${b.preflight.errors ?? 0} error(s) · ${b.preflight.warnings ?? 0} warning(s)`
                    : 'not run yet'}
                </dd>
              </dl>

              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                {b.interiorFileId && (
                  <a
                    className="
                      rounded-sm border px-2 py-1
                      hover:bg-muted
                    "
                    href={`/api/files/${b.interiorFileId}/content?tenant=${props.tenantSlug}`}
                  >
                    Download interior PDF
                  </a>
                )}
                {b.coverFileId && (
                  <a
                    className="
                      rounded-sm border px-2 py-1
                      hover:bg-muted
                    "
                    href={`/api/files/${b.coverFileId}/content?tenant=${props.tenantSlug}`}
                  >
                    Download cover PDF
                  </a>
                )}
                <Link
                  className="
                    rounded-sm border px-2 py-1
                    hover:bg-muted
                  "
                  href={`/dashboard/agent?t=${props.tenantSlug}`}
                >
                  Open agent
                </Link>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};
