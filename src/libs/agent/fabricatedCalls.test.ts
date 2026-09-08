import { describe, expect, it } from 'vitest';
import { detectFabricatedCalls, fabricationNudge } from '@/libs/agent/fabricatedCalls';

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
