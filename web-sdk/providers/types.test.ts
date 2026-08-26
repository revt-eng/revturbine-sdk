import { describe, expectTypeOf, it } from 'vitest';
import type {
  ExperimentAssignmentProvider,
  ExperimentProvider,
} from './index';

describe('experiment assignment provider exports', () => {
  it('keeps the legacy provider name as the exact public alias', () => {
    expectTypeOf<ExperimentProvider>().toEqualTypeOf<ExperimentAssignmentProvider>();
    expectTypeOf<ExperimentAssignmentProvider>().toEqualTypeOf<ExperimentProvider>();
  });
});
