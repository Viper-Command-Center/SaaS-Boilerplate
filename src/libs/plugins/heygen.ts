/**
 * HeyGen — built-in provider (AI avatar / talking-head video).
 *
 * WHY THIS IS A BUILT-IN PROVIDER AND NOT A PLAIN HTTP MCP CONNECTION
 *
 * HeyGen's hosted MCP (mcp.heygen.com) is OAuth-ONLY — it does not accept an
 * API key in any header. Artivio's MCP client sends static headers only (no
 * OAuth handshake, no dynamic client registration, no callback route), so a
 * custom HTTP connection to that URL 401s with `invalid_token` every time.
 * HeyGen's REST API, by contrast, authenticates with a simple `X-Api-Key`
 * header — so we wrap the REST API here instead, exactly like Kie.ai.
 *
 * Like Kie, every HeyGen video job is ASYNC: create a job → poll until it's
 * done. We hide that behind synchronous-feeling tools and archive the finished
 * MP4 into the workspace library (HeyGen's URLs are signed and expire).
 *
 * BILLING: HeyGen charges the plan that owns the API key, on HeyGen's side —
 * there is no per-job cost in the API response to meter, so we do NOT bill the
 * workspace here (no `units` returned). Whoever's key this is pays HeyGen
 * directly, the same as the OAuth path would ("bills against your existing
 * plan"). If HeyGen ever adds per-job credit reporting, meter it like Kie does.
 *
 * Endpoints (base overridable via HEYGEN_BASE_URL). Header on every call:
 *   X-Api-Key: <key>
 *   POST {BASE}/v2/video/generate                → { data: { video_id } }
 *   GET  {BASE}/v1/video_status.get?video_id=…    → { data: { status, video_url, duration } }
 *   GET  {BASE}/v2/avatars                        → { data: { avatars: [...] } }
 *   GET  {BASE}/v2/voices                         → { data: { voices:  [...] } }
 * All four verified against docs.heygen.com + apidog HeyGen API reference, Jul 2026.
 */

import type { BuiltinProvider, BuiltinResult } from '@/libs/plugins/types';

const BASE = (process.env.HEYGEN_BASE_URL || 'https://api.heygen.com').replace(/\/$/, '');
const POLL_INTERVAL_MS = 4000;
// Poll close to the serverless request budget (routes cap at 300s) so most
// renders finish in-band. A longer render returns a video_id and the agent
// polls it later with check_video_status — HeyGen has already accepted the job.
const MAX_POLL_MS = 285_000;

/**
 * Fallback avatar + voice, taken verbatim from HeyGen's own /v2/video/generate
 * documentation example (public English avatar + voice). avatar_id and voice_id
 * are REQUIRED by HeyGen and the agent cannot enumerate them blind, so an
 * omitted id falls back to these known-good public defaults — and the tool tells
 * the model to call list_avatars / list_voices to choose deliberately.
 */
const DEFAULT_AVATAR_ID = 'Angela-inTshirt-20220820';
const DEFAULT_VOICE_ID = '1bd001e7e50f421d891986aad5158bc8';

/** aspect ratio → HeyGen dimension. HeyGen wants explicit width/height. */
const DIMENSIONS: Record<string, { width: number; height: number }> = {
  '16:9': { width: 1280, height: 720 },
  '9:16': { width: 720, height: 1280 },
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 864, height: 1080 },
};

const DEFAULT_DIM = { width: 1280, height: 720 };

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function heygenFetch(
  path: string,
  apiKey: string,
  init?: RequestInit,
): Promise<Record<string, any>> {
  const resp = await fetch(`${BASE}${path}`, {
    ...init,
    // A single hung request must not wedge the whole chat (see mcp/client.ts).
    signal: AbortSignal.timeout(60_000),
    headers: {
      'X-Api-Key': apiKey,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const body = (await resp.json().catch(() => ({}))) as Record<string, any>;
  if (!resp.ok) {
    const detail = JSON.stringify(body).slice(0, 300);
    throw new Error(`HeyGen ${resp.status}: ${detail}`);
  }
  // v2 endpoints return { error, data }: a non-null error means the call failed
  // even though the HTTP status is 200.
  if (body.error) {
    const e = typeof body.error === 'string' ? body.error : JSON.stringify(body.error);
    throw new Error(`HeyGen: ${e}`);
  }
  // v1 endpoints return { code, data, message }: code 100 = success.
  if (typeof body.code === 'number' && body.code !== 100) {
    throw new Error(`HeyGen: ${body.message ?? `code ${body.code}`}`);
  }
  return body;
}

/** Create a video job and poll it to completion. */
async function runVideo(apiKey: string, payload: Record<string, unknown>): Promise<BuiltinResult> {
  const created = await heygenFetch('/v2/video/generate', apiKey, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  const videoId = created.data?.video_id ?? created.data?.videoId;
  if (!videoId) {
    throw new Error('HeyGen accepted the request but returned no video_id.');
  }

  const started = Date.now();
  while (Date.now() - started < MAX_POLL_MS) {
    await sleep(POLL_INTERVAL_MS);
    const info = await heygenFetch(
      `/v1/video_status.get?video_id=${encodeURIComponent(String(videoId))}`,
      apiKey,
    );
    const d = (info.data ?? {}) as Record<string, any>;
    const status = String(d.status ?? '').toLowerCase();

    if (status === 'completed') {
      const url = d.video_url as string | undefined;
      return {
        output: JSON.stringify({
          video_id: videoId,
          status: 'completed',
          video_url: url,
          duration_seconds: d.duration ?? null,
          note: 'HeyGen video URLs are signed and expire. Artivio has archived the MP4 to the workspace file library — use the library URL below in anything you publish, not the raw HeyGen URL.',
        }),
        assetUrls: url ? [url] : [],
      };
    }
    if (status === 'failed') {
      const reason = d.error ?? d.msg ?? d.message ?? 'unknown reason';
      throw new Error(`HeyGen video failed: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`);
    }
    // 'pending' | 'processing' | 'waiting' → keep polling
  }

  // Outran the poll window. The job is real and still rendering on HeyGen's
  // side — hand back the id so the agent can finish the wait with a status call.
  return {
    output: JSON.stringify({
      video_id: videoId,
      status: 'processing',
      note: 'Still rendering after the poll window. The job was accepted and will finish. Call check_video_status with this video_id in a minute or two to get the final URL.',
    }),
  };
}

export const heygenProvider: BuiltinProvider = {
  slug: 'heygen',
  name: 'HeyGen (AI avatar video)',
  description:
    'Generate talking-avatar / spokesperson videos from a script via HeyGen. Async: a render takes from ~30s to a few minutes. Billed by HeyGen against the plan that owns the API key.',
  credentialLabel:
    'Your HeyGen API key from app.heygen.com → Settings → API (sent as the X-Api-Key header). Paste the raw key — no "Bearer" prefix.',

  tools: [
    {
      name: 'generate_avatar_video',
      description:
        'Create a talking-avatar video from a script. Async — may take a few minutes; the tool waits and returns the finished video URL (archived to the workspace library), or a video_id to check later if the render is slow. avatar_id and voice_id are optional: omit them to use a sensible default, or call list_avatars and list_voices first to choose deliberately (recommended for brand consistency). Videos cost HeyGen credits — confirm the script and choices with the user before generating.',
      input_schema: {
        type: 'object',
        properties: {
          script: { type: 'string', description: 'The exact words the avatar should say. Keep it tight — every second of speech costs credits.' },
          avatar_id: { type: 'string', description: 'A HeyGen avatar_id from list_avatars. Omit to use the default avatar.' },
          voice_id: { type: 'string', description: 'A HeyGen voice_id from list_voices. Omit to use the default voice. Must be an ID, not a voice name.' },
          aspect_ratio: { type: 'string', enum: ['16:9', '9:16', '1:1', '4:5'], description: 'Output shape. Defaults to 16:9. Use 9:16 for reels/stories.' },
          background_color: { type: 'string', description: 'Optional solid background as a hex color, e.g. #071E17. Omit to keep the avatar\'s default background.' },
          speed: { type: 'number', description: 'Speaking speed 0.5–1.5. Defaults to 1.0.' },
          title: { type: 'string', description: 'Optional video title shown in the HeyGen dashboard.' },
        },
        required: ['script'],
      },
    },
    {
      name: 'list_avatars',
      description: 'List the avatars available on this HeyGen account (avatar_id + name). Call this before generate_avatar_video to pick an avatar deliberately.',
      input_schema: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Optional case-insensitive filter on the avatar name.' },
        },
      },
    },
    {
      name: 'list_voices',
      description: 'List the voices available on this HeyGen account (voice_id, name, language, gender). Call this before generate_avatar_video to pick a voice. The list is large — filter by language.',
      input_schema: {
        type: 'object',
        properties: {
          language: { type: 'string', description: 'Optional case-insensitive filter on language, e.g. "english".' },
          search: { type: 'string', description: 'Optional case-insensitive filter on the voice name.' },
        },
      },
    },
    {
      name: 'check_video_status',
      description: 'Check the status of a HeyGen video by video_id. Use this to finish waiting on a render that was still processing when generate_avatar_video returned. When completed, returns the video URL (archived to the workspace library).',
      input_schema: {
        type: 'object',
        properties: {
          video_id: { type: 'string', description: 'The video_id returned by generate_avatar_video.' },
        },
        required: ['video_id'],
      },
    },
  ],

  call: async (tool, args, credential): Promise<string | BuiltinResult> => {
    const apiKey = (credential ?? '').trim();
    if (!apiKey) {
      throw new Error('No HeyGen API key configured for this plugin.');
    }

    if (tool === 'list_avatars') {
      const body = await heygenFetch('/v2/avatars', apiKey);
      const avatars = (body.data?.avatars ?? []) as any[];
      const search = args.search ? String(args.search).toLowerCase() : null;
      const filtered = avatars.filter(a => !search || String(a.avatar_name ?? '').toLowerCase().includes(search));
      return JSON.stringify({
        count: filtered.length,
        avatars: filtered.slice(0, 80).map(a => ({
          avatar_id: a.avatar_id,
          name: a.avatar_name,
          gender: a.gender,
          premium: a.premium ?? false,
        })),
        note: filtered.length > 80 ? 'Showing the first 80. Use the search argument to narrow down.' : undefined,
      });
    }

    if (tool === 'list_voices') {
      const body = await heygenFetch('/v2/voices', apiKey);
      const voices = (body.data?.voices ?? []) as any[];
      const lang = args.language ? String(args.language).toLowerCase() : null;
      const search = args.search ? String(args.search).toLowerCase() : null;
      const filtered = voices.filter(v =>
        (!lang || String(v.language ?? '').toLowerCase().includes(lang))
        && (!search || String(v.name ?? '').toLowerCase().includes(search)),
      );
      return JSON.stringify({
        count: filtered.length,
        voices: filtered.slice(0, 60).map(v => ({
          voice_id: v.voice_id,
          name: v.name,
          language: v.language,
          gender: v.gender,
        })),
        note: filtered.length > 60 ? 'Showing the first 60. Filter by language or search to narrow down.' : undefined,
      });
    }

    if (tool === 'check_video_status') {
      const videoId = String(args.video_id ?? '').trim();
      if (!videoId) {
        throw new Error('check_video_status needs a video_id.');
      }
      const info = await heygenFetch(`/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`, apiKey);
      const d = (info.data ?? {}) as Record<string, any>;
      const status = String(d.status ?? '').toLowerCase();
      if (status === 'completed') {
        const url = d.video_url as string | undefined;
        return {
          output: JSON.stringify({ video_id: videoId, status, video_url: url, duration_seconds: d.duration ?? null,
            note: 'Archived to the workspace file library — use the library URL when publishing.' }),
          assetUrls: url ? [url] : [],
        };
      }
      return JSON.stringify({ video_id: videoId, status: status || 'unknown', note: status === 'failed' ? (d.error ?? 'render failed') : 'Still rendering — check again shortly.' });
    }

    if (tool === 'generate_avatar_video') {
      const script = String(args.script ?? '').trim();
      if (!script) {
        throw new Error('generate_avatar_video needs a non-empty script.');
      }
      const aspect = args.aspect_ratio && DIMENSIONS[String(args.aspect_ratio)] ? String(args.aspect_ratio) : '16:9';

      // avatar_id / voice_id are REQUIRED by HeyGen. Fall back to the verified
      // public defaults if the agent didn't choose (it's told to call
      // list_avatars / list_voices for deliberate, on-brand choices).
      const avatarId = args.avatar_id ? String(args.avatar_id) : DEFAULT_AVATAR_ID;
      const voiceId = args.voice_id ? String(args.voice_id) : DEFAULT_VOICE_ID;

      const voice: Record<string, unknown> = { type: 'text', input_text: script, voice_id: voiceId };
      if (typeof args.speed === 'number') {
        voice.speed = args.speed;
      }

      const scene: Record<string, unknown> = {
        character: { type: 'avatar', avatar_id: avatarId, avatar_style: 'normal' },
        voice,
      };
      if (args.background_color) {
        scene.background = { type: 'color', value: String(args.background_color) };
      }

      const payload: Record<string, unknown> = {
        video_inputs: [scene],
        dimension: DIMENSIONS[aspect] ?? DEFAULT_DIM,
        title: args.title ? String(args.title) : 'Artivio video',
      };

      return runVideo(apiKey, payload);
    }

    throw new Error(`Unknown HeyGen tool: ${tool}`);
  },
};
