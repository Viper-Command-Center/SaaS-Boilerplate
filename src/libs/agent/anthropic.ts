/**
 * Multi-provider Claude transport (no SDK deps) — same pattern proven in the
 * BudgetSmart marketing repo. First configured provider wins:
 *   1. BEDROCK_MANTLE_API_KEY — Bedrock Mantle (see below). Per-call model
 *      selection; this is what powers workspace-level model assignment.
 *   2. BEDROCK_API_KEY  — legacy Bedrock bearer-token invoke (non-streaming;
 *      the reply is yielded in one chunk). ONE model for the whole platform —
 *      kept only as a fallback for as long as Mantle isn't configured.
 *   3. ANTHROPIC_API_KEY / CLAUDE_API_KEY — api.anthropic.com with true
 *      token-by-token streaming. Same one-model limitation as #2.
 *
 * MANTLE (Phase 43 / 2026-09-12, Ryan): Amazon Bedrock Mantle is a newer
 * Bedrock endpoint — distinct from classic bedrock-runtime — that exposes
 * Claude AND third-party models (Kimi, DeepSeek, Nemotron, GLM, Qwen, Grok,
 * GPT-*…) through two OpenAI-/Anthropic-compatible surfaces, both auth'd with
 * a plain `x-api-key` bearer header (no AWS SigV4 signing):
 *   - Anthropic-shaped: POST {base}/anthropic/v1/messages — identical shape
 *     to api.anthropic.com (system/messages/tools/thinking). Used for every
 *     `anthropic.*` model id so Claude keeps native tool_use blocks and
 *     extended-thinking budgets.
 *   - OpenAI-shaped: POST {base}/v1/chat/completions — standard OpenAI
 *     chat-completions shape, with a `reasoning_effort` param
 *     (minimal/low/medium/high) for "how hard should it think". Used for
 *     every non-Claude model id.
 * Whichever shape is used, callClaudeWithTools always speaks Anthropic-style
 * blocks to its caller (loop.ts) — the OpenAI-shaped path converts the
 * message history down and the response back up, so the tool loop, the
 * retry/caching logic and the billing ledger never need to know which model
 * actually served a given call.
 *
 * ⚠️ Tool-use reliability per third-party model is UNVERIFIED — Mantle's own
 * console does not surface a tool-calling capability flag (only "Reasoning"
 * ever appears on a model's detail panel). Ryan's call (2026-09-12): wire
 * every model in now, find out which ones actually hold up under real tool
 * loops via live testing, pull back any that don't. See
 * agent_model_selection.md in project memory before trusting a non-Claude
 * model for unattended build work.
 *
 * RETRY (Phase 27 / P0): transient provider failures — 429 throttling, 5xx,
 * 529 overloaded, and network-level fetch errors — are retried with
 * exponential backoff + jitter (2 retries, so 3 attempts max, ~7s worst
 * case; bounded so a retrying call can't eat the tool loop's wall-clock
 * budget). Retry-After is honoured when the provider sends it. Anything
 * non-transient (400 bad request, 401/403 auth, 413 too large) fails
 * immediately — retrying those just burns time. Before this, ONE Bedrock
 * blip killed the entire agent turn.
 */

export type ChatMessage = { role: 'user' | 'assistant'; content: string };

/** Content-block message shape for tool-use turns. */
export type BlockMessage = { role: 'user' | 'assistant'; content: unknown };

export type RawModelResponse = {
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
  stop_reason: string;
  // Exact token counts, returned in-band by both Bedrock and Anthropic — this
  // is what the cost ledger meters (no need to scrape AWS bills).
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  /** Which model actually served the call (for the ledger). */
  _modelId?: string;
};

/**
 * "How hard should it think" — Mantle's dial on BOTH API shapes (native
 * extended-thinking budget for Claude, `reasoning_effort` for everything
 * else). Chat should default low/undefined (fast, cheap); build work can ask
 * for more.
 */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

// Legacy single-model constants — only read when BEDROCK_MANTLE_API_KEY is
// NOT configured. Once Mantle is on, every call carries its own modelId.
const BEDROCK_MODEL = process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-sonnet-4-6';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

/** Platform default when a workspace hasn't picked a model of its own. */
export const DEFAULT_MANTLE_MODEL = process.env.MANTLE_DEFAULT_MODEL_ID || 'anthropic.claude-sonnet-5';

function bedrockRegion(): string {
  return process.env.BEDROCK_REGION || process.env.AWS_REGION || 'us-east-1';
}

function mantleBaseUrl(): string {
  return process.env.BEDROCK_MANTLE_BASE_URL || `https://bedrock-mantle.${bedrockRegion()}.api.aws`;
}

/**
 * True for every Claude model id we know how to name (the "anthropic.*"
 * Mantle ids) — these go through the Anthropic-shaped endpoint so they keep
 * native tool_use blocks and extended thinking.
 */
function isClaudeModelId(modelId: string): boolean {
  return /claude|anthropic/i.test(modelId);
}

// ─── Transient-failure retry ─────────────────────────────────────────────────

const MAX_ATTEMPTS = 3; // 1 try + 2 retries
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 8_000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function retryDelayMs(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1_000, MAX_DELAY_MS);
    }
  }
  const backoff = BASE_DELAY_MS * 2 ** (attempt - 1);
  const jitter = Math.random() * 250;
  return Math.min(backoff + jitter, MAX_DELAY_MS);
}

/**
 * POST with bounded retries on transient failures. Returns the first response
 * that is OK or non-retryable; throws only when every attempt failed at the
 * network level. The caller still owns non-OK handling (error text, status).
 */
async function postWithRetry(
  url: string,
  headers: Record<string, string>,
  body: string,
  label: string,
): Promise<Response> {
  let lastNetworkError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(url, { method: 'POST', headers, body });
    } catch (err) {
      // Network-level failure (DNS, reset, timeout) — transient by nature.
      lastNetworkError = err;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(retryDelayMs(attempt, null));
        continue;
      }
      throw new Error(
        `${label}: network error after ${MAX_ATTEMPTS} attempts (${err instanceof Error ? err.message : 'unknown'})`,
      );
    }
    if (resp.ok || !RETRYABLE_STATUS.has(resp.status) || attempt === MAX_ATTEMPTS) {
      return resp;
    }
    // Drain the failed body so the connection can be reused, then back off.
    await resp.text().catch(() => '');
    await sleep(retryDelayMs(attempt, resp.headers.get('retry-after')));
  }
  // Unreachable, but TypeScript deserves an honest ending.
  throw lastNetworkError instanceof Error ? lastNetworkError : new Error(`${label}: request failed`);
}

async function callBedrockBearer(a: {
  system: string;
  messages: ChatMessage[];
  maxTokens: number;
}): Promise<string> {
  const key = process.env.BEDROCK_API_KEY || process.env.AWS_BEARER_TOKEN_BEDROCK;
  const url = `https://bedrock-runtime.${bedrockRegion()}.amazonaws.com/model/${encodeURIComponent(BEDROCK_MODEL)}/invoke`;
  const resp = await postWithRetry(url, {
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  }, JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: a.maxTokens,
    system: a.system,
    messages: a.messages,
  }), 'Bedrock');
  if (!resp.ok) {
    const detail = (await resp.text().catch(() => '')).slice(0, 300);
    throw new Error(`Bedrock ${resp.status}: ${detail}`);
  }
  const data = await resp.json();
  return data.content?.find((c: { type: string }) => c.type === 'text')?.text || '';
}

async function* streamAnthropicDirect(a: {
  system: string;
  messages: ChatMessage[];
  maxTokens: number;
}): AsyncGenerator<string> {
  const key = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key || '',
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: a.maxTokens,
      system: a.system,
      messages: a.messages,
      stream: true,
    }),
  });

  if (!resp.ok || !resp.body) {
    const detail = (await resp.text().catch(() => '')).slice(0, 300);
    throw new Error(`Anthropic ${resp.status}: ${detail}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      const dataLine = frame.split('\n').find(l => l.startsWith('data:'));
      if (!dataLine) {
        continue;
      }
      try {
        const event = JSON.parse(dataLine.slice(5).trim());
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          yield event.delta.text as string;
        }
        if (event.type === 'error') {
          throw new Error(event.error?.message || 'Anthropic stream error');
        }
      } catch (err) {
        if (err instanceof SyntaxError) {
          continue; // partial/non-JSON frame — ignore
        }
        throw err;
      }
    }
  }
}

/**
 * PROMPT CACHING — the single biggest lever on gross margin.
 *
 * Every turn (and every iteration of the tool loop) re-sends the same system
 * prompt and the same tool definitions. That prefix is easily thousands of
 * tokens and it is IDENTICAL every time. Cached reads cost ~10% of fresh input
 * tokens, so caching the prefix cuts the dominant cost of a long agent turn.
 *
 * The request prefix is ordered tools → system → messages, and a cache
 * breakpoint caches everything up to and including the block it is on. So a
 * SINGLE breakpoint on the system block caches both the tools and the system
 * prompt. Below the model's minimum cacheable length the breakpoint is simply
 * ignored (no error), so this is safe for small prompts too.
 */
function cachedSystem(system: string) {
  return [
    {
      type: 'text',
      text: system,
      cache_control: { type: 'ephemeral' },
    },
  ];
}

/**
 * Extended-thinking budget for a Claude call on the Anthropic-shaped Mantle
 * endpoint. undefined/'minimal'/'low' → no thinking block at all (fastest,
 * cheapest — the right default for chat). 'medium'/'high' turn it on.
 */
function claudeThinkingBudget(effort: ReasoningEffort | undefined): number | undefined {
  if (effort === 'high') {
    return 8_192;
  }
  if (effort === 'medium') {
    return 2_048;
  }
  return undefined;
}

// Mantle validates headers STRICTLY per API format — sending the OTHER
// format's project header on a request gets a 400 ("openai-project header
// is not supported for this API format"), confirmed live 2026-09-12. So
// these are deliberately separate builders, never a shared one with both
// headers on it.
function mantleAnthropicHeaders(key: string): Record<string, string> {
  return {
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    'anthropic-workspace-id': process.env.BEDROCK_MANTLE_PROJECT || 'default',
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

function mantleOpenAIHeaders(key: string): Record<string, string> {
  return {
    'x-api-key': key,
    'OpenAI-Project': process.env.BEDROCK_MANTLE_PROJECT || 'default',
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

async function callMantleAnthropic(a: {
  modelId: string;
  system: string;
  messages: BlockMessage[];
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  maxTokens: number;
  reasoningEffort?: ReasoningEffort;
}): Promise<RawModelResponse> {
  const key = process.env.BEDROCK_MANTLE_API_KEY!;
  const budgetTokens = claudeThinkingBudget(a.reasoningEffort);
  // Anthropic requires max_tokens to exceed the thinking budget.
  const maxTokens = budgetTokens ? Math.max(a.maxTokens, budgetTokens + 1_024) : a.maxTokens;

  const resp = await postWithRetry(`${mantleBaseUrl()}/anthropic/v1/messages`, mantleAnthropicHeaders(key), JSON.stringify({
    model: a.modelId,
    max_tokens: maxTokens,
    system: cachedSystem(a.system),
    messages: a.messages,
    ...(a.tools.length > 0 ? { tools: a.tools } : {}),
    ...(budgetTokens ? { thinking: { type: 'enabled', budget_tokens: budgetTokens } } : {}),
  }), 'Bedrock Mantle (Anthropic)');
  if (!resp.ok) {
    const detail = (await resp.text().catch(() => '')).slice(0, 300);
    throw new Error(`Bedrock Mantle ${resp.status}: ${detail}`);
  }
  const data = await resp.json() as RawModelResponse;
  data._modelId = a.modelId;
  return data;
}

// ─── OpenAI-shaped Mantle path (every non-Claude model) ─────────────────────
// loop.ts builds and re-sends message history in Anthropic block shape
// regardless of which model is serving a turn, so every call through here
// converts that history down to OpenAI chat-completions shape, and converts
// the reply back up to the same RawModelResponse shape the Anthropic path
// returns — the tool loop, retry/caching logic and billing ledger stay
// completely unaware of which shape actually went over the wire.

function anthropicToolsToOpenAI(tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>) {
  return tools.map(t => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

/**
 * A single Anthropic content block, loosely typed — the shapes vary by role
 * and this module only reads the fields it needs to convert.
 */
type AnthropicBlock = {
  type: string;
  text?: string;
  id?: string;
  tool_use_id?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  source?: { type: string; media_type: string; data: string };
  is_error?: boolean;
};

function blockMessagesToOpenAI(system: string, messages: BlockMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [{ role: 'system', content: system }];

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }
    const blocks = (Array.isArray(msg.content) ? msg.content : []) as AnthropicBlock[];

    if (msg.role === 'assistant') {
      const textParts = blocks.filter(b => b.type === 'text').map(b => b.text ?? '').filter(Boolean);
      const toolUses = blocks.filter(b => b.type === 'tool_use');
      const entry: Record<string, unknown> = { role: 'assistant', content: textParts.join('\n') || null };
      if (toolUses.length > 0) {
        entry.tool_calls = toolUses.map(t => ({
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) },
        }));
      }
      out.push(entry);
      continue;
    }

    // user role: text/image blocks stay one message; each tool_result becomes
    // its OWN message (OpenAI has no concept of a multi-result turn).
    const contentParts: Array<Record<string, unknown>> = [];
    for (const b of blocks) {
      if (b.type === 'text' && b.text) {
        contentParts.push({ type: 'text', text: b.text });
      } else if (b.type === 'image' && b.source) {
        contentParts.push({ type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
      } else if (b.type === 'tool_result') {
        // Flush any accumulated text/image content as its own user message
        // first, so ordering (text/images, then the tool result) survives.
        if (contentParts.length > 0) {
          out.push({ role: 'user', content: contentParts.slice() });
          contentParts.length = 0;
        }
        const resultContent = b.content;
        const text = typeof resultContent === 'string'
          ? resultContent
          : Array.isArray(resultContent)
            ? (resultContent as AnthropicBlock[]).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n')
            : '';
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: text });
      }
    }
    if (contentParts.length > 0) {
      out.push({ role: 'user', content: contentParts.length === 1 && contentParts[0]?.type === 'text' ? contentParts[0].text : contentParts });
    }
  }

  return out;
}

function openAIStopReason(finishReason: string): string {
  if (finishReason === 'tool_calls') {
    return 'tool_use';
  }
  if (finishReason === 'length') {
    return 'max_tokens';
  }
  return 'end_turn';
}

function openAIResponseToRaw(data: {
  choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}, modelId: string): RawModelResponse {
  const choice = data.choices?.[0];
  const content: RawModelResponse['content'] = [];
  if (choice?.message?.content) {
    content.push({ type: 'text', text: choice.message.content });
  }
  for (const call of choice?.message?.tool_calls ?? []) {
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(call.function.arguments || '{}');
    } catch {
      input = {};
    }
    content.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
  }
  return {
    content,
    stop_reason: openAIStopReason(choice?.finish_reason ?? 'stop'),
    usage: {
      input_tokens: data.usage?.prompt_tokens ?? 0,
      output_tokens: data.usage?.completion_tokens ?? 0,
      cache_read_input_tokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
    _modelId: modelId,
  };
}

async function callMantleOpenAI(a: {
  modelId: string;
  system: string;
  messages: BlockMessage[];
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  maxTokens: number;
  reasoningEffort?: ReasoningEffort;
}): Promise<RawModelResponse> {
  const key = process.env.BEDROCK_MANTLE_API_KEY!;
  const resp = await postWithRetry(`${mantleBaseUrl()}/v1/chat/completions`, mantleOpenAIHeaders(key), JSON.stringify({
    model: a.modelId,
    max_tokens: a.maxTokens,
    messages: blockMessagesToOpenAI(a.system, a.messages),
    ...(a.tools.length > 0 ? { tools: anthropicToolsToOpenAI(a.tools), tool_choice: 'auto' } : {}),
    ...(a.reasoningEffort ? { reasoning_effort: a.reasoningEffort } : {}),
  }), 'Bedrock Mantle (OpenAI)');
  if (!resp.ok) {
    const detail = (await resp.text().catch(() => '')).slice(0, 300);
    throw new Error(`Bedrock Mantle ${resp.status}: ${detail}`);
  }
  const data = await resp.json();
  return openAIResponseToRaw(data, a.modelId);
}

/**
 * Tool-capable single model call (non-streaming) — used by the agent tool
 * loop. Model selection:
 *   - BEDROCK_MANTLE_API_KEY set → routes through Bedrock Mantle, using
 *     `a.modelId` (falls back to DEFAULT_MANTLE_MODEL when the caller didn't
 *     resolve one) and `a.reasoningEffort`. This is what makes per-workspace,
 *     per-context (chat vs. build) model choice actually take effect.
 *   - Otherwise: legacy behaviour, completely unchanged — ONE platform-wide
 *     model (BEDROCK_MODEL/ANTHROPIC_MODEL), `a.modelId`/`a.reasoningEffort`
 *     are ignored. This is intentional: flipping every workspace onto a new
 *     API host on deploy, on a guess about which existing key is valid there,
 *     is exactly the kind of change that should be an explicit opt-in — see
 *     agent_model_selection.md for what to check before setting
 *     BEDROCK_MANTLE_API_KEY in Railway.
 * Transient failures are retried (see postWithRetry above) on every path.
 */
export async function callClaudeWithTools(a: {
  system: string;
  messages: BlockMessage[];
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  maxTokens?: number;
  modelId?: string;
  reasoningEffort?: ReasoningEffort;
}): Promise<RawModelResponse> {
  // 16k, not 4k: a start_mission call with a dozen detailed step instructions
  // is routinely >4k output tokens. At 4096 the response stopped at
  // max_tokens, the loop read it as a final answer, and the mission the agent
  // had just announced was silently never created (2026-08-03 incident).
  // Sonnet supports far more; the loop also now RECOVERS from max_tokens
  // truncation, but headroom means it almost never has to.
  const maxTokens = a.maxTokens ?? 16_384;

  if (process.env.BEDROCK_MANTLE_API_KEY) {
    const modelId = a.modelId || DEFAULT_MANTLE_MODEL;
    return isClaudeModelId(modelId)
      ? callMantleAnthropic({ modelId, system: a.system, messages: a.messages, tools: a.tools, maxTokens, reasoningEffort: a.reasoningEffort })
      : callMantleOpenAI({ modelId, system: a.system, messages: a.messages, tools: a.tools, maxTokens, reasoningEffort: a.reasoningEffort });
  }

  const wantsBedrockBearer = Boolean(process.env.BEDROCK_API_KEY || process.env.AWS_BEARER_TOKEN_BEDROCK);
  const wantsAnthropic = Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY);

  if (wantsBedrockBearer) {
    const key = process.env.BEDROCK_API_KEY || process.env.AWS_BEARER_TOKEN_BEDROCK;
    const url = `https://bedrock-runtime.${bedrockRegion()}.amazonaws.com/model/${encodeURIComponent(BEDROCK_MODEL)}/invoke`;
    const resp = await postWithRetry(url, {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    }, JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: maxTokens,
      // Cached prefix: tools + system prompt (see cachedSystem above).
      system: cachedSystem(a.system),
      messages: a.messages,
      ...(a.tools.length > 0 ? { tools: a.tools } : {}),
    }), 'Bedrock');
    if (!resp.ok) {
      const detail = (await resp.text().catch(() => '')).slice(0, 300);
      throw new Error(`Bedrock ${resp.status}: ${detail}`);
    }
    const data = await resp.json() as RawModelResponse;
    data._modelId = BEDROCK_MODEL;
    return data;
  }

  if (wantsAnthropic) {
    const key = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
    const resp = await postWithRetry('https://api.anthropic.com/v1/messages', {
      'x-api-key': key || '',
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    }, JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      system: cachedSystem(a.system),
      messages: a.messages,
      ...(a.tools.length > 0 ? { tools: a.tools } : {}),
    }), 'Anthropic');
    if (!resp.ok) {
      const detail = (await resp.text().catch(() => '')).slice(0, 300);
      throw new Error(`Anthropic ${resp.status}: ${detail}`);
    }
    const data = await resp.json() as RawModelResponse;
    data._modelId = ANTHROPIC_MODEL;
    return data;
  }

  throw new Error(
    'No AI credentials configured. Add ONE of these to the Railway variables: '
    + 'BEDROCK_MANTLE_API_KEY (recommended — enables per-workspace model choice), '
    + 'BEDROCK_API_KEY (+ optional BEDROCK_REGION/BEDROCK_MODEL_ID), or ANTHROPIC_API_KEY.',
  );
}

/**
 * ⚠️ UNMETERED, currently UNUSED. This streaming path makes real model calls but
 * does not return token usage, so it is NOT billed. Do not wire it into a route
 * without first routing its cost through meterLlm — an unmetered LLM call is a
 * silent money leak. The agent uses callClaudeWithTools (metered) instead.
 */
export async function* streamClaude(a: {
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
}): AsyncGenerator<string> {
  const maxTokens = a.maxTokens ?? 4096;
  const wantsBedrockBearer = Boolean(process.env.BEDROCK_API_KEY || process.env.AWS_BEARER_TOKEN_BEDROCK);
  const wantsAnthropic = Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY);

  if (wantsBedrockBearer) {
    yield await callBedrockBearer({ system: a.system, messages: a.messages, maxTokens });
    return;
  }
  if (wantsAnthropic) {
    yield* streamAnthropicDirect({ system: a.system, messages: a.messages, maxTokens });
    return;
  }

  throw new Error(
    'No AI credentials configured. Add ONE of these to the Railway variables: '
    + 'BEDROCK_API_KEY (+ optional BEDROCK_REGION/BEDROCK_MODEL_ID) or ANTHROPIC_API_KEY.',
  );
}
