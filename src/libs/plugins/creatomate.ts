/**
 * Creatomate — built-in provider (template-based video / image rendering).
 *
 * WHY THIS EXISTS (2026-10-08, BudgetSmart social pipeline)
 * AI image/video models draw text as pixels, which is where the misspelled
 * headlines came from. The fix is to never generate words: the model supplies
 * the wording, a TEMPLATE with real fonts draws it. Creatomate renders those
 * templates (hook line + HeyGen/Kie clip + captions + end card) into finished
 * vertical video from a plain REST call.
 *
 * WHY A BUILT-IN PROVIDER AND NOT A PLAIN MCP CONNECTION
 * Creatomate's MCP is OAuth; Artivio's MCP client sends static headers only
 * (same wall as HeyGen — see heygen.ts). The REST API takes a project API key
 * as `Authorization: Bearer <key>`, so we wrap that.
 *
 * Endpoints used (base overridable via CREATOMATE_BASE_URL). Verified against
 * creatomate.com/llms/api.md and the render reference pages, Oct 2026:
 *   GET  /v2/templates[?tags=a,b]   compact list (no sources)
 *   GET  /v2/templates/:id          full template incl. `source` (RenderScript)
 *   POST /v2/renders                { template_id, modifications, max_width, … } → 202, one render
 *   GET  /v2/renders/:id            status: planned|waiting|transcribing|rendering|succeeded|failed
 * Limits: 30 requests / 10 s per account; the file at `url` is deleted after
 * 30 days (so the platform archives it to the workspace library).
 *
 * 🔴 THE ANTI-GUESSING DESIGN (Phase 22's lesson, applied from day one)
 * `modifications` is a free-form object whose keys are the TEMPLATE'S element
 * names. A model cannot guess them, and a wrong key is the worst kind of
 * failure: the render succeeds and the change is silently not applied. So
 *   - `template_fields` reads the template's real element names/types/defaults
 *     at call time (no hand-kept table to go stale), and
 *   - `render` checks every modification key against those names BEFORE
 *     spending a credit, and refuses naming the real ones.
 *
 * BILLING: the render object carries no cost field (the docs only say credits
 * are explained in a separate article), so nothing can be metered in-band —
 * Creatomate bills the plan that owns the key. If this is ever resold, set a
 * per-call price rule in Admin → Plugin catalog rather than guessing units.
 *
 * KEY RESOLUTION: the connection's/catalog credential first; if that is blank
 * the platform env CREATOMATE_API_KEY. Either way the key never enters a
 * prompt or a tool result.
 */

import type { BuiltinProvider, BuiltinResult } from '@/libs/plugins/types';

const base = () => (process.env.CREATOMATE_BASE_URL || 'https://api.creatomate.com').replace(/\/$/, '');
const pollMs = () => Math.max(1, Number(process.env.CREATOMATE_POLL_MS) || 4000);
// Routes cap at 300 s; stop just short so a slow render returns its id instead
// of dying with the request.
const MAX_POLL_MS = 270_000;
const MEDIA_TYPES = new Set(['image', 'video', 'audio']);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Pasting "Bearer sk…" is the usual mistake; accept it. */
export function cleanKey(credential: string | undefined): string {
  const fromCredential = (credential ?? '').trim().replace(/^bearer\s+/i, '');
  if (fromCredential) {
    return fromCredential;
  }
  return (process.env.CREATOMATE_API_KEY ?? '').trim().replace(/^bearer\s+/i, '');
}

async function cm(path: string, key: string, init?: RequestInit, retried = false): Promise<any> {
  const resp = await fetch(`${base()}${path}`, {
    ...init,
    signal: AbortSignal.timeout(60_000),
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (resp.status === 429 && !retried) {
    const wait = Math.min(15, Math.max(1, Number(resp.headers.get('Retry-After')) || 2));
    await sleep(wait * 1000);
    return cm(path, key, init, true);
  }
  const text = await resp.text();
  let body: any = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  if (!resp.ok) {
    const hint = body?.hint ?? body?.message ?? body?.error ?? body?.raw ?? JSON.stringify(body).slice(0, 300);
    if (resp.status === 401) {
      throw new Error(`Creatomate 401: the API key was rejected. Use a PROJECT API key from Creatomate → Project Settings → API (${hint}).`);
    }
    if (resp.status === 402) {
      throw new Error(`Creatomate 402: out of render credits on the account that owns this key (${hint}). Nothing was rendered.`);
    }
    if (resp.status === 429) {
      throw new Error('Creatomate 429: rate limit (30 requests / 10 seconds per account) — wait a few seconds and retry.');
    }
    throw new Error(`Creatomate ${resp.status}: ${typeof hint === 'string' ? hint : JSON.stringify(hint)}`);
  }
  return body;
}

// ─── Template introspection (pure — unit-tested) ─────────────────────────────

export type TemplateField = {
  name: string;
  id?: string;
  type: string;
  /** The template's current text / media source, truncated. */
  default?: string;
};

/** Every addressable element in a RenderScript, compositions included. */
export function collectFields(source: unknown): TemplateField[] {
  const out: TemplateField[] = [];
  const walk = (els: unknown) => {
    if (!Array.isArray(els)) {
      return;
    }
    for (const el of els) {
      if (!el || typeof el !== 'object') {
        continue;
      }
      const e = el as Record<string, any>;
      const name = typeof e.name === 'string' ? e.name : '';
      if (name) {
        const raw = typeof e.text === 'string' ? e.text : typeof e.source === 'string' ? e.source : undefined;
        out.push({
          name,
          id: typeof e.id === 'string' ? e.id : undefined,
          type: String(e.type ?? 'unknown'),
          default: raw === undefined ? undefined : raw.length > 120 ? `${raw.slice(0, 117)}...` : raw,
        });
      }
      walk(e.elements);
    }
  };
  walk((source as Record<string, any> | undefined)?.elements);
  return out;
}

/**
 * Returns a problem or null. A key is an element name (or id), optionally with
 * a property path after the first dot. Media elements must be given a public
 * http(s) URL — Creatomate downloads it server-side.
 */
export function checkModifications(fields: TemplateField[], mods: Record<string, unknown>): string | null {
  const known = new Map<string, TemplateField>();
  for (const f of fields) {
    known.set(f.name, f);
    if (f.id) {
      known.set(f.id, f);
    }
  }
  const names = fields.map(f => `${f.name} (${f.type})`).join(', ') || '(none — this template has no named elements)';
  for (const [key, value] of Object.entries(mods)) {
    const root = key.split('.')[0] ?? key;
    const field = known.get(key) ?? known.get(root);
    if (!field) {
      return `"${key}" is not an element of this template, so it would be silently ignored and the render would look unchanged. Elements you can set: ${names}.`;
    }
    const isWholeElement = !key.includes('.');
    if (isWholeElement && MEDIA_TYPES.has(field.type) && typeof value === 'string' && !/^https?:\/\//i.test(value)) {
      return `"${key}" is a ${field.type} element and needs a PUBLIC http(s) URL (a library asset URL from list_files / generate_image / save_file_from_url), not "${value.slice(0, 60)}".`;
    }
  }
  return null;
}

type Template = { fields: TemplateField[]; width?: number; height?: number; duration?: number; format?: string; name?: string };
const templateCache = new Map<string, { at: number; t: Template }>();

async function loadTemplate(key: string, id: string): Promise<Template> {
  const hit = templateCache.get(`${key.slice(-6)}:${id}`);
  if (hit && Date.now() - hit.at < 60_000) {
    return hit.t;
  }
  const body = await cm(`/v2/templates/${encodeURIComponent(id)}`, key);
  const src = body?.source ?? body?.data?.source ?? {};
  const t: Template = {
    fields: collectFields(src),
    width: Number(src.width) || undefined,
    height: Number(src.height) || undefined,
    duration: Number(src.duration) || undefined,
    format: typeof src.output_format === 'string' ? src.output_format : undefined,
    name: typeof body?.name === 'string' ? body.name : undefined,
  };
  templateCache.set(`${key.slice(-6)}:${id}`, { at: Date.now(), t });
  return t;
}

// ─── Render lifecycle ────────────────────────────────────────────────────────

const firstRender = (b: any) => (Array.isArray(b) ? b[0] : b?.data ?? b) as Record<string, any>;

function renderResult(r: Record<string, any>): BuiltinResult {
  const url = typeof r.url === 'string' ? r.url : undefined;
  return {
    output: JSON.stringify({
      render_id: r.id,
      status: 'succeeded',
      url,
      width: r.width ?? null,
      height: r.height ?? null,
      duration_seconds: r.duration ?? null,
      file_size_bytes: r.file_size ?? null,
      note: 'Creatomate deletes this file after 30 days. Artivio has archived a copy to the workspace file library — use the library URL in anything you publish.',
    }),
    assetUrls: url ? [url] : [],
  };
}

async function pollRender(key: string, id: string, startedAt: number): Promise<BuiltinResult> {
  while (Date.now() - startedAt < MAX_POLL_MS) {
    await sleep(pollMs());
    const r = firstRender(await cm(`/v2/renders/${encodeURIComponent(id)}`, key));
    const status = String(r.status ?? '').toLowerCase();
    if (status === 'succeeded') {
      return renderResult(r);
    }
    if (status === 'failed') {
      throw new Error(`Creatomate render failed: ${r.error_message ?? 'no reason given'}. Check the template and the modification values; nothing usable was produced.`);
    }
  }
  return {
    output: JSON.stringify({
      render_id: id,
      status: 'rendering',
      note: 'Still rendering after the wait window — the job was accepted and will finish. Call check_render with this render_id shortly to get the final URL.',
    }),
  };
}

export const CREATOMATE_GUIDANCE = `Creatomate (template video/image rendering):
- Words on a video or image come from a TEMPLATE, never from an AI image/video model — models misspell. You supply the wording through modifications; the template draws it in real fonts.
- Never guess modification keys. Call template_fields for the template first; the keys are its element names (optionally "Name.property"). render refuses an unknown key rather than silently ignoring it.
- Media elements (image/video/audio) need a PUBLIC http(s) URL — a workspace library asset URL.
- Run render with dry_run:true on the first template of a batch; it validates without spending credits.
- Renders take ~30–120 s. The finished file is archived to the workspace library (Creatomate deletes its copy after 30 days) — publish the library URL.
- 30 requests per 10 s per account: render a batch one at a time, not in parallel.`;

export const creatomateProvider: BuiltinProvider = {
  slug: 'creatomate',
  name: 'Creatomate (template video & images)',
  description:
    'Render finished vertical video and images from templates: hook text, captions, brand, end cards drawn in real fonts, with clips and images supplied by HeyGen/Kie/the library. Async renders (~30–120 s). Billed by Creatomate against the plan that owns the API key.',
  credentialLabel:
    'A Creatomate PROJECT API key (Creatomate → Project Settings → API). Paste the raw key — a leading "Bearer " is stripped. Leave blank to use the platform CREATOMATE_API_KEY.',
  guidance: CREATOMATE_GUIDANCE,

  tools: [
    {
      name: 'list_templates',
      description: 'List the templates in the Creatomate project (id, name, tags). Optionally filter by tags. Then call template_fields on the one you want.',
      input_schema: {
        type: 'object',
        properties: { tags: { type: 'array', items: { type: 'string' }, description: 'Only templates carrying ALL of these tags.' } },
      },
    },
    {
      name: 'template_fields',
      description: 'Read one template: its output size/duration and the element names, types and current text/source — exactly the keys render accepts in `modifications`. Always call this before render.',
      input_schema: {
        type: 'object',
        properties: { template_id: { type: 'string' } },
        required: ['template_id'],
      },
    },
    {
      name: 'render',
      description:
        'Render a template with your modifications (keys = element names from template_fields; text elements take a string, image/video/audio elements take a PUBLIC URL; "Name.property" sets a single property). Waits for the render and returns the finished file (archived to the library). dry_run:true validates without spending credits. Costs render credits — one at a time.',
      input_schema: {
        type: 'object',
        properties: {
          template_id: { type: 'string' },
          modifications: { type: 'object', description: 'element name → new value.', additionalProperties: true },
          max_width: { type: 'number', description: 'Optional: cap output width in px (scales proportionally) — cheaper previews.' },
          max_height: { type: 'number', description: 'Optional: cap output height in px.' },
          dry_run: { type: 'boolean', description: 'Validate only: returns {valid, errors, warnings}, renders nothing, uses no credits.' },
        },
        required: ['template_id'],
      },
    },
    {
      name: 'check_render',
      description: 'Check a render by render_id (from render). When succeeded returns the file URL (archived to the library).',
      input_schema: {
        type: 'object',
        properties: { render_id: { type: 'string' } },
        required: ['render_id'],
      },
    },
  ],

  call: async (tool, args, credential): Promise<string | BuiltinResult> => {
    const key = cleanKey(credential);
    if (!key) {
      throw new Error('No Creatomate API key: paste a project API key on the connection, or set CREATOMATE_API_KEY on the platform.');
    }

    if (tool === 'list_templates') {
      const tags = Array.isArray(args.tags) ? (args.tags as unknown[]).map(String).filter(Boolean) : [];
      const body = await cm(`/v2/templates${tags.length ? `?tags=${encodeURIComponent(tags.join(','))}` : ''}`, key);
      const list = (Array.isArray(body) ? body : body?.data ?? body?.templates ?? []) as any[];
      return JSON.stringify({
        count: list.length,
        templates: list.map(t => ({ template_id: t.id, name: t.name, tags: t.tags ?? [] })),
        note: 'Call template_fields with a template_id to see which elements you can modify.',
      });
    }

    if (tool === 'template_fields') {
      const id = String(args.template_id ?? '').trim();
      if (!id) {
        throw new Error('template_fields needs a template_id (from list_templates).');
      }
      templateCache.delete(`${key.slice(-6)}:${id}`);
      const t = await loadTemplate(key, id);
      return JSON.stringify({
        template_id: id,
        name: t.name ?? null,
        width: t.width ?? null,
        height: t.height ?? null,
        duration_seconds: t.duration ?? null,
        output_format: t.format ?? null,
        elements: t.fields,
        note: 'Use these names as the keys of `modifications`. Text elements take a string; image/video/audio elements take a PUBLIC URL.',
      });
    }

    if (tool === 'check_render') {
      const id = String(args.render_id ?? '').trim();
      if (!id) {
        throw new Error('check_render needs a render_id.');
      }
      const r = firstRender(await cm(`/v2/renders/${encodeURIComponent(id)}`, key));
      const status = String(r.status ?? '').toLowerCase();
      if (status === 'succeeded') {
        return renderResult(r);
      }
      if (status === 'failed') {
        return JSON.stringify({ render_id: id, status, error: r.error_message ?? 'no reason given' });
      }
      return JSON.stringify({ render_id: id, status: status || 'unknown', note: 'Not finished — check again shortly.' });
    }

    if (tool === 'render') {
      const templateId = String(args.template_id ?? '').trim();
      if (!templateId) {
        throw new Error('render needs a template_id (from list_templates).');
      }
      const mods = (args.modifications && typeof args.modifications === 'object' ? args.modifications : {}) as Record<string, unknown>;
      const template = await loadTemplate(key, templateId);
      const problem = checkModifications(template.fields, mods);
      if (problem) {
        throw new Error(`render refused before sending (nothing was spent): ${problem}`);
      }
      const payload: Record<string, unknown> = { template_id: templateId, modifications: mods };
      for (const k of ['max_width', 'max_height'] as const) {
        const n = Number(args[k]);
        if (Number.isFinite(n) && n > 0) {
          payload[k] = n;
        }
      }
      if (args.dry_run === true) {
        payload.dry_run = true;
        const r = await cm('/v2/renders', key, { method: 'POST', body: JSON.stringify(payload) });
        return JSON.stringify({ dry_run: true, valid: r?.valid ?? null, errors: r?.errors ?? [], warnings: r?.warnings ?? [], note: 'Nothing was rendered and no credits were used.' });
      }
      const started = Date.now();
      const created = firstRender(await cm('/v2/renders', key, { method: 'POST', body: JSON.stringify(payload) }));
      if (!created?.id) {
        throw new Error('Creatomate accepted the request but returned no render id.');
      }
      if (created.status === 'succeeded' && created.url) {
        return renderResult(created);
      }
      return pollRender(key, String(created.id), started);
    }

    throw new Error(`Unknown Creatomate tool: ${tool}`);
  },
};
