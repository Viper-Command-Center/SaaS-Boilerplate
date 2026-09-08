import { describe, expect, it } from 'vitest';
import { httpGuardFor, zernioGuard, zernioPostProblem } from '@/libs/mcp/httpGuards';

const PID = '69c94244f2ae2e514c52cdd4';

describe('Zernio guard (Phase 38 — BudgetSmart daily failure emails)', () => {
  it('refuses a text-only post that targets Instagram', () => {
    const p = zernioPostProblem({ profileId: PID, content: 'hi', platforms: [{ platform: 'instagram', accountId: 'a' }] }, { requireProfile: true });

    expect(p).toMatch(/instagram posts require media/);
  });

  it('lets a text-only post through for text platforms, and an Instagram post with media', () => {
    expect(zernioPostProblem({ profileId: PID, content: 'hi', platforms: [{ platform: 'linkedin', accountId: 'a' }, { platform: 'facebook', accountId: 'b' }] }, { requireProfile: true })).toBeNull();
    expect(zernioPostProblem({ profileId: PID, content: 'hi', platforms: [{ platform: 'instagram', accountId: 'a' }], mediaItems: [{ type: 'image', url: 'https://s.artivio.ai/x.png' }] }, { requireProfile: true })).toBeNull();
  });

  it('requires profileId on create and validates its shape', () => {
    expect(zernioPostProblem({ content: 'hi', platforms: [{ platform: 'facebook', accountId: 'a' }] }, { requireProfile: true })).toMatch(/profileId is required/);
    expect(zernioPostProblem({ profileId: 'BudgetSmart', content: 'hi', platforms: [] }, { requireProfile: true })).toMatch(/not a Zernio profile id/);
    expect(zernioPostProblem({ content: 'hi' }, { requireProfile: false })).toBeNull();
  });

  it('rejects a non-public media url', () => {
    expect(zernioPostProblem({ profileId: PID, platforms: [{ platform: 'instagram', accountId: 'a' }], mediaItems: [{ type: 'image', url: '/uploads/x.png' }] }, { requireProfile: true })).toMatch(/not a public http/);
  });

  it('checks profileId against profiles-list (Unknown Profile), unwraps call-tool, and passes other tools', async () => {
    const guard = zernioGuard('conn-1');
    const call = async (t: string) => t === 'profiles-list' ? `[{"id":"${PID}","name":"BudgetSmart"}]` : '';

    await expect(guard('posts-create', { profileId: 'aaaaaaaaaaaaaaaaaaaaaaaa', platforms: [{ platform: 'facebook', accountId: 'x' }] }, call)).rejects.toThrow(/Unknown Profile/);
    await expect(guard('posts-create', { profileId: PID, platforms: [{ platform: 'facebook', accountId: 'x' }] }, call)).resolves.toEqual({ args: { profileId: PID, platforms: [{ platform: 'facebook', accountId: 'x' }] } });
    await expect(guard('call-tool', { name: 'posts-create', arguments: { profileId: PID, platforms: [{ platform: 'instagram', accountId: 'x' }] } }, call)).rejects.toThrow(/require media/);
    await expect(guard('accounts-list', {}, call)).resolves.toEqual({ args: {} });
  });

  it('is selected by server host, not by connection name alone', () => {
    expect(httpGuardFor({ id: '1', name: 'social', url: 'https://mcp.zernio.com/mcp' })?.guidanceKey).toBe('zernio');
    expect(httpGuardFor({ id: '1', name: 'github', url: 'https://api.githubcopilot.com/mcp' })).toBeNull();
  });
});
