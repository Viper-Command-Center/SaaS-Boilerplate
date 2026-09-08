/**
 * Guards for hosted HTTP MCP connections (Phase 38).
 *
 * The stdio catalog has guardCall (DiviOps); hosted vendors had nothing, so a
 * post the vendor would refuse at PUBLISH time went through at CREATE time and
 * the failure arrived days later as an email to the owner. Zernio (BudgetSmart,
 * daily since late August): text-only posts targeting Instagram ("Instagram
 * posts require media") and posts whose profileId matched no profile
 * ("Unknown Profile"). Max diagnosed both on 2026-09-04 and fixed the ten
 * failed posts by hand; the scheduled tasks kept creating new ones the same
 * way. Prose did not fix it; the tool refusing the shape does.
 *
 * A guard sees the tool name, the args, and a way to call the same server
 * (read-only, for validation). It returns the args to send or throws a plain
 * message the agent can act on.
 */

export type Caller = (tool: string, args: Record<string, unknown>) => Promise<string>;

export type HttpGuard = (
  toolName: string,
  args: Record<string, unknown>,
  call: Caller,
) => Promise<{ args: Record<string, unknown> }>;

// ─── Zernio ──────────────────────────────────────────────────────────────────

/** Platforms whose API rejects a post with no media (per docs.zernio.com/platforms). */
export const ZERNIO_MEDIA_REQUIRED = new Set(['instagram', 'tiktok', 'youtube', 'pinterest', 'snapchat']);
const POST_TOOLS = new Set(['posts-create', 'posts-update', 'posts-schedule', 'create-post', 'update-post']);
const HEX24 = /^[0-9a-f]{24}$/i;
const PROFILE_CACHE_MS = 5 * 60_000;
const profileCache = new Map<string, { at: number; ids: Set<string>; text: string }>();

function listMedia(a: Record<string, unknown>): unknown[] {
  for (const k of ['mediaItems', 'media_items', 'media', 'mediaUrls', 'media_urls']) {
    const v = a[k];
    if (Array.isArray(v) && v.length) {
      return v;
    }
  }
  return [];
}

function listPlatforms(a: Record<string, unknown>): string[] {
  const v = a.platforms;
  if (!Array.isArray(v)) {
    return [];
  }
  return v.map(p => (typeof p === 'string' ? p : String((p as Record<string, unknown>)?.platform ?? ''))).map(s => s.toLowerCase()).filter(Boolean);
}

/** Pure: the validation, testable without a server. Returns a problem or null. */
export function zernioPostProblem(a: Record<string, unknown>, opts: { requireProfile: boolean }): string | null {
  const platforms = listPlatforms(a);
  const needMedia = platforms.filter(p => ZERNIO_MEDIA_REQUIRED.has(p));
  if (needMedia.length && listMedia(a).length === 0) {
    return `${needMedia.join(', ')} posts require media — Zernio accepts the post now and REJECTS it at publish time ("Instagram posts require media"), and the owner gets a failure email. Add mediaItems: [{ type: "image" | "video", url: "<PUBLIC url>" }] (a library asset URL from list_files / generate_image / save_file_from_url), or remove those platforms from this post. Text-only is fine for facebook, linkedin, x, threads, bluesky, discord.`;
  }
  const media = listMedia(a);
  for (const m of media) {
    const url = typeof m === 'string' ? m : String((m as Record<string, unknown>)?.url ?? '');
    if (url && !/^https?:\/\//i.test(url)) {
      return `mediaItems url "${url.slice(0, 80)}" is not a public http(s) URL — Zernio downloads it server-side. Use a library asset URL (list_files → url) or a site-hosted image.`;
    }
  }
  const profileId = a.profileId ?? a.profile_id;
  if (opts.requireProfile && (profileId === undefined || profileId === null || profileId === '')) {
    return 'profileId is required. A Zernio profile is the container that holds the connected accounts; a post created against the wrong (or no) profile publishes to nothing and the owner gets "Unknown Profile" failure emails. Call profiles-list, then accounts-list, and use the profileId whose accounts you are targeting.';
  }
  if (profileId !== undefined && profileId !== null && profileId !== '' && !HEX24.test(String(profileId))) {
    return `profileId "${String(profileId).slice(0, 40)}" is not a Zernio profile id (24 hex chars). Get it from profiles-list.`;
  }
  return null;
}

async function knownProfiles(key: string, call: Caller): Promise<{ ids: Set<string>; text: string } | null> {
  const hit = profileCache.get(key);
  if (hit && Date.now() - hit.at < PROFILE_CACHE_MS) {
    return hit;
  }
  try {
    const text = await call('profiles-list', {});
    const ids = new Set((text.match(/[0-9a-f]{24}/gi) ?? []).map(s => s.toLowerCase()));
    const entry = { at: Date.now(), ids, text: text.slice(0, 1500) };
    profileCache.set(key, entry);
    return entry;
  } catch {
    return null; // validation must not block on a listing hiccup
  }
}

export function zernioGuard(cacheKey: string): HttpGuard {
  return async (toolName, args, call) => {
    // The generic passthrough tool wraps another tool: unwrap for the check.
    let target = toolName;
    let payload = args;
    if (toolName === 'call-tool') {
      target = String(args.name ?? args.tool ?? '');
      const inner = args.arguments ?? args.args ?? args.input;
      payload = inner && typeof inner === 'object' ? inner as Record<string, unknown> : {};
    }
    if (!POST_TOOLS.has(target)) {
      return { args };
    }
    const creating = /create|schedule/.test(target);
    const problem = zernioPostProblem(payload, { requireProfile: creating });
    if (problem) {
      throw new Error(`Zernio ${target} refused before sending: ${problem}`);
    }
    const profileId = String(payload.profileId ?? payload.profile_id ?? '').toLowerCase();
    if (profileId) {
      const known = await knownProfiles(cacheKey, call);
      if (known && known.ids.size > 0 && !known.ids.has(profileId)) {
        throw new Error(`Zernio ${target} refused before sending: profileId ${profileId} is not one of this team's profiles (that is what produces "Unknown Profile" failure emails). profiles-list returned:\n${known.text}`);
      }
    }
    return { args };
  };
}

export const ZERNIO_GUIDANCE = `Zernio (social scheduling):
- Every post needs profileId (from profiles-list — the profile that HOLDS the accounts; check accounts-list) and platforms: [{ platform, accountId }].
- instagram, tiktok, youtube, pinterest REQUIRE mediaItems: [{ type, url }] with a PUBLIC URL. A text-only post to them is accepted now and fails at publish time; the platform now refuses it up front. Text-only is fine for facebook, linkedin, x, threads, bluesky.
- posts-update does not attach media to a failed post — delete and recreate with mediaItems.
- After scheduling, call posts-list-failed once; a scheduled task that creates posts must include the media rule in its own prompt.`;

// ─── Registry lookup ─────────────────────────────────────────────────────────

/** Pick a guard + guidance key for a hosted MCP connection by its server host. */
export function httpGuardFor(conn: { id: string; name: string; url: string }): { guard: HttpGuard; guidanceKey: string; guidance: string } | null {
  let host = '';
  try {
    host = new URL(conn.url).hostname.toLowerCase();
  } catch {
    host = conn.url.toLowerCase();
  }
  if (host.includes('zernio') || conn.name.toLowerCase() === 'zernio') {
    return { guard: zernioGuard(conn.id), guidanceKey: 'zernio', guidance: ZERNIO_GUIDANCE };
  }
  return null;
}
