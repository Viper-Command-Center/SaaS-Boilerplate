import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { IMAGE_CHECK_SCRIPT } from './agentcore';

describe('browser image measurement', () => {
  it('detects visible broken/unloaded images but not loaded or hidden images', () => {
    const image = (complete: boolean, naturalWidth: number, visible: boolean) => ({ complete, naturalWidth, src: '/photo.jpg', getClientRects: () => visible ? [{}] : [] });
    const raw = vm.runInNewContext(IMAGE_CHECK_SCRIPT, { document: { images: [image(true, 1200, true), image(true, 0, true), image(false, 0, true), image(true, 0, false)] } });
    const issues = JSON.parse(raw);

    expect(issues).toHaveLength(2);
    expect(issues[0].type).toBe('broken-image');
  });
});
