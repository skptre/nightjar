import { expect, it } from 'vitest';
import excerpts from './fixtures/source-excerpts.json';
import { extractJobDetails } from './extract';

it.each(excerpts)('extracts reviewed employer excerpt: $id', sample => {
  const result = extractJobDetails(sample.text, { acquisition: 'partial' });
  expect(result.compensation.ranges.map(p => p.min)).toEqual(sample.expected_amounts);
  expect(result.compensation.ranges.every(p => p.period === sample.expected_period)).toBe(true);
  for (const range of result.compensation.ranges) {
    expect(sample.text.slice(range.evidence.start, range.evidence.end)).toBe(range.evidence.text);
  }
});
