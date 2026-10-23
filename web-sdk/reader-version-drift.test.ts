import { readFileSync } from 'node:fs';
import { SCHEMA_VERSION, MIN_READABLE_SCHEMA_VERSION, assertPlaybookPayloadReadable } from '@revt-eng/core/bundle';
import { describe, expect, it } from 'vitest';

function readerConstants(source: string): number[] {
  return ['BUNDLE_SCHEMA_VERSION', 'BUNDLE_MIN_READABLE_SCHEMA_VERSION'].map((name) => {
    const match = source.match(new RegExp(`(?:^|\\n)(?:pub const )?${name}(?::[^=\\n]+)?\\s*=\\s*(\\d+)`, 'm'));
    if (!match) throw new Error(`Missing actual port constant ${name}`);
    return Number(match[1]);
  });
}

describe('installed canonical reader and actual port constants', () => {
  for (const port of ['server-python/src/revturbine/config.py', 'server-rust/src/config.rs']) {
    it(`${port} agrees with the installed canonical contract`, () => {
      expect(readerConstants(readFileSync(port, 'utf8'))).toEqual([
        SCHEMA_VERSION, MIN_READABLE_SCHEMA_VERSION,
      ]);
    });
  }

  it('the guard detects a stale port rather than testing a fixture reader window', () => {
    const stale = `BUNDLE_SCHEMA_VERSION = ${SCHEMA_VERSION - 1}\nBUNDLE_MIN_READABLE_SCHEMA_VERSION = ${MIN_READABLE_SCHEMA_VERSION}`;
    expect(readerConstants(stale)).not.toEqual([SCHEMA_VERSION, MIN_READABLE_SCHEMA_VERSION]);
    expect(() => readerConstants('')).toThrow('Missing actual port constant');
  });

  it.each([15, 16])('the actual default reader still accepts writer %s', (version) => {
    expect(() => assertPlaybookPayloadReadable({ bundle_schema_version: version })).not.toThrow();
  });
});
