/**
 * Social batch preflight — `check_social_batch`.
 *
 * WHY (2026-10-08, BudgetSmart): posting was stopped because Zernio accepted
 * posts at CREATE time and failed them at PUBLISH time — wrong media, no media
 * on Instagram, wrong profile — and the failure arrived as a daily email days
 * later. The Zernio guard (mcp/httpGuards.ts) refuses the two shapes it knows
 * about at the moment of the call. This is the other half: a whole WEEK of
 * posts is checked as one batch BEFORE anything is scheduled, so the person
 * approving it (and the agent loading it) sees every problem at once, while it
 * is still cheap to fix.
 *
 * It is a pre-filter, not the publisher: Zernio and the platforms still have
 * the last word. So the limits below are deliberately CONSERVATIVE, and what
 * this tool cannot see (video length/ratio — no ffprobe on the server) is
 * returned in `notChecked` instead of being silently passed. A "clean" report
 * never claims more than was verified.
 *
 * Read-only: it fetches public media URLs (SSRF-guarded) and decides nothing
 * about publishing. Generic by design — nothing here knows which business the
 * workspace belongs to.
 */

import type { PlatformExecutor } from '@/libs/agent/platformTools';
import type { AnthropicTool } from '@/libs/mcp/registry';
import sharp from 'sharp';
import { assertPublicUrl } from '@/libs/agent/webTools';

type Rule = { caption: number; mediaRequired: boolean; hashtags?: number };

/** Conservative per-platform limits (characters). Zernio/platforms remain authoritative. */
export const PLATFORM_RULES: Record<string, Rule> = {
  instagram: { caption: 2200, mediaRequired: true, hashtags: 30 },
  tiktok: { caption: 2200, mediaRequired: true },
  youtube: { caption: 5000, mediaRequired: true },
  pinterest: { caption: 500, mediaRequired: true },
  facebook: { caption: 63_206, mediaRequired: false },
  linkedin: { caption: 3000, mediaRequired: false },
  x: { caption: 280, mediaRequired: false },
  threads: { caption: 500, mediaRequired: false },
  bluesky: { caption: 300, mediaRequired: false },
};

const ALIASES: Record<string, string> = { twitter: 'x', ig: 'instagram', fb: 'facebook' };
const MAX_POSTS = 60;
const IMAGE_FETCH_CAP = 8 * 1024 * 1024;
const MIN_LEAD_MS = 5 * 60_000;
const SAME_PLATFORM_GAP_MS = 3 * 3600_000;
const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

export type BatchPost = {
  id?: string;
  platform: string;
  scheduled_for: string;
  caption: string;
  media?: Array<string | { url: string; type?: string }>;
  /** Set when the on-screen text already carries a "not advice" line. */
  disclaimer_on_screen?: boolean;
  /** Presenter/visuals are AI-generated (a reminder to use the platform's AI label). */
  ai_generated?: boolean;
};

export type Finding = { post: string; platform: string; problem: string };

export type Probe = { status: number; contentType: string; length: number | null; body?: Buffer };
export type Prober = (url: string, wantBody: boolean) => Promise<Probe>;

export type BatchReport = {
  ok: boolean;
  posts: number;
  errors: Finding[];
  warnings: Finding[];
  info: Finding[];
  notChecked: string[];
};

// ─── Pure checks ─────────────────────────────────────────────────────────────

export function normalisePlatform(raw: unknown): string {
  const p = String(raw ?? '').trim().toLowerCase();
  return ALIASES[p] ?? p;
}

export function hashtagCount(caption: string): number {
  return (caption.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length;
}

const REGULATED = /\b(?:tax(?:es)?|mortgage|contract|legal|invest(?:ing|ment)?|loan|debt)\b/i;
const DISCLAIMED = /informational|not (?:financial|tax|legal|investment) advice|not advice/i;

/** Wording that creates legal exposure or breaks platform rules. Warnings, not blocks — a human decides. */
export function lintCaption(caption: string, opts: { disclaimerOnScreen?: boolean } = {}): string[] {
  const out: string[] = [];
  if (/\bguarantee[ds]?\b|risk[- ]free|get rich|double your/i.test(caption)) {
    out.push('Outcome promise ("guarantee", "risk-free", "get rich"). Describe what the product helps you do, never a guaranteed result.');
  }
  if (/\$\s?\d[\d,]*(?:\.\d+)?\s?(?:saved|back|more|extra|per month|a month)/i.test(caption)) {
    out.push('Specific savings amount. Fine only as a clearly labelled example; never as something a viewer should expect.');
  }
  if (/\bI (?:saved|made|earned|cut|paid off)\b|\bmy (?:savings|results)\b|\btestimonial\b/i.test(caption)) {
    out.push('First-person result claim. Valid only for a real, consenting person — an AI presenter must not claim results (FTC 16 CFR 465 / Competition Act s.74.02).');
  }
  if (REGULATED.test(caption) && !DISCLAIMED.test(caption) && !opts.disclaimerOnScreen) {
    out.push('Tax / mortgage / legal / investing topic with no "informational, not advice" line in the caption or on screen.');
  }
  return out;
}

export function scheduleProblem(iso: string, now: number, windowDays: number): string | null {
  if (!iso || typeof iso !== 'string') {
    return 'scheduled_for is missing.';
  }
  if (!HAS_OFFSET.test(iso.trim())) {
    return `scheduled_for "${iso}" has no UTC offset (use e.g. 2026-10-12T09:00:00-04:00) — without one the time is ambiguous.`;
  }
  const t = Date.parse(iso);
  if (Number.isNaN(t)) {
    return `scheduled_for "${iso}" is not a valid date-time.`;
  }
  if (t < now + MIN_LEAD_MS) {
    return `scheduled_for ${iso} is in the past or less than 5 minutes away.`;
  }
  if (t > now + windowDays * 86_400_000) {
    return `scheduled_for ${iso} is more than ${windowDays} days ahead — load the platform scheduler on a rolling window so a vendor change can't break weeks of posts.`;
  }
  return null;
}

/** Instagram feed images must sit between 4:5 and 1.91:1. */
export function instagramRatioProblem(width: number, height: number): string | null {
  if (!width || !height) {
    return null;
  }
  const r = width / height;
  if (r < 0.8 - 0.005 || r > 1.91 + 0.005) {
    return `image is ${width}x${height} (ratio ${r.toFixed(2)}); Instagram feed images must be between 4:5 (0.80) and 1.91:1.`;
  }
  return null;
}

function mediaList(p: BatchPost): Array<{ url: string; type?: string }> {
  return (p.media ?? []).map(m => (typeof m === 'string' ? { url: m } : { url: String(m?.url ?? ''), type: m?.type }));
}

/** Library URLs are tenants/<tenantId>/…; another tenant's prefix is a leak, not a typo. */
export function libraryOwnership(url: string, tenantId: string): 'own' | 'foreign' | 'external' {
  const pub = (process.env.R2_PUBLIC_URL ?? '').replace(/\/$/, '');
  if (!pub || !url.startsWith(`${pub}/`)) {
    return 'external';
  }
  const m = /^tenants\/([^/]+)\//.exec(url.slice(pub.length + 1));
  if (!m) {
    return 'external';
  }
  return m[1] === tenantId ? 'own' : 'foreign';
}

// ─── The batch ───────────────────────────────────────────────────────────────

export async function checkBatch(
  posts: BatchPost[],
  opts: { tenantId: string; windowDays?: number; now?: number; probe?: Prober },
): Promise<BatchReport> {
  const now = opts.now ?? Date.now();
  const windowDays = opts.windowDays && opts.windowDays > 0 ? opts.windowDays : 10;
  const probe = opts.probe ?? defaultProbe;
  const errors: Finding[] = [];
  const warnings: Finding[] = [];
  const info: Finding[] = [];
  const add = (list: Finding[], post: string, platform: string, problem: string) => list.push({ post, platform, problem });

  if (!Array.isArray(posts) || posts.length === 0) {
    return { ok: false, posts: 0, errors: [{ post: '-', platform: '-', problem: 'posts must be a non-empty array.' }], warnings, info, notChecked: [] };
  }
  const batch = posts.slice(0, MAX_POSTS);
  if (posts.length > MAX_POSTS) {
    add(warnings, '-', '-', `Only the first ${MAX_POSTS} posts were checked.`);
  }

  const lastByPlatform = new Map<string, number[]>();
  const captionSeen = new Map<string, string>();
  const probed = new Map<string, Promise<Probe | Error>>();

  const probeOnce = (url: string, wantBody: boolean) => {
    const key = `${wantBody ? 'b' : 'h'}:${url}`;
    let p = probed.get(key);
    if (!p) {
      p = probe(url, wantBody).catch(e => e instanceof Error ? e : new Error(String(e)));
      probed.set(key, p);
    }
    return p;
  };

  await Promise.all(batch.map(async (post, i) => {
    const label = post.id ? String(post.id) : `#${i + 1}`;
    const platform = normalisePlatform(post.platform);
    const rule = PLATFORM_RULES[platform];
    if (!rule) {
      add(errors, label, platform || '?', `Unknown platform "${post.platform}". Known: ${Object.keys(PLATFORM_RULES).join(', ')}.`);
      return;
    }
    const caption = String(post.caption ?? '');
    const media = mediaList(post);

    if (!caption.trim() && media.length === 0) {
      add(errors, label, platform, 'Empty post: no caption and no media.');
    }
    if (caption.length > rule.caption) {
      add(errors, label, platform, `Caption is ${caption.length} characters; ${platform} allows ${rule.caption}.`);
    }
    if (rule.hashtags && hashtagCount(caption) > rule.hashtags) {
      add(errors, label, platform, `${hashtagCount(caption)} hashtags; ${platform} allows ${rule.hashtags}.`);
    } else if (hashtagCount(caption) > 10) {
      add(warnings, label, platform, `${hashtagCount(caption)} hashtags reads as spam; 3–5 relevant ones perform better.`);
    }
    if (rule.mediaRequired && media.length === 0) {
      add(errors, label, platform, `${platform} requires media. Zernio accepts a text-only post now and fails it at publish time.`);
    }

    const sched = scheduleProblem(post.scheduled_for, now, windowDays);
    if (sched) {
      add(errors, label, platform, sched);
    } else {
      const t = Date.parse(post.scheduled_for);
      const prior = lastByPlatform.get(platform) ?? [];
      if (prior.some(p => Math.abs(p - t) < SAME_PLATFORM_GAP_MS)) {
        add(warnings, label, platform, 'Within 3 hours of another post on the same platform.');
      }
      prior.push(t);
      lastByPlatform.set(platform, prior);
    }

    const dupKey = `${platform}|${caption.trim().toLowerCase()}`;
    if (caption.trim() && captionSeen.has(dupKey)) {
      add(warnings, label, platform, `Identical caption to ${captionSeen.get(dupKey)} on the same platform.`);
    } else if (caption.trim()) {
      captionSeen.set(dupKey, label);
    }

    for (const problem of lintCaption(caption, { disclaimerOnScreen: post.disclaimer_on_screen })) {
      add(warnings, label, platform, problem);
    }
    if (post.ai_generated) {
      add(info, label, platform, 'AI-generated presenter/visuals: switch on the platform\'s AI-content label when publishing.');
    }

    for (const m of media) {
      if (!/^https?:\/\//i.test(m.url)) {
        add(errors, label, platform, `Media "${m.url.slice(0, 80)}" is not a public http(s) URL — Zernio downloads it server-side. Use a library asset URL.`);
        continue;
      }
      const owner = libraryOwnership(m.url, opts.tenantId);
      if (owner === 'foreign') {
        add(errors, label, platform, 'Media URL belongs to a DIFFERENT workspace\'s library. Refusing — save the file into this workspace and use its own URL.');
        continue;
      }
      if (owner === 'external') {
        add(warnings, label, platform, `Media is hosted outside the workspace library (${new URL(m.url).hostname}); it may expire or block Zernio. Save it with save_file_from_url and use the library URL.`);
      }
      try {
        assertPublicUrl(m.url);
      } catch (e) {
        add(errors, label, platform, `Media URL is not publicly reachable: ${(e as Error).message}`);
        continue;
      }
      const wantBody = platform === 'instagram' && (m.type ?? '').toLowerCase() !== 'video';
      const res = await probeOnce(m.url, wantBody);
      if (res instanceof Error) {
        add(errors, label, platform, `Could not fetch media (${m.url.slice(0, 80)}): ${res.message}`);
        continue;
      }
      if (res.status >= 400) {
        add(errors, label, platform, `Media URL returned HTTP ${res.status} (${m.url.slice(0, 80)}) — missing or private.`);
        continue;
      }
      if (res.length === 0) {
        add(errors, label, platform, `Media file is empty (${m.url.slice(0, 80)}).`);
      }
      const declared = (m.type ?? '').toLowerCase();
      const family = res.contentType.split('/')[0] ?? '';
      if (!['image', 'video'].includes(family)) {
        add(errors, label, platform, `Media is ${res.contentType || 'an unknown type'}, not an image or video.`);
      } else if (declared && ['image', 'video'].includes(declared) && declared !== family) {
        add(errors, label, platform, `Media is declared ${declared} but the file is ${res.contentType}.`);
      }
      if (res.body && platform === 'instagram' && family === 'image') {
        try {
          const meta = await sharp(res.body).metadata();
          const ratio = instagramRatioProblem(meta.width ?? 0, meta.height ?? 0);
          if (ratio) {
            add(errors, label, platform, ratio);
          }
        } catch {
          add(warnings, label, platform, 'Could not read the image dimensions to check the Instagram ratio.');
        }
      }
    }
  }));

  return {
    ok: errors.length === 0,
    posts: batch.length,
    errors,
    warnings,
    info,
    notChecked: [
      'Video length and aspect ratio (no video probe on the server) — confirm 9:16 and platform length limits at render time.',
      'Whether the Zernio profile/account ids are right — Zernio\'s own guard checks those when the post is created.',
      'Caption wording quality, spelling, and the facts in it — a human reads the batch before it is scheduled.',
    ],
  };
}

async function defaultProbe(url: string, wantBody: boolean): Promise<Probe> {
  const signal = AbortSignal.timeout(15_000);
  if (!wantBody) {
    let resp = await fetch(url, { method: 'HEAD', signal, redirect: 'follow' });
    if (resp.status === 405 || resp.status === 403) {
      resp = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal, redirect: 'follow' });
    }
    const len = Number(resp.headers.get('content-length'));
    const range = /\/(\d+)$/.exec(resp.headers.get('content-range') ?? '');
    return {
      status: resp.status === 206 ? 200 : resp.status,
      contentType: (resp.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase(),
      length: range ? Number(range[1]) : Number.isFinite(len) && resp.headers.has('content-length') ? len : null,
    };
  }
  const resp = await fetch(url, { signal, redirect: 'follow' });
  const buf = Buffer.from(await resp.arrayBuffer());
  return {
    status: resp.status,
    contentType: (resp.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase(),
    length: buf.length,
    body: buf.length <= IMAGE_FETCH_CAP ? buf : undefined,
  };
}

// ─── Tool wiring ─────────────────────────────────────────────────────────────

export function buildSocialBatchTools(tenantId: string): {
  anthropicTools: AnthropicTool[];
  executors: Map<string, PlatformExecutor>;
} {
  const executors = new Map<string, PlatformExecutor>();
  const anthropicTools: AnthropicTool[] = [
    {
      name: 'check_social_batch',
      description:
        'Preflight a whole batch of social posts BEFORE scheduling any of them (read-only). Checks every post for: known platform, caption length and hashtag limits, media required on Instagram/TikTok/YouTube/Pinterest, media URLs that exist, are public, belong to THIS workspace and have the right type, Instagram feed image ratio, schedule time (future, has a UTC offset, inside the rolling window), same-platform spacing and duplicate captions, and risky wording (outcome promises, first-person result claims, tax/mortgage/legal topics with no "informational, not advice" line). Returns {ok, errors, warnings, info, notChecked} — errors must be fixed before anything is created in the scheduler; `notChecked` lists what this tool cannot see (video length/ratio). Run it on the full week, fix, re-run until ok:true, show the person the batch, and only then create posts.',
      input_schema: {
        type: 'object',
        properties: {
          posts: {
            type: 'array',
            description: 'One entry per (post, platform).',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Your label for the post, e.g. "wk1-mon-tiktok".' },
                platform: { type: 'string', enum: Object.keys(PLATFORM_RULES) },
                scheduled_for: { type: 'string', description: 'ISO date-time WITH a UTC offset, e.g. 2026-10-12T09:00:00-04:00.' },
                caption: { type: 'string' },
                media: {
                  type: 'array',
                  items: { type: 'object', properties: { url: { type: 'string' }, type: { type: 'string', enum: ['image', 'video'] } }, required: ['url'] },
                },
                disclaimer_on_screen: { type: 'boolean', description: 'True if the on-screen text already carries an "informational, not advice" line.' },
                ai_generated: { type: 'boolean', description: 'True if the presenter or visuals are AI-generated.' },
              },
              required: ['platform', 'scheduled_for', 'caption'],
            },
          },
          window_days: { type: 'number', description: 'How far ahead posts may be scheduled. Default 10.' },
        },
        required: ['posts'],
      },
    },
  ];

  executors.set('check_social_batch', {
    policy: 'auto', // read-only: fetches public media URLs, writes nothing
    call: async (args) => {
      const raw = Array.isArray(args.posts) ? args.posts as BatchPost[] : [];
      const report = await checkBatch(raw, { tenantId, windowDays: Number(args.window_days) || undefined });
      return JSON.stringify(report);
    },
  });

  return { anthropicTools, executors };
}
