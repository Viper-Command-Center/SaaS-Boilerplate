/**
 * Kie.ai — built-in tier-1 provider (image / video / speech generation).
 *
 * Kie.ai has no MCP server; it exposes a unified REST API where every job is
 * ASYNC: create a task → poll until it completes. We wrap that here so the
 * agent gets simple, synchronous-feeling tools.
 *
 * ⚠️ THE THING TO UNDERSTAND BEFORE EDITING THIS FILE
 *
 * A hosted MCP server publishes its own tools and schemas, so the vendor's
 * expertise arrives with the connection — that's why Zernio worked first try.
 * Kie is NOT an MCP. Everything the agent "knows" about Kie is what is written
 * here. There is no models API and no schema endpoint, so a wrong id or payload
 * cannot be discovered at runtime — it comes back as a bare
 * "This field is required" naming no field. Model ids and input shapes therefore
 * live in kie-models.ts, each with the doc URL and date it was verified against.
 * Never add one by pattern-matching a sibling: `nano-banana-2` is bare while
 * `google/nano-banana-edit` is prefixed, and both are correct.
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
import {
  type KieCapability,
  KIE_MODELS,
  defaultKieModel,
  kieModel,
  kieModelsFor,
} from '@/libs/plugins/kie-models';

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

/**
 * Resolve which model backs a job, and build its exact payload.
 *
 * `model` used to be a free-text string on every tool — an open field into a
 * space the agent cannot enumerate (Kie publishes no models API, and their
 * llms.txt carries no ids). It filled that field from priors and was wrong, and
 * Kie's rejection is a bare "This field is required" with no field name.
 *
 * The fix was NOT to describe the models better. Each capability now has exactly
 * ONE verified model and the `model` argument is gone from every tool schema —
 * the agent cannot pass what it cannot see, so there is nothing to get wrong.
 * `requested` is therefore always undefined today; the parameter stays as
 * defense in depth (and because adding a second model to a capability is a real
 * future decision — see the note in kie-models.ts before you do).
 */
function resolveModel(capability: KieCapability, requested: unknown) {
  const chosen = requested ? kieModel(String(requested)) : defaultKieModel(capability);
  if (!chosen) {
    const options = kieModelsFor(capability).map(m => `${m.id} (${m.label})`).join(', ');
    throw new Error(
      `Unknown Kie.ai model "${String(requested)}". Verified models for ${capability}: ${options}. `
      + `Call list_kie_models to see every model this workspace can use, with its options. `
      + `Kie has ~368 models but only these are verified against their docs — an unverified id fails with an error that names no field.`,
    );
  }
  if (chosen.capability !== capability) {
    throw new Error(
      `Model "${chosen.id}" is a ${chosen.capability} model, not ${capability}. ${chosen.guidance}`,
    );
  }
  return chosen;
}

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
  name: 'Kie.ai (images, video, voiceover)',
  description: 'Generate images, video and voiceover through Kie.ai\'s unified API (Nano Banana 2, Kling, Seedream, Topaz, Recraft, ElevenLabs) — typically 30–80% below official API prices. Music is not currently available.',
  credentialLabel: 'Kie.ai API keys from kie.ai/api-key — paste up to 20, one per line. Calls round-robin across them and fail over automatically.',
  multiKey: true,
  usageMetering: {
    unitLabel: 'credit',
    defaultUnitCostUsd: KIE_USD_PER_CREDIT,
    note: 'Kie.ai reports the exact credits each job consumed, and credits cost a flat $0.005 across every model. Billing every model correctly needs one number — no price table to maintain.',
  },

  tools: [
    {
      name: 'list_kie_models',
      description:
        'List which model backs each Kie.ai job, and the options that job accepts (aspect ratios, resolutions, voice IDs). Use this to see what is possible before generating — e.g. which voice IDs exist for a voiceover, or which aspect ratios an image supports. You do NOT choose the model: each job is locked to one, deliberately, so that a client\'s output stays visually consistent. There is no model argument on any tool.',
      input_schema: {
        type: 'object',
        properties: {
          capability: {
            type: 'string',
            enum: ['text_to_image', 'image_edit', 'upscale', 'remove_background', 'text_to_video', 'image_to_video', 'text_to_speech'],
            description: 'Optional filter. Omit to list everything.',
          },
        },
      },
    },
    {
      name: 'generate_image',
      description: 'Generate an image from a text prompt via Kie.ai (Nano Banana 2). Returns image URL(s). Use for social posts, blog headers, ad creative. Covers every common social ratio up to 4K.',
      input_schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'What to generate — be specific about subject, style, composition.' },
          aspect_ratio: { type: 'string', description: 'e.g. 1:1, 4:5 (Instagram portrait), 9:16 (story/reel), 16:9. Defaults to auto.' },
          resolution: { type: 'string', description: '1K, 2K or 4K. Defaults to 1K. Higher costs more credits.' },
          image_input: { type: 'array', items: { type: 'string' }, description: 'Optional reference image URLs to guide style/subject (up to 14). To EDIT an existing image instead, use edit_image.' },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'edit_image',
      description: 'Edit or restyle an existing image via Kie.ai. Requires at least one source image URL. Use this — not generate_image — when the user wants to change a picture they already have.',
      input_schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'What to change about the image.' },
          image_urls: { type: 'array', items: { type: 'string' }, description: 'Source image URL(s), max 10, each ≤10MB.' },
          aspect_ratio: { type: 'string' },
        },
        required: ['prompt', 'image_urls'],
      },
    },
    {
      name: 'upscale_image',
      description: 'Enlarge an image without losing quality (Topaz), for print or hero use. Input must be ≤10MB.',
      input_schema: {
        type: 'object',
        properties: {
          image_url: { type: 'string', description: 'Public URL of the image to upscale.' },
          upscale_factor: { type: 'number', description: '1, 2, 4 or 8. Defaults to 2.' },
        },
        required: ['image_url'],
      },
    },
    {
      name: 'remove_background',
      description: 'Cut a product or person out of its background (Recraft), leaving transparency. Max 5MB / 16MP / 4096px; min 256px.',
      input_schema: {
        type: 'object',
        properties: {
          image_url: { type: 'string', description: 'Public URL of the image.' },
        },
        required: ['image_url'],
      },
    },
    {
      name: 'generate_video',
      description: 'Generate a video via Kie.ai. Give a prompt alone for text-to-video, or a prompt plus image_url to animate an existing image — the right model is chosen automatically. Async: may take a few minutes. Videos are the most expensive thing you can do here: confirm the plan with the user before generating.',
      input_schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'What should happen in the video. Describe motion, camera and pacing, not just a static scene.' },
          image_url: { type: 'string', description: 'Optional. Supply a public image URL to animate it (image-to-video); omit for text-to-video.' },
          duration_seconds: { type: 'number', description: 'Video length in seconds. Defaults to 5. Longer = more credits.' },
          aspect_ratio: { type: 'string', description: 'e.g. 16:9, 9:16, 1:1. Defaults to 16:9. Ignored when image_url is set — the image fixes the frame.' },
        },
        required: ['prompt'],
      },
    },
    {
      name: 'generate_speech',
      description: 'Generate a voiceover / spoken audio track from text (ElevenLabs Multilingual v2). Use for video narration and ads. Call list_kie_models to see the available voices before picking one.',
      input_schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The script to speak. Max 5000 characters.' },
          voice: { type: 'string', description: 'A voice ID from list_kie_models. Must be an ID, not a name like "Rachel" — names are not in the API schema and fail on a paid call.' },
          speed: { type: 'number', description: '0.7–1.2. Defaults to 1.' },
        },
        required: ['text'],
      },
    },
    {
      name: 'kie_credits',
      description: 'Check how many Kie.ai credits remain on the account behind this plugin.',
      input_schema: { type: 'object', properties: {} },
    },
    // NOTE: there is deliberately NO music/Suno tool. See the call() comment.
  ],

  call: async (tool, args, credential) => {
    const keys = parseKeys(credential);

    if (tool === 'list_kie_models') {
      const wanted = args.capability ? String(args.capability) : null;
      const models = wanted
        ? kieModelsFor(wanted as KieCapability)
        : KIE_MODELS;
      return JSON.stringify({
        models: models.map(m => ({
          id: m.id,
          capability: m.capability,
          label: m.label,
          use_when: m.guidance,
          options: m.options ?? 'no options beyond the required inputs',
          verified: m.verifiedAt,
        })),
        note:
          'Each job is locked to exactly one model, verified against Kie.ai\'s own documentation. This is deliberate: a client\'s output should look consistent, so the model is chosen once by the operator rather than per request. You do not select a model and no tool accepts one. Kie hosts ~368 models but publishes no schema API, so anything not listed here is unverified and unavailable. If a job genuinely needs something that is not here, say so plainly and suggest the operator add it — do not imply you could use another model, and do not guess.',
      });
    }

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

    // Every generate path is the same three steps: resolve the model against the
    // verified table → let the model build its own exact payload → run. All the
    // per-model quirks (string-vs-number, which key names the image goes under,
    // png vs jpg vs jpeg) live in kie-models.ts next to the doc URL that proves
    // them, instead of being spread through this switch.

    if (tool === 'generate_image') {
      const m = resolveModel('text_to_image', args.model);
      return runJob(m.id, m.build(args), keys);
    }

    if (tool === 'edit_image') {
      const m = resolveModel('image_edit', args.model);
      if (!Array.isArray(args.image_urls) || args.image_urls.length === 0) {
        throw new Error('edit_image needs at least one source image URL. To create a NEW image from a prompt, use generate_image instead.');
      }
      return runJob(m.id, m.build(args), keys);
    }

    if (tool === 'upscale_image') {
      const m = resolveModel('upscale', args.model);
      return runJob(m.id, m.build(args), keys);
    }

    if (tool === 'remove_background') {
      const m = resolveModel('remove_background', args.model);
      return runJob(m.id, m.build(args), keys);
    }

    if (tool === 'generate_video') {
      // Kie exposes text-to-video and image-to-video as SEPARATE models with
      // different required inputs. This once defaulted everything to
      // kling/v2-1-standard — which is image-to-video and REQUIRES image_url —
      // so every text-to-video request died on Kie's "This field is required"
      // with no clue which field. Presence of image_url picks the capability.
      const capability: KieCapability = args.image_url ? 'image_to_video' : 'text_to_video';
      const m = resolveModel(capability, args.model);
      if (capability === 'image_to_video' && !args.image_url) {
        throw new Error(`${m.id} animates an existing image and requires image_url.`);
      }
      return runJob(m.id, m.build(args), keys);
    }

    if (tool === 'generate_speech') {
      const m = resolveModel('text_to_speech', args.model);
      return runJob(m.id, m.build(args), keys);
    }

    // MUSIC / SUNO — deliberately absent, and this is the honest place to say why.
    //
    // The old `generate_music` POSTed { model:'suno/v5', input:{…} } to
    // /api/v1/jobs/createTask. Every part of that was wrong: Suno is not a Market
    // model, it's a separate legacy API at /api/v1/generate with no `input`
    // wrapper, a different model namespace ("V5", not "suno/v5"), a REQUIRED
    // callBackUrl, and its own poll endpoint. It never worked.
    //
    // It is not re-implemented because /api/v1/generate/record-info does NOT
    // return `creditsConsumed` — the single field every Kie tool's billing reads.
    // A working music tool would bill the client $0 while Kie burns real credits
    // on our account: the Phase 18 money-leak class, shipped on purpose. Music
    // returns when there's a verified way to meter it.
    if (tool === 'generate_music') {
      throw new Error(
        'Music generation is not available on this platform yet. Kie\'s Suno endpoint does not report the credits a job consumed, so it cannot be billed correctly, and it was removed rather than run unmetered. This is a platform limitation — do not suggest workarounds or alternative music services as though they were configured here. Tell the user it is unavailable and, if they need it, that it can be raised with the operator.',
      );
    }

    throw new Error(`Unknown Kie.ai tool: ${tool}`);
  },
};
