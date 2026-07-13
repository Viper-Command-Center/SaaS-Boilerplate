/**
 * Kie.ai — built-in tier-1 provider (image / video / music generation).
 *
 * Kie.ai has no MCP server; it exposes a unified REST API where every job is
 * ASYNC: create a task → poll until it completes. We wrap that here so the
 * agent gets simple, synchronous-feeling tools, and so every generation is
 * metered against the workspace's credits.
 *
 * Endpoints (overridable via env if Kie.ai moves them):
 *   POST {KIE_BASE}/api/v1/jobs/createTask   { model, input }  → { data: { taskId } }
 *   GET  {KIE_BASE}/api/v1/jobs/recordInfo?taskId=…            → { data: { state, resultJson } }
 *   GET  {KIE_BASE}/api/v1/chat/credit                          → remaining credits
 */

import type { BuiltinProvider } from '@/libs/plugins/types';

const BASE = (process.env.KIE_BASE_URL || 'https://api.kie.ai').replace(/\/$/, '');
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_MS = 240_000; // 4 minutes — video can be slow

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
  if (!resp.ok || (typeof body.code === 'number' && body.code !== 200)) {
    const msg = (body.msg ?? body.message ?? `HTTP ${resp.status}`) as string;
    throw new Error(`Kie.ai: ${msg}`);
  }
  return body;
}

/** Create an async job and poll until it finishes; returns the result URLs. */
async function runJob(model: string, input: Record<string, unknown>, apiKey: string): Promise<string> {
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
      const raw = rec.resultJson ?? rec.result ?? rec.response;
      let urls: string[] = [];
      try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const pool = (parsed as Record<string, unknown>) ?? {};
        const candidates = [
          pool.resultUrls,
          pool.result_urls,
          pool.urls,
          pool.videoUrl,
          pool.imageUrl,
          pool.url,
        ].flat().filter(Boolean);
        urls = candidates.map(String);
      } catch {
        urls = [String(raw)];
      }
      return JSON.stringify({
        taskId,
        state: 'success',
        urls,
        note: 'Kie.ai stores generated media for 14 days — download anything you want to keep.',
      });
    }

    if (state === 'fail' || state === 'failed' || state === 'error') {
      throw new Error(`Kie.ai job failed: ${String(rec.failMsg ?? rec.msg ?? 'unknown reason')}`);
    }
  }

  return JSON.stringify({
    taskId,
    state: 'still_running',
    note: 'The job is taking longer than 4 minutes. It is still running on Kie.ai — check the task id later at kie.ai/logs.',
  });
}

export const kieProvider: BuiltinProvider = {
  slug: 'kie-ai',
  name: 'Kie.ai (images, video, music)',
  description: 'Generate images, videos and music through Kie.ai\'s unified API (Nano Banana, Veo, Kling, Seedream, Suno, ElevenLabs and more) — typically 30–80% below official API prices.',
  credentialLabel: 'Kie.ai API key (from kie.ai/api-key)',

  tools: [
    {
      name: 'generate_image',
      description: 'Generate an image from a text prompt via Kie.ai. Returns image URL(s). Use for social posts, blog headers, ad creative. Default model is a fast, high-quality one; pass `model` to pick another (e.g. "google/nano-banana", "bytedance/seedream-v4-text-to-image", "flux-2/pro-text-to-image").',
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
      description: 'Generate a video from a text prompt (or an image) via Kie.ai. Async — this may take a few minutes. Returns video URL(s). Videos are expensive: always confirm the plan with the user before generating.',
      meteredArg: 'duration_seconds',
      input_schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          model: { type: 'string', description: 'Optional Kie.ai model id. Defaults to kling/v2-1-standard.' },
          image_url: { type: 'string', description: 'Optional source image for image-to-video.' },
          duration_seconds: { type: 'number', description: 'Requested duration in seconds (drives cost).' },
          aspect_ratio: { type: 'string' },
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
      description: 'Check how many Kie.ai credits remain on the platform account.',
      input_schema: { type: 'object', properties: {} },
    },
  ],

  call: async (tool, args, apiKey) => {
    if (tool === 'kie_credits') {
      const body = await kieFetch('/api/v1/chat/credit', apiKey);
      return JSON.stringify({ credits: body.data ?? body });
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
      return runJob(model, input, apiKey);
    }

    if (tool === 'generate_video') {
      const model = String(args.model || 'kling/v2-1-standard');
      const input: Record<string, unknown> = { prompt: String(args.prompt ?? '') };
      if (args.image_url) {
        input.image_url = args.image_url;
      }
      if (args.duration_seconds) {
        input.duration = Number(args.duration_seconds);
      }
      if (args.aspect_ratio) {
        input.aspect_ratio = args.aspect_ratio;
      }
      return runJob(model, input, apiKey);
    }

    if (tool === 'generate_music') {
      const model = String(args.model || 'suno/v5');
      const input: Record<string, unknown> = {
        prompt: String(args.prompt ?? ''),
        instrumental: Boolean(args.instrumental),
      };
      return runJob(model, input, apiKey);
    }

    throw new Error(`Unknown Kie.ai tool: ${tool}`);
  },
};
