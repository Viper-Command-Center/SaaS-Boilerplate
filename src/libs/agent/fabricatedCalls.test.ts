import { describe, expect, it } from 'vitest';
import { detectFabricatedCalls, detectSelfReportedFailure, detectUnverifiedCompletion, fabricationNudge, ranNoProductiveTool } from '@/libs/agent/fabricatedCalls';

describe('fabricated tool calls (Phase 42 — Theo, BBI)', () => {
  it('catches the transcript marker written as text and strips it', () => {
    const text = 'Fixing all 4 now:\n[tool] calling mcp__wp-sites__wp-mcp…\n\n\n[tool] calling mcp__wp-sites__wp-mcp…\nAll 4 written. Now flush cache:\n[tool] calling mcp__wp-sites__wp-cache-flush…\nPages are loading.';
    const f = detectFabricatedCalls(text, []);

    expect(f).not.toBeNull();
    expect(f!.names).toEqual(['mcp__wp-sites__wp-mcp', 'mcp__wp-sites__wp-cache-flush']);
    expect(f!.cleaned).toBe('Fixing all 4 now:\n\nAll 4 written. Now flush cache:\n\nPages are loading.');
  });

  it('is silent on honest text, including prose that mentions calling people', () => {
    expect(detectFabricatedCalls('I will call the client tomorrow. Running tests now.', [])).toBeNull();
    expect(detectFabricatedCalls('Done — the page renders the listings.', ['wp_mcp'])).toBeNull();
  });

  it('does not count a marker as fabricated when the same response really made that call', () => {
    const f = detectFabricatedCalls('[tool] calling list_files…\nLet me look.', ['list_files']);

    expect(f).not.toBeNull();
    expect(f!.names).toEqual([]);
    expect(f!.cleaned).toBe('Let me look.');
  });

  it('catches the bare "calling snake_case_tool" form and [approval]/[artivio] markers', () => {
    const f = detectFabricatedCalls('calling wp_cache_flush\n[approval] wp_cli queued for human approval (#abc).\n[artivio] wrote to #46 "Events".', []);

    expect(f!.names).toContain('wp_cache_flush');
    expect(f!.names).toContain('wp_cli');
    expect(f!.cleaned).toBe('');
  });

  it('nudge names the tools and demands a real call or an honest statement', () => {
    const n = fabricationNudge(['mcp__wp-sites__wp-mcp']);

    expect(n).toMatch(/runs nothing/);
    expect(n).toMatch(/tool_use block/);
  });
});

describe('unverified completion claims (Phase 48.3 — Noah, Copetown)', () => {
  it('flags a "100% COMPLETE / all pages live" report with no verification tool this turn', () => {
    const text = '## Copetown Migration 100% COMPLETE ✅\nAll 4 pages live. Desktop/tablet/mobile: 0 defects.';
    const nudge = detectUnverifiedCompletion(text, ['wp_upload_media', 'diviops_section_append']);

    expect(nudge).not.toBeNull();
    expect(nudge).toMatch(/made no tool call that read the result back/);
    expect(nudge).toMatch(/Do NOT tell the user it is complete/);
  });

  it('is silent when a real read-back tool ran this turn', () => {
    const text = 'All 4 pages are live and verified.';

    expect(detectUnverifiedCompletion(text, ['diviops_render_preview'])).toBeNull();
    expect(detectUnverifiedCompletion(text, ['diviops_page_list'])).toBeNull();
    expect(detectUnverifiedCompletion(text, ['migration_read'])).toBeNull();
  });

  it('is silent on ordinary progress text that makes no completion claim', () => {
    expect(detectUnverifiedCompletion('Uploaded the photos; building the home page next.', [])).toBeNull();
    expect(detectUnverifiedCompletion('I appended the hero section.', ['diviops_section_append'])).toBeNull();
  });

  it('also catches softer done-phrasings (ready for review / successfully built)', () => {
    expect(detectUnverifiedCompletion('The Copetown site is ready for review.', ['diviops_section_append'])).not.toBeNull();
    expect(detectUnverifiedCompletion('Successfully migrated all pages.', [])).not.toBeNull();
    expect(detectUnverifiedCompletion('The build is now complete.', [])).not.toBeNull();
    // …but still verified when a read-back tool ran.
    expect(detectUnverifiedCompletion('Successfully built the home page.', ['diviops_render_preview'])).toBeNull();
    // …and not tripped by ordinary sentences that merely contain the words.
    expect(detectUnverifiedCompletion('I will review the content and build the page next.', [])).toBeNull();
  });
});

// Phase 48.7 (2026-09-30, Copetown): the mission executor marked steps 2–4
// [done] while build-3 had ZERO pages, because the tool loop returned normally
// even when the step's own summary admitted the DiviOps MCP was down. These
// guard the two executor-level checks that now gate a step from being marked
// done: does the summary admit failure, and did any productive tool run.
describe('self-reported failure (Phase 48.7 — Copetown mission executor)', () => {
  it('catches the exact admissions the Copetown steps wrote while marked done', () => {
    expect(detectSelfReportedFailure('the DiviOps connection has stopped responding: server is not running')).not.toBeNull();
    expect(detectSelfReportedFailure('three consecutive calls all returned the same platform error, not something fixable from here')).not.toBeNull();
    expect(detectSelfReportedFailure('not completed this run; dry run, only source content retrieved, no actual write')).not.toBeNull();
    expect(detectSelfReportedFailure('I was unable to complete the build and am escalating this now.')).not.toBeNull();
    expect(detectSelfReportedFailure('No pages were created because the server is down.')).not.toBeNull();
  });

  it('stays silent on a genuine completion summary', () => {
    expect(detectSelfReportedFailure('Built the Home page: hero, services and contact sections appended; render preview confirms it renders.')).toBeNull();
    expect(detectSelfReportedFailure('Created 4 pages and verified each with diviops_render_preview.')).toBeNull();
  });
});

describe('productive-tool check (Phase 48.7)', () => {
  it('a step that ran a real write or read-back did productive work', () => {
    expect(ranNoProductiveTool(['diviops_page_create', 'diviops_render_preview'])).toBe(false);
    expect(ranNoProductiveTool(['migration_read'])).toBe(false);
    expect(ranNoProductiveTool(['wp_upload_media'])).toBe(false);
    expect(ranNoProductiveTool(['scrape_page'])).toBe(false);
  });

  it('a step that ran only chatter/planning tools (or nothing) did NOT do verifiable work', () => {
    expect(ranNoProductiveTool([])).toBe(true);
    expect(ranNoProductiveTool(['get_mission', 'update_memory'])).toBe(true);
  });
});
