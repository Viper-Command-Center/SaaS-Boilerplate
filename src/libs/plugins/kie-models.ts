/**
 * VERIFIED Kie.ai model table.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 *
 * Kie has ~368 models and NO models/schema API. `docs.kie.ai/llms.txt` is a link
 * index — it carries no model ids, no parameters, no types. So nothing can be
 * discovered at runtime: not by us, and definitely not by the agent, which was
 * previously handed `model: { type: 'string' }` — a free-text field into a space
 * it cannot see. It filled that field from training data and was wrong.
 *
 * Every entry below was read off Kie's own doc page by a human-equivalent pass
 * and encoded verbatim. `docUrl` + `verifiedAt` are part of the contract: if you
 * touch an entry, re-read its page and update the date.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY NOT MORE MODELS
 *
 * Because an unverified entry is WORSE than an absent one. A wrong payload comes
 * back as Kie's `"This field is required"` with no field name — hours of a
 * client's time, blamed on the platform. Coverage here is the ~8 jobs a
 * marketing workspace actually does. Add entries when someone needs them, by
 * reading the doc page — never by pattern-matching an existing id.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TRAPS THAT COST US REAL BUGS — do not "tidy" these away
 *
 *  1. PREFIXES ARE INCONSISTENT.  `nano-banana-2` is BARE. `google/nano-banana-edit`
 *     is PREFIXED. Both verified from their own schema enums. You cannot infer an
 *     id from a sibling, or from the doc URL (the Kling text-to-video page lives
 *     at `.../v25-turbo-...` but its id is `kling/v2-5-turbo-...`).
 *  2. NUMBERS ARE SOMETIMES STRINGS.  `duration: "5"` and `upscale_factor: "2"`.
 *     Sending a real number fails validation. ElevenLabs, by contrast, wants real
 *     numbers. There is no rule; only the doc page.
 *  3. THE IMAGE KEY NAME CHANGES PER MODEL:
 *       image_input (array) · image_urls (array) · image_url (string) · image (string)
 *  4. FORMAT ENUMS DIFFER:  Nano Banana 2 = png|jpg.  Nano Banana Edit = png|jpeg.
 *  5. NEVER send `language_code` to elevenlabs multilingual v2 — documented to error.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DELIBERATELY EXCLUDED
 *
 *  · SUNO / MUSIC — excluded on purpose, see kie.ts. Not because it's hard:
 *    because Suno's endpoint (`/api/v1/generate`, a different API entirely) does
 *    NOT return `creditsConsumed`, which is the single field our metering reads.
 *    A working music tool would bill the client $0 while Kie burns real credits.
 *    Shipping revenue-negative code is worse than shipping no music.
 */

export type KieCapability =
	| 'text_to_image'
	| 'image_edit'
	| 'upscale'
	| 'remove_background'
	| 'text_to_video'
	| 'image_to_video'
	| 'text_to_speech'

export type KieModel = {
	/** EXACT `model` string for the API. Copied from the doc page, not derived. */
	id: string
	capability: KieCapability
	/** Shown to the agent via list_models. */
	label: string
	/** When to reach for this one, in the agent's terms. */
	guidance: string
	docUrl: string
	verifiedAt: string
	/** Options the agent may pass, described for list_models. */
	options?: string
	/** Builds the exact `input` object. All per-model quirks live HERE. */
	build: (a: Record<string, unknown>) => Record<string, unknown>
}

const str = (v: unknown, fallback = '') => (v == null ? fallback : String(v))

/** Social-friendly ratios Nano Banana 2 accepts. */
const NB2_RATIOS = new Set([
	'1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5',
	'5:4', '8:1', '9:16', '16:9', '21:9', 'auto',
])

export const KIE_MODELS: KieModel[] = [
	// ── Image ────────────────────────────────────────────────────────────────
	{
		id: 'nano-banana-2', // BARE — verified from the schema enum. NOT google/nano-banana-2.
		capability: 'text_to_image',
		label: 'Nano Banana 2 (Google)',
		guidance:
			'Default for social posts and blog headers. Best ratio coverage (incl. 4:5 Instagram portrait), up to 4K, and accepts up to 14 reference images.',
		options: 'aspect_ratio (1:1, 4:5, 9:16, 16:9, 21:9, auto…), resolution (1K|2K|4K), output_format (png|jpg), image_input (up to 14 reference URLs)',
		docUrl: 'https://docs.kie.ai/market/google/nanobanana2.md',
		verifiedAt: '2026-07-16',
		build: (a) => {
			const ratio = str(a.aspect_ratio, 'auto')
			const refs = Array.isArray(a.image_input) ? a.image_input.slice(0, 14).map(String) : []
			return {
				prompt: str(a.prompt).slice(0, 20_000),
				image_input: refs,
				aspect_ratio: NB2_RATIOS.has(ratio) ? ratio : 'auto',
				resolution: ['1K', '2K', '4K'].includes(str(a.resolution)) ? str(a.resolution) : '1K',
				// Schema default is jpg but the doc's own example sends png. Always
				// explicit so the "default" never matters.
				output_format: str(a.output_format) === 'jpg' ? 'jpg' : 'png',
			}
		},
	},
	// ⚠️ ONE MODEL PER CAPABILITY — this is a deliberate product decision (Ryan,
	// 2026-07-16), not an omission. Seedream 5 Pro was verified and then REMOVED:
	// a client's feed needs a consistent look, and a model picked per-request
	// gives you six visual styles and no way to tell what's working. Model choice
	// has a stable answer, so it's made once, here — not 500 times by the agent.
	// Consequence: the `model` argument is gone from every tool schema. There is
	// nothing for the agent to get wrong. If you add a second model to any
	// capability, you must also decide how the choice gets made and re-add the
	// argument — do not just append an entry and assume the default holds.
	{
		id: 'google/nano-banana-edit', // PREFIXED — unlike nano-banana-2. Verified.
		capability: 'image_edit',
		label: 'Nano Banana Edit (Google)',
		guidance: 'Edit or restyle existing images. Needs at least one source image URL (max 10, ≤10MB each).',
		options: 'aspect_ratio, output_format (png|jpeg — note "jpeg", not "jpg")',
		docUrl: 'https://docs.kie.ai/market/google/nano-banana-edit.md',
		verifiedAt: '2026-07-16',
		build: (a) => {
			const urls = Array.isArray(a.image_urls)
				? a.image_urls.slice(0, 10).map(String)
				: a.image_url
					? [str(a.image_url)]
					: []
			return {
				prompt: str(a.prompt).slice(0, 5000),
				image_urls: urls, // plural array — NOT image_input, NOT image_url
				// This model says jpeg; Nano Banana 2 says jpg. Not a typo.
				output_format: str(a.output_format) === 'jpeg' ? 'jpeg' : 'png',
				aspect_ratio: str(a.aspect_ratio, '1:1'),
				// image_size is DEPRECATED on this model — never send it.
			}
		},
	},
	{
		id: 'topaz/image-upscale',
		capability: 'upscale',
		label: 'Topaz Image Upscale',
		guidance: 'Enlarge an image for print or hero use. Input ≤10MB, jpeg/png/webp.',
		options: 'upscale_factor (1, 2, 4, 8)',
		docUrl: 'https://docs.kie.ai/market/topaz/image-upscale.md',
		verifiedAt: '2026-07-16',
		build: (a) => {
			const f = String(Math.round(Number(a.upscale_factor ?? 2)))
			return {
				image_url: str(a.image_url), // singular string — differs from every sibling
				// 🚨 STRING, not number. `2` fails validation; `"2"` works.
				upscale_factor: ['1', '2', '4', '8'].includes(f) ? f : '2',
			}
		},
	},
	{
		id: 'recraft/remove-background',
		capability: 'remove_background',
		label: 'Recraft Remove Background',
		guidance: 'Cut a product or person out of its background. Max 5MB, 16MP, 4096px; min 256px.',
		docUrl: 'https://docs.kie.ai/market/recraft/remove-background.md',
		verifiedAt: '2026-07-16',
		build: a => ({
			image: str(a.image_url ?? a.image), // key is bare `image` on this one
		}),
	},

	// ── Video ────────────────────────────────────────────────────────────────
	{
		id: 'kling/v2-5-turbo-text-to-video-pro',
		capability: 'text_to_video',
		label: 'Kling V2.5 Turbo Pro (text → video)',
		guidance: 'Make a video from a prompt alone. Describe motion, camera and pacing — not a static scene.',
		options: 'duration_seconds (default 5), aspect_ratio (16:9, 9:16, 1:1)',
		docUrl: 'https://docs.kie.ai/market/kling/v25-turbo-text-to-video-pro.md',
		verifiedAt: '2026-07-15',
		build: a => ({
			prompt: str(a.prompt),
			duration: String(Math.round(Number(a.duration_seconds ?? 5))), // STRING
			aspect_ratio: str(a.aspect_ratio, '16:9'),
		}),
	},
	{
		id: 'kling/v2-1-standard',
		capability: 'image_to_video',
		label: 'Kling V2.1 Standard (image → video)',
		guidance: 'Animate an existing image. REQUIRES image_url — this is why a prompt-only call used to fail.',
		options: 'duration_seconds (default 5). No aspect_ratio — the source image fixes the frame.',
		docUrl: 'https://docs.kie.ai/market/kling/v2-1-standard.md',
		verifiedAt: '2026-07-15',
		build: a => ({
			prompt: str(a.prompt),
			image_url: str(a.image_url),
			duration: String(Math.round(Number(a.duration_seconds ?? 5))), // STRING
		}),
	},

	// ── Audio ────────────────────────────────────────────────────────────────
	{
		id: 'elevenlabs/text-to-speech-multilingual-v2',
		capability: 'text_to_speech',
		label: 'ElevenLabs Multilingual v2 (voiceover)',
		guidance:
			'Voiceover for video or ads. Pass a voice ID from the list below — NOT a name. The docs show "Rachel" in an example but that is not in the schema enum, and a bad voice 422s on a paid call.',
		options:
			'voice: hpp4J3VqNfWAUOO0d1Us (Bella — bright, warm) · UgBBYS2sOqTuMpoF3BR0 (Mark — natural) · TX3LPaxmHKxFdv7VOQHJ (Liam — energetic, social) · kPzsL2i3teMYv0FxEYQ6 (Brittney — social) · EkK5I93UQWFDigLMpZcX (James — default). Also speed (0.7–1.2), stability (0–1).',
		docUrl: 'https://docs.kie.ai/market/elevenlabs/text-to-speech-multilingual-v2.md',
		verifiedAt: '2026-07-16',
		build: (a) => {
			const n = (v: unknown, d: number, lo: number, hi: number) => {
				const x = Number(v ?? d)
				return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d
			}
			return {
				text: str(a.text ?? a.prompt).slice(0, 5000),
				voice: str(a.voice, 'EkK5I93UQWFDigLMpZcX'),
				// Real numbers here — NOT strings. Opposite of duration/upscale_factor.
				stability: n(a.stability, 0.5, 0, 1),
				similarity_boost: n(a.similarity_boost, 0.75, 0, 1),
				style: n(a.style, 0, 0, 1),
				speed: n(a.speed, 1, 0.7, 1.2),
				timestamps: false,
				previous_text: '',
				next_text: '',
				// MUST stay empty: multilingual v2 errors if a language code is set.
				language_code: '',
			}
		},
	},
]

const BY_ID = new Map(KIE_MODELS.map(m => [m.id, m]))

export function kieModel(id: string): KieModel | undefined {
	return BY_ID.get(id)
}

export function kieModelsFor(capability: KieCapability): KieModel[] {
	return KIE_MODELS.filter(m => m.capability === capability)
}

/** The default when the agent doesn't name one. First entry per capability. */
export function defaultKieModel(capability: KieCapability): KieModel | undefined {
	return kieModelsFor(capability)[0]
}
