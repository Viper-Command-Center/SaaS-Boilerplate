import { describe, expect, it } from 'vitest';
import {
  connectionNameFitsTools,
  describeSkippedTools,
  maxConnectionNameFor,
  NAMESPACE_OVERHEAD,
  namespacedToolName,
} from './registry';

// The migration failure this suite locks down: DiviOps' longest tool is
// `diviops_variable_create_fluid_system` (36 chars). With the 7-char wrapper a
// DiviOps connection name must be ≤ 21 chars or that tool overflows Anthropic's
// 64-char cap, drops, and the whole server looks "down". `diviops-build-1` (15)
// fits; `diviops-build-churchwebglobal-com` (33) does not.
const LONGEST_DIVIOPS_TOOL = 'diviops_variable_create_fluid_system';

describe('MCP tool-name budget (Divi migration name-length guard)', () => {
  it('overhead is exactly mcp__ + __ = 7', () => {
    expect(NAMESPACE_OVERHEAD).toBe(7);
  });

  it('a DiviOps connection name must be ≤ 21 chars for the longest tool', () => {
    expect(LONGEST_DIVIOPS_TOOL.length).toBe(36);
    expect(maxConnectionNameFor(36)).toBe(21);
  });

  it('accepts the short label-based name, rejects the long domain-based name', () => {
    expect(connectionNameFitsTools('diviops-build-1', 36)).toBe(true);
    expect(connectionNameFitsTools('diviops-build-churchwebglobal-com', 36)).toBe(false);
  });

  it('namespacedToolName mirrors the budget: it drops the long name, keeps the short one', () => {
    expect(namespacedToolName('diviops-build-1', LONGEST_DIVIOPS_TOOL)).toBe(
      'mcp__diviops-build-1__diviops-variable-create-fluid-system',
    );
    expect(namespacedToolName('diviops-build-churchwebglobal-com', LONGEST_DIVIOPS_TOOL)).toBeNull();
    // The one that actually fits under the long name (63 chars) still works —
    // proving it is the LONG tools specifically that drop, hence "some tools
    // missing" rather than "all", which is what made it look like a flaky server.
    expect(namespacedToolName('diviops-build-churchwebglobal-com', 'diviops_section_replace')).toBe(
      'mcp__diviops-build-churchwebglobal-com__diviops-section-replace',
    );
  });

  it('sanitizing brings a name under budget the same way the registry does', () => {
    // Underscores/uppercase are sanitized to dashes/lowercase before measuring.
    expect(connectionNameFitsTools('DiviOps_Build_1', 36)).toBe(true);
  });
});

describe('describeSkippedTools — honest, actionable attribution', () => {
  it('blames the CONNECTION NAME and says to rename, when a shorter name would fit', () => {
    const msg = describeSkippedTools('diviops-build-churchwebglobal-com', [LONGEST_DIVIOPS_TOOL]);

    expect(msg).toMatch(/connection NAME is 33 characters/);
    expect(msg).toMatch(/NOT an outage/);
    expect(msg).toMatch(/rename this connection to 21 characters/);
    expect(msg).toMatch(/diviops-build-1/);
    // It must NOT reproduce the old misleading vendor-blaming wording.
    expect(msg).not.toMatch(/vendor's tool names are too long/);
  });

  it('blames the VENDOR only when even a 1-char connection name could not fit the tool', () => {
    // A 60-char tool name: 7 + 1 + 60 = 68 > 64, so no rename can save it.
    const monster = 'x'.repeat(60);
    const msg = describeSkippedTools('short', [monster]);

    expect(msg).toMatch(/vendor's tool names are too long/);
    expect(msg).not.toMatch(/rename this connection/);
  });
});
