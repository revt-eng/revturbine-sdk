import { describe, expect, it } from 'vitest';
import { findRetiredInitOptions } from '../scripts/check-sdk-init-examples.mjs';

describe('SDK runtime option semantics', () => {
  it.each([
    "initRevTurbine({mode: 'local_only'})",
    "const options = { 'mode': 'revturbine_server' };",
    'const options = { mode: RuntimeMode.CustomEndpoints };',
  ])('rejects retired runtime selection: %s', code => {
    expect(findRetiredInitOptions(code)).toHaveLength(1);
  });
  it.each([
    "initRevTurbine({mode: 'react', runtimeMode: 'local_only'})",
    "initRevTurbine({localRuntime: {mode: 'local_only'}})",
    'initRevTurbine({runtimeMode: RuntimeMode.Server})',
    "// mode: 'local_only'\nconst message = \"mode: 'local_only'\";",
  ])('keeps valid options and non-code text: %s', code => {
    expect(findRetiredInitOptions(code)).toEqual([]);
  });
});
