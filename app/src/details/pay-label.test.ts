import { describe, expect, it } from 'vitest';
import { concretePay } from './pay-label';

describe('concretePay', () => {
  it('shows credible pay rates and hides implausible source amounts', () => {
    expect(concretePay('$25–35/hr')).toBe('$25–35/hr');
    expect(concretePay('$57K/yr')).toBe('$57K/yr');
    expect(concretePay('$30/wk')).toBeNull();
    expect(concretePay('$57/yr')).toBeNull();
    expect(concretePay('$0/yr')).toBeNull();
    expect(concretePay('See pay details')).toBeNull();
  });
});
