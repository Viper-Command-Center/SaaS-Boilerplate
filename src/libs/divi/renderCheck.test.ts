import { describe, expect, it, vi } from 'vitest';
import { diviRenderCheck, htmlFrom } from './renderCheck';

describe('honest batch structure checks', () => {
  it('does not render the whole page for small edits', async () => {
    const call = vi.fn();
    const text = await diviRenderCheck('diviops_module_update', { page_id: 7 }, '{}', call, { target: 'https://example.com' });

    expect(call).not.toHaveBeenCalled();
    expect(text).toContain('verification pending');
  });

  it('whole-page checks explicitly exclude visual quality and image loading', async () => {
    const call = vi.fn().mockResolvedValue(JSON.stringify({ ok: true, data: { html: '<div class="et_pb_module"><img src="/missing.jpg"></div>' } }));
    const text = await diviRenderCheck('diviops_page_update_content', { page_id: 7 }, '{}', call, { target: 'https://example.com' });

    expect(text).toContain('[structure check]');
    expect(text).toContain('NOT verified');
    expect(call).toHaveBeenCalledTimes(1);
    expect(htmlFrom('{"ok":false}')).toBeNull();
  });
});
