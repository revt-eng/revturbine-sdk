import { describe, expect, it } from 'vitest';
import {
  normalizeEnvironmentId,
  PRODUCTION_ENVIRONMENT_ID,
} from './environment';

describe('normalizeEnvironmentId', () => {
  it.each([
    ['omitted', undefined],
    ['empty', ''],
    ['whitespace-only', '  \t  '],
  ])('resolves %s input to production', (_label, environmentId) => {
    expect(normalizeEnvironmentId(environmentId)).toBe(PRODUCTION_ENVIRONMENT_ID);
  });

  it.each(['production', 'staging', 'simulation'])(
    'preserves the explicit %s environment',
    (environmentId) => {
      expect(normalizeEnvironmentId(environmentId)).toBe(environmentId);
    },
  );
});
