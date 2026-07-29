/**
 * HeyGen — built-in provider (AI avatar / talking-head video). v3 API.
 *
 * WHY THIS IS A BUILT-IN PROVIDER AND NOT A PLAIN HTTP MCP CONNECTION
 * HeyGen's hosted MCP (mcp.heygen.com) is OAuth-ONLY — it does not accept an
 * API key in any header. Artivio's MCP client sends static headers only, so a
 * custom HTTP connection to that URL 401s with `invalid_token` every time.
 * HeyGen's REST API authenticates with `X-Api-Key`, so we wrap it here.
 *
 * ⚠️ v3 ONLY. The v1/v2 endpoints are Legacy with a sunset date of 2026-10-31
 * (the API says so in a `warning` on every response). The first version of this
 * provider used v2 and hardcoded default avatar/voice ids from the old docs —
 * those ids no longer exist and produced bare "HeyGen 404" failures. v3 fixes
 * both: current endpoints, and defaults RESOLVED AT RUNTIME from the account's
 * own avatar/voice lists instead of hardcoded.
 *
 * Endpoints (base overridable via HEYGEN_BASE_URL). Header: X-Api-Key.
 *   POST /v3/videos                    { type:"avatar", avatar_id, script, voice_id, … } → { data: { id } }
 *   GET  /v3/videos/{id}               → { data: { status, video_url, duration, failure_message } }
 *   POST /v3/video-agents              { prompt } → { data: { session_id } }   (prompt → finished video)
 *   GET  /v3/video-agents/{session}    → { data: { status, video_id } }
 *   GET  /v3/avatars/looks             → { data: [ { id, name, avatar_type, default_voice_id, … } ] }
 *   GET  /v3/voices                    → { data: [ { voice_id, name, language, gender } ] }
 * Verified against developers.heygen.com (llms.txt + quick-start + avatar-looks
 * + search-voices + generate-avatar-video), Jul 2026.
 *
 * BILLING: HeyGen bills the plan that owns the API key; the API reports no
 * per-job cost to meter, so no `units` are returned here.
 */

import type { BuiltinProvider, BuiltinResult } from '@/libs/plugins/types';

const BASE = (process.env.HEYGEN_BASE_URL || 'https://api.heygen.com').replace(/\/$/, '');
const POLL_INTERVAL_MS = 5000;
// Poll close to the serverless request budget (routes cap at 300s). Renders
// that outrun the window return their id for check_video_status.
const MAX_POLL_MS = 280_000;

const ASPECTS = new Set(['auto', '16:9', '9:16', '1:1']);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function hg(path: string, apiKey: string, init?: RequestInit): Promise<Record<string, any>> {
  const resp = await fetch(`${BASE}${path}`, {
    ...init,
    // A hung request must not wedge the chat loop (see mcp/client.ts).
    signal: AbortSignal.timeout(60_000),
    headers: {
      'X-Api-Key': apiKey,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const body = (await resp.json().catch(() => ({}))) as Record<string, any>;
  if (!resp.ok || body.error) {
    const e = body.error
      ? (typeof body.error === 'string' ? body.error : JSON.stringify(body.error))
      : JSON.stringify(body).slice(0, 300);
    throw new Error(`HeyGen ${resp.status}: ${e}`);
  }
  return body;
}

/**
 * Resolve avatar_id / voice_id when the agent didn't choose. v3 has no
 * documented universal default ids, and hardcoding one is exactly the bug the
 * v2 provider had — so pick from the account's own lists at call time.
 */
async function resolveDefaults(apiKey: string, wantAvatar: boolean, wantVoice: boolean) {
  let avatarId: string | undefined;
  let voiceId: string | undefined;
  if (wantAvatar) {
    const looks = await hg('/v3/avatars/looks?ownership=public&limit=10', apiKey);
    const list = (looks.data ?? []) as any[];
    const pick = list.find(l => l && l.id && (l.status == null || l.status === 'completed'));
    if (!pick) {
      throw new Error('No avatar looks available on this HeyGen account — call list_avatars, or create one at app.heygen.com.');
    }
    avatarId = String(pick.id);
    if (wantVoice && pick.default_voice_id) {
      voiceId = String(pick.default_voice_id);
    }
  }
  if (wantVoice && !voiceId) {
    const voices = await hg('/v3/voices?language=English&limit=5', apiKey);
    const v = ((voices.data ?? []) as any[]).find(x => x && x.voice_id);
    if (!v) {
      throw new Error('No voices available on this HeyGen account — call list_voices to inspect.');
    }
    voiceId = String(v.voice_id);
  }
  return { avatarId, voiceId };
}

function videoResult(videoId: string, d: Record<string, any>): BuiltinResult {
  const url = (d.video_url ?? d.captioned_video_url) as string | undefined;
  return {
    output: JSON.stringify({
      video_id: videoId,
      status: 'completed',
      video_url: url,
      duration_seconds: d.duration ?? null,
      thumbnail_url: d.thumbnail_url ?? null,
      note: 'HeyGen URLs are presigned and expire. Artivio has archived the MP4 to the workspace file library — use the library URL in anything you publish.',
    }),
    assetUrls: url ? [url] : [],
  };
}

/** Poll one video id to completion (within the request budget). */
async function pollVideo(apiKey: string, videoId: string, startedAt: number): Promise<BuiltinResult> {
  while (Date.now() - startedAt < MAX_POLL_MS) {
    await sleep(POLL_INTERVAL_MS);
    const info = await hg(`/v3/videos/${encodeURIComponent(videoId)}`, apiKey);
    const d = (info.data ?? {}) as Record<string, any>;
    const status = String(d.status ?? '').toLowerCase();
    if (status === 'completed') {
      return videoResult(videoId, d);
    }
    if (status === 'failed') {
      throw new Error(`HeyGen video failed: ${d.failure_message ?? d.failure_code ?? 'unknown reason'}`);
    }
  }
  return {
    output: JSON.stringify({
      video_id: videoId,
      status: 'processing',
      note: 'Still rendering after the poll window — the job was accepted and will finish. Call check_video_status with this video_id shortly to get the final URL.',
    }),
  };
}

export const heygenProvider: BuiltinProvider = {
  slug: 'heygen',
  name: 'HeyGen (AI avatar video)',
  description:
    'Generate talking-avatar / spokesperson videos via HeyGen (v3 API): from an exact script, or from a plain-language prompt (Video Agent scripts, casts and renders it). Async: renders take ~1–5 minutes. Billed by HeyGen against the plan that owns the API key.',
  credentialLabel:
    'Your HeyGen API key from app.heygen.com → Settings → API (sent as the X-Api-Key header). Paste the raw key — no "Bearer" prefix.',

  tools: [
    {
      name: 'generate_avatar_video',
      description:
        'Create a talking-avatar video from an EXACT script (v3). Waits for the render and returns the finished video URL (archived to the workspace library), or a video_id to check later if the render is slow. avatar_id/voice_id are optional — omitted, a sensible default is picked from the account\'s own lists; for brand consistency call list_avatars and list_voices first and choose. Videos cost HeyGen credits: confirm the script with the user before generating.',
      input_schema: {
        type: 'object',
        properties: {
          script: { type: 'string', description: 'The exact words the avatar should say. Keep it tight — every second of speech costs credits.' },
          avatar_id: { type: 'string', description: 'An avatar look id from list_avatars. Omit to auto-pick a public look.' },
          voice_id: { type: 'string', description: 'A voice_id from list_voices. Omit to use the look\'s default (or an English public voice). Must be an ID, not a name.' },
          aspect_ratio: { type: 'string', enum: ['auto', '16:9', '9:16', '1:1'], description: 'Defaults to auto. Use 9:16 for TikTok/reels/stories.' },
          resolution: { type: 'string', enum: ['720p', '1080p'], description: 'Defaults to 1080p.' },
          motion_prompt: { type: 'string', description: 'Optional natural-language direction for body motion / hand gestures.' },
          title: { type: 'string', description: 'Optional title shown in the HeyGen dashboard.' },
        },
        required: ['script'],
      },
    },
    {
      name: 'generate_video_from_prompt',
      description:
        'HeyGen Video Agent (flagship): describe the video in plain language ("a 30-second explainer of BudgetSmart AI for TikTok, energetic tone") and HeyGen scripts it, picks avatar/voice, and renders. Slower and less controllable than generate_avatar_video but needs no ids and no exact script. Waits as long as it can; returns session/video ids to finish via check_video_status if the render outruns the window. Costs HeyGen credits — confirm with the user first.',
      input_schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'What the video should be — audience, length, tone, key points, platform.' },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'list_avatars',
      description: 'List avatar looks available to this HeyGen account (id, name, type, gender, default voice). The look id is what you pass as avatar_id. Filter by ownership=private to see only the account\'s own avatars.',
      input_schema: {
        type: 'object',
        properties: {
          ownership: { type: 'string', enum: ['public', 'private'], description: 'HeyGen presets (public) or this account\'s own avatars (private). Omit for both.' },
          avatar_type: { type: 'string', enum: ['studio_avatar', 'digital_twin', 'photo_avatar'], description: 'Optional filter.' },
          search: { type: 'string', description: 'Optional case-insensitive filter on the look name.' },
        },
      },
    },
    {
      name: 'list_voices',
      description: 'List voices (voice_id, name, language, gender). Call before generate_avatar_video to pick a voice. Large list — filter by language and/or gender.',
      input_schema: {
        type: 'object',
        properties: {
          language: { type: 'string', description: 'e.g. "English", "Spanish".' },
          gender: { type: 'string', enum: ['male', 'female'] },
        },
      },
    },
    {
      name: 'check_video_status',
      description: 'Check a HeyGen render by video_id (from generate_avatar_video) or session_id (from generate_video_from_prompt). When completed, returns the video URL (archived to the workspace library).',
      input_schema: {
        type: 'object',
        properties: {
          video_id: { type: 'string', description: 'The video id to check.' },
          session_id: { type: 'string', description: 'A Video Agent session id — used when the prompt flow had not yet produced a video_id.' },
        },
      },
    },
  ],

  call: async (tool, args, credential): Promise<string | BuiltinResult> => {
    const apiKey = (credential ?? '').trim();
    if (!apiKey) {
      throw new Error('No HeyGen API key configured for this plugin.');
    }

    if (tool === 'list_avatars') {
      const qs = new URLSearchParams({ limit: '50' });
      if (args.ownership) {
        qs.set('ownership', String(args.ownership));
      }
      if (args.avatar_type) {
        qs.set('avatar_type', String(args.avatar_type));
      }
      const body = await hg(`/v3/avatars/looks?${qs}`, apiKey);
      const looks = (body.data ?? []) as any[];
      const search = args.search ? String(args.search).toLowerCase() : null;
      const filtered = looks.filter(l => !search || String(l.name ?? '').toLowerCase().includes(search));
      return JSON.stringify({
        count: filtered.length,
        avatars: filtered.map(l => ({
          avatar_id: l.id,
          name: l.name,
          type: l.avatar_type,
          gender: l.gender,
          default_voice_id: l.default_voice_id ?? null,
          engines: l.supported_api_engines ?? [],
        })),
        has_more: Boolean(body.has_more),
        note: 'Pass avatar_id (the look id) to generate_avatar_video. If has_more is true there are further pages — refine with ownership/avatar_type/search instead of paging.',
      });
    }

    if (tool === 'list_voices') {
      const qs = new URLSearchParams({ limit: '50' });
      if (args.language) {
        qs.set('language', String(args.language));
      }
      if (args.gender) {
        qs.set('gender', String(args.gender));
      }
      const body = await hg(`/v3/voices?${qs}`, apiKey);
      const voices = (body.data ?? []) as any[];
      return JSON.stringify({
        count: voices.length,
        voices: voices.map(v => ({ voice_id: v.voice_id, name: v.name, language: v.language, gender: v.gender })),
        has_more: Boolean(body.has_more),
      });
    }

    if (tool === 'check_video_status') {
      const started = Date.now();
      let videoId = args.video_id ? String(args.video_id).trim() : '';
      const sessionId = args.session_id ? String(args.session_id).trim() : '';
      if (!videoId && sessionId) {
        const sess = await hg(`/v3/video-agents/${encodeURIComponent(sessionId)}`, apiKey);
        const sd = (sess.data ?? {}) as Record<string, any>;
        if (sd.video_id) {
          videoId = String(sd.video_id);
        } else {
          return JSON.stringify({ session_id: sessionId, status: sd.status ?? 'generating', note: 'The Video Agent is still scripting/rendering — no video_id yet. Check again shortly.' });
        }
      }
      if (!videoId) {
        throw new Error('check_video_status needs a video_id or a session_id.');
      }
      const info = await hg(`/v3/videos/${encodeURIComponent(videoId)}`, apiKey);
      const d = (info.data ?? {}) as Record<string, any>;
      const status = String(d.status ?? '').toLowerCase();
      if (status === 'completed') {
        return videoResult(videoId, d);
      }
      if (status === 'failed') {
        return JSON.stringify({ video_id: videoId, status, failure: d.failure_message ?? d.failure_code ?? 'unknown' });
      }
      void started;
      return JSON.stringify({ video_id: videoId, status: status || 'unknown', note: 'Still rendering — check again shortly.' });
    }

    if (tool === 'generate_avatar_video') {
      const script = String(args.script ?? '').trim();
      if (!script) {
        throw new Error('generate_avatar_video needs a non-empty script.');
      }
      const needAvatar = !args.avatar_id;
      const needVoice = !args.voice_id;
      const defaults: { avatarId?: string; voiceId?: string }
        = (needAvatar || needVoice) ? await resolveDefaults(apiKey, needAvatar, needVoice) : {};
      const payload: Record<string, unknown> = {
        type: 'avatar',
        avatar_id: args.avatar_id ? String(args.avatar_id) : defaults.avatarId,
        voice_id: args.voice_id ? String(args.voice_id) : defaults.voiceId,
        script,
        resolution: args.resolution === '720p' ? '720p' : '1080p',
        aspect_ratio: args.aspect_ratio && ASPECTS.has(String(args.aspect_ratio)) ? String(args.aspect_ratio) : 'auto',
        title: args.title ? String(args.title) : 'Artivio video',
      };
      if (args.motion_prompt) {
        payload.motion_prompt = String(args.motion_prompt);
      }
      const started = Date.now();
      const created = await hg('/v3/videos', apiKey, { method: 'POST', body: JSON.stringify(payload) });
      const cd = (created.data ?? {}) as Record<string, any>;
      const videoId = cd.id ?? cd.video_id;
      if (!videoId) {
        throw new Error('HeyGen accepted the request but returned no video id.');
      }
      return pollVideo(apiKey, String(videoId), started);
    }

    if (tool === 'generate_video_from_prompt') {
      const prompt = String(args.prompt ?? '').trim();
      if (!prompt) {
        throw new Error('generate_video_from_prompt needs a prompt.');
      }
      const started = Date.now();
      const sess = await hg('/v3/video-agents', apiKey, { method: 'POST', body: JSON.stringify({ prompt }) });
      const sessionId = ((sess.data ?? {}) as Record<string, any>).session_id;
      if (!sessionId) {
        throw new Error('HeyGen Video Agent returned no session_id.');
      }
      // Phase 1: wait for the agent to produce a video_id.
      let videoId: string | undefined;
      while (Date.now() - started < MAX_POLL_MS) {
        await sleep(POLL_INTERVAL_MS);
        const s = await hg(`/v3/video-agents/${encodeURIComponent(String(sessionId))}`, apiKey);
        const sd = (s.data ?? {}) as Record<string, any>;
        if (sd.status === 'failed') {
          throw new Error(`HeyGen Video Agent failed: ${sd.failure_message ?? 'unknown reason'}`);
        }
        if (sd.video_id) {
          videoId = String(sd.video_id);
          break;
        }
      }
      if (!videoId) {
        return {
          output: JSON.stringify({
            session_id: sessionId,
            status: 'generating',
            note: 'The Video Agent is still scripting/rendering. Call check_video_status with this session_id to finish the wait.',
          }),
        };
      }
      // Phase 2: poll the video itself with whatever budget remains.
      return pollVideo(apiKey, videoId, started);
    }

    throw new Error(`Unknown HeyGen tool: ${tool}`);
  },
};
