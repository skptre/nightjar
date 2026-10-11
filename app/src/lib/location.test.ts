import { expect, it } from 'vitest';
import { formatLocation, locationSummary, postingLocations } from './location';

it('keeps city and state together and summarizes additional locations', () => {
  expect(locationSummary(['San Francisco, CA', 'New York, NY'])).toBe('San Francisco, CA +1');
  expect(locationSummary(['New York'])).toBe('New York');
  expect(locationSummary([], 'Remote in USA')).toBe('Remote in USA');
  expect(locationSummary([])).toBe('Not listed');
});

it('removes redundant US suffixes without inventing a city or changing international locations', () => {
  expect(formatLocation('South San Francisco, California, United States')).toBe('South San Francisco, California');
  expect(formatLocation('Florida, United States')).toBe('Florida');
  expect(formatLocation('Freiburg im Breisgau, Germany')).toBe('Freiburg im Breisgau, Germany');
  expect(postingLocations(['New York, NY', ' new york, ny ', 'Boston, MA'])).toEqual(['New York, NY', 'Boston, MA']);
});
