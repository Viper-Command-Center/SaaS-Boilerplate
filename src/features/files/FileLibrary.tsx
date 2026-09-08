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
  folder: string | null;
};

const ROOT = '';

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
  // Multi-select (2026-09-08): an agent makes 30 pages; the owner needs all
  // 30 on disk. Selection → one zip, or one bulk delete.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [zipping, setZipping] = useState(false);
  // Folders (Phase 40): one level, a folder exists when a file is in it. The
  // current folder scopes the list, the upload and "select all"; a folder the
  // user just created (still empty) lives in `draftFolders` until a file lands.
  const [folders, setFolders] = useState<string[]>([]);
  const [draftFolders, setDraftFolders] = useState<string[]>([]);
  const [folder, setFolder] = useState<string | null>(null); // null = everything, ROOT = unfiled only
  const [moving, setMoving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => {
    fetch(`/api/files?tenant=${encodeURIComponent(props.tenantSlug)}`)
      .then(r => (r.ok ? r.json() : { files: [] }))
      .then((d) => {
        setItems(d.files ?? []);
        setFolders(d.folders ?? []);
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

        const folderQs = folder ? `&folder=${encodeURIComponent(folder)}` : '';
        const startRes = await fetch(`/api/files/upload?tenant=${tenant}${folderQs}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: file.name, sizeBytes: file.size }),
        });

        const start = await startRes.json().catch(() => null);
        if (!startRes.ok) {
          throw new Error(start?.error ?? 'Could not start the upload.');
        }

        // 2. the bytes go browser → Cloudflare, not through us

        await putToR2(start.uploadUrl, file, pct => setProgress({ name: file.name, pct }));

        // 3. index it (HEAD proves it landed)

        const doneRes = await fetch(`/api/files/upload?tenant=${tenant}${folderQs}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: start.key, name: file.name, mime: file.type }),
        });
        if (!doneRes.ok) {
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

  const shown = items
    .filter(i => (tab === 'all' ? true : tab === 'asset' ? i.kind === 'asset' : i.kind !== 'asset'))
    .filter(i => (folder === null ? true : folder === ROOT ? i.folder === null : i.folder === folder));
  const allFolders = [...new Set([...folders, ...draftFolders])].sort((a, b) => a.localeCompare(b));
  const countIn = (f: string | null) => items.filter(i => (f === ROOT ? i.folder === null : i.folder === f)).length;
  const tenant = encodeURIComponent(props.tenantSlug);
  const contentUrl = (f: Item, download = false) => `/api/files/${f.id}/content?tenant=${tenant}${download ? '&download=1' : ''}`;
  const shownSelected = shown.filter(f => selected.has(f.id));
  const allShownSelected = shown.length > 0 && shownSelected.length === shown.length;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };
  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allShownSelected) {
        shown.forEach(f => next.delete(f.id));
      } else {
        shown.forEach(f => next.add(f.id));
      }
      return next;
    });
  };

  const downloadSelected = async () => {
    const ids = shownSelected.map(f => f.id);
    if (ids.length === 0) {
      return;
    }
    if (ids.length === 1) {
      window.location.href = contentUrl(shownSelected[0]!, true);
      return;
    }
    setZipping(true);
    setError(null);
    try {
      const res = await fetch(`/api/files/download?tenant=${tenant}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `Download failed (HTTP ${res.status}).`);
      }
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? `${props.tenantSlug}-files.zip`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed.');
    } finally {
      setZipping(false);
    }
  };

  const createFolder = () => {
    // eslint-disable-next-line no-alert
    const name = window.prompt('Folder name (e.g. "Halloween book"):')?.replace(/[\\/]+/g, ' ').trim().slice(0, 80);
    if (!name) {
      return;
    }
    const existing = allFolders.find(f => f.toLowerCase() === name.toLowerCase());
    if (!existing) {
      setDraftFolders(prev => [...prev, name]);
    }
    setFolder(existing ?? name);
    setSelected(new Set());
  };

  const moveSelected = async (target: string | null) => {
    const ids = shownSelected.map(f => f.id);
    if (ids.length === 0) {
      return;
    }
    setMoving(true);
    setError(null);
    const res = await fetch(`/api/files?tenant=${tenant}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, folder: target }),
    }).catch(() => null);
    setMoving(false);
    if (!res?.ok) {
      setError('Could not move the files.');
      return;
    }
    setSelected(new Set());
    reload();
  };

  const removeSelected = async () => {
    const targets = shownSelected;
    if (targets.length === 0) {
      return;
    }
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete ${targets.length} file${targets.length === 1 ? '' : 's'}? This removes them from storage.`)) {
      return;
    }
    setBusy(true);
    for (const item of targets) {
      await fetch(`/api/files?tenant=${tenant}&id=${encodeURIComponent(item.id)}`, { method: 'DELETE' }).catch(() => {});
    }
    setSelected((prev) => {
      const next = new Set(prev);
      targets.forEach(f => next.delete(f.id));
      return next;
    });
    setBusy(false);
    reload();
  };

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
              className={`
                rounded-lg px-3 py-1.5 text-xs font-medium
                ${
            tab === x.id
              ? 'grad-fill text-white'
              : `
                border border-white/12 text-white/50
                hover:bg-white/5
              `
            }
              `}
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
              className="
                grad-fill h-full rounded-full transition-[width] duration-200
              "
              style={{ width: `${progress.pct}%` }}
            />
          </div>
        </div>
      )}

      {error && <p className="text-sm text-rose-400" role="alert">{error}</p>}

      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {([
          { key: null, label: `All files (${items.length})` },
          { key: ROOT, label: `Unfiled (${countIn(ROOT)})` },
          ...allFolders.map(f => ({ key: f, label: `📁 ${f} (${countIn(f)})` })),
        ] as Array<{ key: string | null; label: string }>).map(x => (
          <button
            key={x.key ?? '__all'}
            type="button"
            onClick={() => {
              setFolder(x.key);
              setSelected(new Set());
            }}
            className={`
              rounded-lg px-2.5 py-1
              ${folder === x.key
            ? `bg-white/12 text-white`
            : `
              text-white/55
              hover:bg-white/5
            `}
            `}
          >
            {x.label}
          </button>
        ))}
        {props.canWrite && (
          <button
            type="button"
            onClick={createFolder}
            className="
              rounded-lg border border-dashed border-white/15 px-2.5 py-1
              text-white/55
              hover:bg-white/5
            "
          >
            + New folder
          </button>
        )}
        {folder && (
          <span className="ml-auto text-white/35">
            Uploads go into “
            {folder}
            ”
          </span>
        )}
      </div>

      {shown.length > 0 && (
        <div className="
          flex flex-wrap items-center gap-3 px-1 text-xs text-white/60
        "
        >
          <label className="flex cursor-pointer items-center gap-2">
            <input type="checkbox" checked={allShownSelected} onChange={toggleAll} aria-label="Select all shown files" />
            {allShownSelected ? 'Clear selection' : `Select all ${shown.length}`}
          </label>
          {shownSelected.length > 0 && (
            <>
              <span className="text-white/40">
                {shownSelected.length}
                {' '}
                selected ·
                {' '}
                {size(shownSelected.reduce((n, f) => n + f.sizeBytes, 0))}
              </span>
              <Button size="sm" disabled={zipping} onClick={downloadSelected}>
                {zipping ? 'Preparing zip…' : shownSelected.length === 1 ? 'Download' : `Download ${shownSelected.length} as zip`}
              </Button>
              {props.canWrite && (
                <>
                  <select
                    aria-label="Move selected files to folder"
                    className="
                      rounded-md border border-white/12 bg-white/5 px-2 py-1
                      text-xs text-white/80
                    "
                    value=""
                    disabled={moving}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === '__root') {
                        moveSelected(null);
                      } else if (v === '__new') {
                        // eslint-disable-next-line no-alert
                        const name = window.prompt('New folder name:')?.trim().slice(0, 80);
                        if (name) {
                          moveSelected(name);
                        }
                      } else if (v) {
                        moveSelected(v);
                      }
                    }}
                  >
                    <option value="">{moving ? 'Moving…' : 'Move to…'}</option>
                    <option value="__root">Unfiled (root)</option>
                    {allFolders.map(f => <option key={f} value={f}>{f}</option>)}
                    <option value="__new">+ New folder…</option>
                  </select>
                  <Button size="sm" variant="outline" disabled={busy} onClick={removeSelected}>
                    Delete selected
                  </Button>
                </>
              )}
            </>
          )}
        </div>
      )}

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
              <div
                key={f.id}
                className={`
                  flex items-center gap-3 px-4 py-3
                  ${selected.has(f.id)
                ? `bg-white/3`
                : ''}
                `}
              >
                <input
                  type="checkbox"
                  className="shrink-0"
                  checked={selected.has(f.id)}
                  onChange={() => toggle(f.id)}
                  aria-label={`Select ${f.name}`}
                />
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
                        rounded-sm bg-fuchsia-400/15 px-1.5 py-0.5 text-[10px]
                        text-fuchsia-300
                      "
                      >
                        {f.source}
                      </span>
                    )}
                    {folder === null && f.folder && (
                      <span className="
                        rounded-sm bg-white/8 px-1.5 py-0.5 text-[10px]
                        text-white/55
                      "
                      >
                        📁
                        {' '}
                        {f.folder}
                      </span>
                    )}
                    {f.hasText && (
                      <span className="
                        rounded-sm bg-emerald-400/15 px-1.5 py-0.5 text-[10px]
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
                  <a
                    href={contentUrl(f, true)}
                    download={f.name}
                    className="
                      rounded-lg border border-white/12 px-2.5 py-1 text-xs
                      text-white/70
                      hover:bg-white/5
                    "
                  >
                    Download
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
