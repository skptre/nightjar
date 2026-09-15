import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ check: vi.fn(), download: vi.fn(), install: vi.fn(), close: vi.fn(), relaunch: vi.fn() }));
vi.mock('@/lib/platform', () => ({isTauri: () => true}));
vi.mock('@tauri-apps/plugin-updater', () => ({check:mocks.check}));
vi.mock('@tauri-apps/plugin-process', () => ({relaunch:mocks.relaunch}));
beforeEach(() => { vi.resetModules(); Object.values(mocks).forEach(fn => fn.mockReset()); mocks.check.mockResolvedValue({version:'0.2.0', ...mocks}); });
it('never downloads or installs when the recovery backup fails', async () => {
  const {checkForUpdates,installUpdate} = await import('./updater'); await checkForUpdates();
  await installUpdate(async () => { throw new Error('disk full'); });
  expect(mocks.download).not.toHaveBeenCalled(); expect(mocks.install).not.toHaveBeenCalled();
});
it('never installs when download or signature verification fails', async () => {
  const {checkForUpdates,installUpdate} = await import('./updater'); await checkForUpdates();
  mocks.download.mockRejectedValue(new Error('invalid signature'));
  const backup = vi.fn().mockResolvedValue('saved'); await installUpdate(backup);
  expect(backup).toHaveBeenCalledOnce(); expect(mocks.install).not.toHaveBeenCalled();
});
it('backs up, verifies download, installs and restarts in order', async () => {
  const {checkForUpdates,installUpdate} = await import('./updater'); await checkForUpdates();
  const backup = vi.fn().mockResolvedValue('saved'); await installUpdate(backup);
  expect(backup.mock.invocationCallOrder[0]).toBeLessThan(mocks.download.mock.invocationCallOrder[0]!);
  expect(mocks.download.mock.invocationCallOrder[0]).toBeLessThan(mocks.install.mock.invocationCallOrder[0]!);
  expect(mocks.relaunch).toHaveBeenCalledOnce();
});
