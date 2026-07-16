/**
 * Kie.ai — built-in tier-1 provider (image / video / music / chat generation).
 *
 * Kie.ai has no MCP server; it exposes a unified REST API where every job is
 * ASYNC: create a task → poll until it completes. We wrap that here so the
 * agent gets simple, synchronous-feeling tools.
 *
 * TWO THINGS THAT MAKE THIS EXACT AND RESILIENT:
 *
 * 1. **Multi-key round-robin + failover.** The platform credential may hold up
 *    to 20 API keys (one per line). Calls are spread across them, and if a key
 *    is rate-limited (429), out of credit (402) or blocked (401/403), we fail
 *    over to the next key instead of failing the job. Kie's limits are applied
 *    PER ACCOUNT (20 requests / 10s), so multiple keys = more throughput and no
 *    single point of failure.
 *
 * 2. **Usage metering, not a price table.** `recordInfo` returns
 *    `creditsConsumed` for every task, and Kie credits are a flat $0.005 each
 *    across all 368+ models (840 credits = $4.20, 14 credits = $0.07 …). So we
 *    bill the credits the job actually burned instead of maintaining a model
 *    price table that goes stale every time they add a model. Failed jobs
 *    report nothing → nothing is billed.
 *
 * Endpoints (overridable via KIE_BASE_URL):
 *   POST {BASE}/api/v1/jobs/createTask   { model, input }  → { data: { taskId } }
 *   GET  {BASE}/api/v1/jobs/recordInfo?taskId=…            → { data: { state, resultJson, creditsConsumed } }
 *   GET  {BASE}/api/v1/chat/credit                         → remaining credits
 */

import type { BuiltinProvider, BuiltinResult } from '@/libs/plugins/types';

const BASE = (process.env.KIE_BASE_URL || 'https://api.kie.ai').replace(/\/$/, '');
const POLL_INTERVAL_MS = 3000;
// Poll close to the serverless request budget (routes cap at 300s) so nearly
// every job — including video — finishes in-band and is billed on its real
// creditsConsumed. Genuine overflows are flagged for reconciliation, not
// silently billed $0.
const MAX_POLL_MS = 285_000;
export const MAX_KEYS = 20;

/** $ per Kie credit — flat across every model on kie.ai/pricing. */
export const KIE_USD_PER_CREDIT = 0.005;

/** Codes that mean "this key is unusable right now" → try the next one. */
const FAILOVER_CODES = new Set([401, 402, 403, 429, 433, 455]);

// Kie treats text-to-video and image-to-video as different models with
// different required inputs — there is no single "make a video" model. Verified
// against docs.kie.ai on 2026-07-15; if these are changed, re-check the input
// shape on the model's doc page, because a wrong shape surfaces only as Kie's
// "This field is required" with no field name.
const VIDEO_MODEL_TEXT_TO_VIDEO = 'kling/v2-5-turbo-text-to-video-pro';
const VIDEO_MODEL_IMAGE_TO_VIDEO = 'kling/v2-1-standard';

/** Round-robin cursor, per process. */
let cursor = 0;

/** The credential may hold many keys — one per line (or comma separated). */
export function parseKeys(credential: string): string[] {
  return credential
    .split(/[\n,\s]+/)
    .map(k => k.trim())
    .filter(Boolean)
    .slice(0, MAX_KEYS);
}

class KieError extends Error {
  code: number;
  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}

async function kieFetch(path: string, apiKey: string, init?: RequestInit) {
  const resp = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const body = await resp.json().catch(() => ({})) as Record<string, unknown>;
  const code = typeof body.code === 'number' ? body.code : resp.status;
  if (!resp.ok || code !== 200) {
    const msg = (body.msg ?? body.message ?? `HTTP ${resp.status}`) as string;
    throw new KieError(`Kie.ai: ${msg}`, code);
  }
  return body;
}

/**
 * Run `fn` with a key, rotating round-robin and failing over to the next key
 * when the current one is rate-limited / out of credit / blocked.
 */
async function withKey<T>(keys: string[], fn: (key: string) => Promise<T>): Promise<T> {
  if (keys.length === 0) {
    throw new Error('No Kie.ai API key configured.');
  }
  let lastErr: unknown;
  for (let attempt = 0; attempt < keys.length; attempt++) {
    const key = keys[(cursor + attempt) % keys.length]!;
    try {
      const out = await fn(key);
      cursor = (cursor + attempt + 1) % keys.length; // advance for the next call
      return out;
    } catch (err) {
      lastErr = err;
      const code = err instanceof KieError ? err.code : 0;
      if (!FAILOVER_CODES.has(code)) {
        throw err; // a real error (bad prompt, failed generation) — don't burn keys
      }
      // else: this key is unusable → try the next one
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : 'all keys failed';
  throw new Error(`Kie.ai: every configured API key failed (${msg}). Check credit balance and rate limits.`);
}

function extractUrls(rec: Record<string, unknown>): string[] {
  const raw = rec.resultJson ?? rec.result ?? rec.response;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const pool = (parsed as Record<string, unknown>) ?? {};
    return [pool.resultUrls, pool.result_urls, pool.urls, pool.videoUrl, pool.imageUrl, pool.url]
      .flat()
      .filter(Boolean)
      .map(String);
  } catch {
    return raw ? [String(raw)] : [];
  }
}

/** Create an async job, poll to completion, report the URLs + credits used. */
async function runJob(
  model: string,
  input: Record<string, unknown>,
  keys: string[],
): Promise<BuiltinResult> {
  // The whole job (create + poll) rides the same key — a taskId only exists on
  // the account that created it.
  return withKey(keys, async (apiKey) => {
    const created = await kieFetch('/api/v1/jobs/createTask', apiKey, {
      method: 'POST',
      body: JSON.stringify({ model, input }),
    });

    const data = (created.data ?? {}) as Record<string, unknown>;
    const taskId = (data.taskId ?? data.task_id) as string | undefined;
    if (!taskId) {
      throw new Error('Kie.ai did not return a task id.');
    }

    const started = Date.now();
    while (Date.now() - started < MAX_POLL_MS) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

      const info = await kieFetch(`/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, apiKey);
      const rec = (info.data ?? {}) as Record<string, unknown>;
      const state = String(rec.state ?? rec.status ?? '').toLowerCase();

      if (state === 'success' || state === 'succeeded' || state === 'completed') {
        const urls = extractUrls(rec);
        const credits = Number(rec.creditsConsumed ?? 0) || 0;
        return {
          output: JSON.stringify({
            taskId,
            model,
            state: 'success',
            urls,
            creditsConsumed: credits,
            note: 'Kie.ai deletes generated media after 14 days — Artivio archives it to the workspace library automatically, so use the library URL in anything you publish.',
          }),
          units: credits,
          assetUrls: urls,
        };
      }

      if (state === 'fail' || state === 'failed' || state === 'error') {
        // Failed generations consume nothing → nothing is billed.
        throw new Error(`Kie.ai job failed: ${String(rec.failMsg ?? rec.msg ?? 'unknown reason')}`);
      }
    }

    return {
      output: JSON.stringify({
        taskId,
        state: 'still_running',
        note: 'The job is still running on Kie.ai after the poll window. It may complete later; the credits it consumes are NOT yet billed. Tell the user it is still processing and check kie.ai/logs with this task id.',
      }),
      // Signals the registry to flag this for reconciliation — Kie WILL charge
      // us for a job that eventually completes, so an unbilled overflow must be
      // visible in the Issues inbox, never a silent $0.
      pendingReconcile: taskId,
    };
  });
}

export const kieProvider: BuiltinProvider = {
  slug: 'kie-ai',
  name: 'Kie.ai (images, video, music)',
  description: 'Generate images, videos and music through Kie.ai\'s unified API (Nano Banana, Veo, Kling, Seedream, Suno, ElevenLabs and more) — typically 30–80% below official API prices.',
  credentialLabel: 'Kie.ai API keys from kie.ai/api-key — paste up to 20, one per line. Calls round-robin across them and fail over automatically.',
  multiKey: true,
  usageMetering: {
    unitLabel: 'credit',
    defaultUnitCostUsd: KIE_USD_PER_CREDIT,
    note: 'Kie.ai reports the exact credits each job consumed, and credits cost a flat $0.005 across every model. Billing every model correctly needs one number — no price table to maintain.',
  },

  tools: [
    {
      name: 'generate_image',
      description: 'Generate an image from a text prompt via Kie.ai. Returns image URL(s). Use for social posts, blog headers, ad creative. Pass `model` to pick a specific one (e.g. "google/nano-banana", "bytedance/seedream-v4-text-to-image", "flux-2/pro-text-to-image").',
      input_schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'What to generate — be specific about subject, style, composition.' },
          model: { type: 'string', description: 'Optional Kie.ai model id. Defaults to google/nano-banana.' },
          aspect_ratio: { type: 'string', description: 'e.g. 1:1, 16:9, 9:16' },
          image_urls: { type: 'array', items: { type: 'string' }, description: 'Optional reference/source images for editing models.' },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'generate_video',
      description: 'Generate a video via Kie.ai. Give a prompt alone for text-to-video, or a prompt plus image_url to animate an existing image. The right model is chosen automatically. Async — may take a few minutes. Returns video URL(s). Videos are the most expensive thing you can do: confirm the plan with the user before generating.',
      input_schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'What should happen in the video. Describe motion, camera and pacing, not just a static scene.' },
          image_url: { type: 'string', description: 'Optional. Supply a public image URL to animate it (image-to-video); omit for text-to-video.' },
          duration_seconds: { type: 'number', description: 'Video length in seconds. Defaults to 5. Longer = more credits.' },
          aspect_ratio: { type: 'string', description: 'e.g. 16:9, 9:16, 1:1. Defaults to 16:9. Ignored when image_url is set — the image fixes the frame.' },
          model: { type: 'string', description: 'Optional Kie.ai model id override. Leave unset unless you know the exact id and its required inputs; a wrong id fails with an unhelpful "This field is required".' },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'generate_music',
      description: 'Generate a music track or audio clip via Kie.ai (Suno). Returns audio URL(s).',
      input_schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Style/mood/lyrics brief.' },
          model: { type: 'string', description: 'Optional model id.' },
          instrumental: { type: 'boolean' },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'kie_credits',
      description: 'Check how many Kie.ai credits remain on the account behind this plugin.',
      input_schema: { type: 'object', properties: {} },
    },
  ],

  call: async (tool, args, credential) => {
    const keys = parseKeys(credential);

    if (tool === 'kie_credits') {
      // Report every key's balance — that's what the operator actually needs.
      const balances = await Promise.all(keys.map(async (key, i) => {
        try {
          const body = await kieFetch('/api/v1/chat/credit', key);
          return { key: `key ${i + 1}`, credits: body.data ?? body };
        } catch (err) {
          return { key: `key ${i + 1}`, error: err instanceof Error ? err.message : 'unavailable' };
        }
      }));
      return JSON.stringify({ keys: balances.length, balances });
    }

    if (tool === 'generate_image') {
      const model = String(args.model || 'google/nano-banana');
      const input: Record<string, unknown> = { prompt: String(args.prompt ?? '') };
      if (args.aspect_ratio) {
        input.aspect_ratio = args.aspect_ratio;
      }
      if (Array.isArray(args.image_urls) && args.image_urls.length > 0) {
        input.image_urls = args.image_urls;
      }
      return runJob(model, input, keys);
    }

    if (tool === 'generate_video') {
      // Kie exposes text-to-video and image-to-video as SEPARATE models with
      // different required inputs. This used to default everything to
      // kling/v2-1-standard — which is image-to-video and REQUIRES image_url —
      // so every text-to-video request died with Kie's unhelpful
      // "This field is required" and no clue which field.
      //
      // Verified against docs.kie.ai 2026-07-15:
      //   text-to-video  kling/v2-5-turbo-text-to-video-pro
      //                  { prompt, duration:"5", aspect_ratio:"16:9" }
      //   image-to-video kling/v2-1-standard
      //                  { prompt, image_url, duration:"5" }   (no aspect_ratio)
      const hasImage = Boolean(args.image_url);
      const model = String(
        args.model || (hasImage ? VIDEO_MODEL_IMAGE_TO_VIDEO : VIDEO_MODEL_TEXT_TO_VIDEO),
      );

      const input: Record<string, unknown> = { prompt: String(args.prompt ?? '') };
      if (hasImage) {
        input.image_url = String(args.image_url);
      }
      // duration is a STRING in Kie's API ("5"), not a number. Sending a number
      // is silently rejected.
      input.duration = String(args.duration_seconds ? Math.round(Number(args.duration_seconds)) : 5);
      // aspect_ratio applies to text-to-video; an image already fixes the frame.
      if (!hasImage) {
        input.aspect_ratio = String(args.aspect_ratio || '16:9');
      }

      return runJob(model, input, keys);
    }

    if (tool === 'generate_music') {
      const model = String(args.model || 'suno/v5');
      const input: Record<string, unknown> = {
        prompt: String(args.prompt ?? ''),
        instrumental: Boolean(args.instrumental),
      };
      return runJob(model, input, keys);
    }

    throw new Error(`Unknown Kie.ai tool: ${tool}`);
  },
};
