import { expect, it } from 'vitest';
import { maintenanceActive, trackWorkspaceTask, withWorkspacePaused } from './maintenance';
it('waits for active sync before maintenance and always resumes after a failure', async () => {
  let release!: () => void; let entered = false;
  const pending = trackWorkspaceTask(new Promise<void>(resolve => { release=resolve; }));
  const operation = withWorkspacePaused(async () => { entered=true; throw new Error('failed'); });
  expect(maintenanceActive()).toBe(true); expect(entered).toBe(false);
  release(); await pending;
  await expect(operation).rejects.toThrow('failed'); expect(maintenanceActive()).toBe(false);
});
