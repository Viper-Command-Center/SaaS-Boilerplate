'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

type Item = {
  id: string;
  name: string;
  kind: string;
  mime: string | null;
  sizeBytes: number;
  publicUrl: string | null;
  source: string;
  hasText: boolean;
  createdAt: string;
};

const KB = 1024;
const GB = KB * KB * KB;
/** R2's single-PUT ceiling. Plenty for HeyGen renders and raw footage. */
const MAX_UPLOAD_BYTES = 5 * GB;

function size(bytes: number): string {
  if (bytes < KB) {
    return `${bytes} B`;
  }
  if (bytes < KB * KB) {
    return `${Math.round(bytes / KB)} KB`;
  }
  if (bytes < GB) {
    return `${(bytes / (KB * KB)).toFixed(1)} MB`;
  }
  return `${(bytes / GB).toFixed(2)} GB`;
}

const isImage = (m: string | null) => Boolean(m?.startsWith('image/'));

export const FileLibrary = (props: { tenantSlug: string; canWrite: boolean }) => {
  const [items, setItems] = useState<Item[]>([]);
  const [configured, setConfigured] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'all' | 'knowledge' | 'asset'>('all');
  const [progress, setProgress] = useState<{ name: string; pct: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => {
    fetch(`/api/files?tenant=${encodeURIComponent(props.tenantSlug)}`)
      .then(r => (r.ok ? r.json() : { files: [] }))
      .then((d) => {
        setItems(d.files ?? []);
        setConfigured(d.storageConfigured !== false);
      })
      .catch(() => {});
  }, [props.tenantSlug]);

  useEffect(() => {
    reload();
  }, [reload]);

  /** PUT straight to R2 so the app server never carries the bytes. */
  const putToR2 = (url: string, file: File, onProgress: (pct: number) => void) =>
    new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      if (file.type) {
        xhr.setRequestHeader('Content-Type', file.type);
      }
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      };
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Storage rejected the upload (HTTP ${xhr.status}).`)));
      xhr.onerror = () => reject(new Error('Network error during upload. If this persists, check the bucket CORS policy allows PUT.'));
      xhr.send(file);
    });

  const upload = async (files: FileList | null) => {
    if (!files?.length) {
      return;
    }
    setBusy(true);
    setError(null);

    const tenant = encodeURIComponent(props.tenantSlug);

    for (const file of Array.from(files)) {
      if (file.size > MAX_UPLOAD_BYTES) {
        setError(`"${file.name}" is ${(file.size / GB).toFixed(1)}GB — the limit is 5GB.`);
        break;
      }

      try {
        setProgress({ name: file.name, pct: 0 });

        // 1. reserve a key + presigned URL
        // eslint-disable-next-line no-await-in-loop
        const startRes = await fetch(`/api/files/upload?tenant=${tenant}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: file.name, sizeBytes: file.size }),
        });
        // eslint-disable-next-line no-await-in-loop
        const start = await startRes.json().catch(() => null);
        if (!startRes.ok) {
          throw new Error(start?.error ?? 'Could not start the upload.');
        }

        // 2. the bytes go browser → Cloudflare, not through us
        // eslint-disable-next-line no-await-in-loop
        await putToR2(start.uploadUrl, file, pct => setProgress({ name: file.name, pct }));

        // 3. index it (HEAD proves it landed)
        // eslint-disable-next-line no-await-in-loop
        const doneRes = await fetch(`/api/files/upload?tenant=${tenant}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: start.key, name: file.name, mime: file.type }),
        });
        if (!doneRes.ok) {
          // eslint-disable-next-line no-await-in-loop
          const d = await doneRes.json().catch(() => null);
          throw new Error(d?.error ?? 'Upload finished but could not be saved.');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : `Could not upload ${file.name}.`);
        break;
      }
    }

    setProgress(null);
    setBusy(false);
    if (inputRef.current) {
      inputRef.current.value = '';
    }
    reload();
  };

  const remove = async (item: Item) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete "${item.name}"? This removes it from storage.`)) {
      return;
    }
    await fetch(
      `/api/files?tenant=${encodeURIComponent(props.tenantSlug)}&id=${encodeURIComponent(item.id)}`,
      { method: 'DELETE' },
    ).catch(() => {});
    reload();
  };

  const shown = items.filter(i => (tab === 'all' ? true : tab === 'asset' ? i.kind === 'asset' : i.kind !== 'asset'));

  const tabs: Array<{ id: typeof tab; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'knowledge', label: 'Documents' },
    { id: 'asset', label: 'Generated media' },
  ];

  return (
    <div className="space-y-4">
      {!configured && (
        <p className="glass p-4 text-sm text-amber-300">
          Storage isn&apos;t configured yet — add the R2 variables (R2_ENDPOINT,
          R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY) in Railway and
          redeploy.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1.5">
          {tabs.map(x => (
            <button
              key={x.id}
              type="button"
              onClick={() => setTab(x.id)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
                tab === x.id ? 'grad-fill text-white' : 'border border-white/12 text-white/50 hover:bg-white/5'
              }`}
            >
              {x.label}
            </button>
          ))}
        </div>

        {props.canWrite && (
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              type="file"
              multiple
              className="hidden"
              onChange={e => upload(e.target.files)}
            />
            <Button size="sm" disabled={busy || !configured} onClick={() => inputRef.current?.click()}>
              {busy ? 'Uploading…' : 'Upload files'}
            </Button>
          </div>
        )}
      </div>

      {progress && (
        <div className="glass p-3">
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <span className="truncate text-white/70">{progress.name}</span>
            <span className="text-white/45">
              {progress.pct}
              %
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/8">
            <div
              className="grad-fill h-full rounded-full transition-[width] duration-200"
              style={{ width: `${progress.pct}%` }}
            />
          </div>
        </div>
      )}

      {error && <p className="text-sm text-rose-400" role="alert">{error}</p>}

      <div className="glass glass-topline relative divide-y divide-white/6">
        {shown.length === 0
          ? (
              <div className="px-4 py-10 text-center">
                <p className="text-sm text-white/60">Nothing here yet.</p>
                <p className="mx-auto mt-1 max-w-md text-xs text-white/35">
                  Upload the brief, brand guide or list of changes you&apos;d normally
                  paste into chat — then just tell the agent to read it. Anything it
                  generates (images, video, reports) lands here automatically.
                </p>
              </div>
            )
          : shown.map(f => (
              <div key={f.id} className="flex items-center gap-3 px-4 py-3">
                <div className="
                  flex size-10 shrink-0 items-center justify-center
                  overflow-hidden rounded-lg bg-white/5 text-xs text-white/40
                "
                >
                  {isImage(f.mime)
                    ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={f.publicUrl ?? `/api/files/${f.id}/content?tenant=${encodeURIComponent(props.tenantSlug)}`}
                          alt=""
                          className="size-full object-cover"
                        />
                      )
                    : (f.mime?.split('/')[1] ?? 'file').slice(0, 4)}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-white">{f.name}</span>
                    {f.kind === 'asset' && (
                      <span className="
                        rounded bg-fuchsia-400/15 px-1.5 py-0.5 text-[10px]
                        text-fuchsia-300
                      "
                      >
                        {f.source}
                      </span>
                    )}
                    {f.hasText && (
                      <span className="
                        rounded bg-emerald-400/15 px-1.5 py-0.5 text-[10px]
                        text-emerald-300
                      "
                      >
                        agent-readable
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-white/35">
                    {size(f.sizeBytes)}
                    {' · '}
                    {new Date(f.createdAt).toLocaleString()}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <a
                    href={f.publicUrl ?? `/api/files/${f.id}/content?tenant=${encodeURIComponent(props.tenantSlug)}`}
                    target="_blank"
                    rel="noreferrer"
                    className="
                      rounded-lg border border-white/12 px-2.5 py-1 text-xs
                      text-white/70
                      hover:bg-white/5
                    "
                  >
                    Open
                  </a>
                  {props.canWrite && (
                    <button
                      type="button"
                      onClick={() => remove(f)}
                      className="
                        rounded-lg border border-white/12 px-2.5 py-1 text-xs
                        text-white/50
                        hover:bg-white/5
                      "
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            ))}
      </div>
    </div>
  );
};
