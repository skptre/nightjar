import { afterEach, describe, expect, it, vi } from 'vitest';
import { openExternal } from './platform';

describe('openExternal', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('opens a valid web URL in a new browser tab', async () => {
    const open = vi.fn(() => ({}));
    vi.stubGlobal('open', open);

    expect(await openExternal('https://jobs.example.com/role')).toBe(true);
    expect(open).toHaveBeenCalledWith(
      'https://jobs.example.com/role',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('rejects non-web protocols', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);

    expect(await openExternal('javascript:alert(1)')).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});
