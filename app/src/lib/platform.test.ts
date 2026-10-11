import { afterEach, describe, expect, it, vi } from 'vitest';
import { openExternal } from './platform';

describe('openExternal', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('opens a valid web URL in a new browser tab', async () => {
    const replace = vi.fn();
    const tab = { opener: window, location: { replace }, close: vi.fn() };
    const open = vi.fn(() => tab);
    vi.stubGlobal('open', open);

    expect(await openExternal('https://jobs.example.com/role')).toBe(true);
    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
    expect(tab.opener).toBeNull();
    expect(replace).toHaveBeenCalledWith('https://jobs.example.com/role');
  });

  it('reports a blocked popup without claiming the employer page opened', async () => {
    vi.stubGlobal('open', vi.fn(() => null));
    expect(await openExternal('https://jobs.example.com/role')).toBe(false);
  });

  it('rejects non-web protocols', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);

    expect(await openExternal('javascript:alert(1)')).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});
