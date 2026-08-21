/**
 * Cross-repo event-taxonomy parity (plan 181 TASK-2, REQ-3 / AC-2).
 *
 * The scaffold declaration (`@revt-eng/schema`'s `event-taxonomy.json`) claims
 * to list every event the platform emits. Nothing enforced that claim before
 * this test: the SDK could emit a name no list declared, and a declared name
 * could stop being emitted, both silently. This asserts BOTH directions.
 *
 * **Why this scans source rather than a list.** Emissions are code, not a
 * manifest — the only honest way to know what the SDK emits is to look at
 * where it emits. That makes this test a scanner, and scanners have a failure
 * mode worth naming: **the emit name is often a CONSTANT, not a literal**
 * (`USER_CONTEXT_FIELDS_EVENT`, `SDK_WARNING_EVENT_TYPE`), or a union-typed
 * variable (the slot lifecycle). A literal-only scan reports those four as
 * "declared but never emitted" — false failures that would train everyone to
 * ignore this test. So the scanner resolves single-file `const NAME = '...'`
 * bindings and harvests union type aliases before comparing.
 *
 * **Scope (REQ-3).** Parity binds the PLATFORM-emitted surface only. Customer
 * `track('anything')` names are arbitrary by design and open prefix families
 * are deliberately unenumerated, so both are excluded from both directions.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const require_ = createRequire(import.meta.url);

interface TaxonomyEntry {
  name: string;
  surface: 'sdk_client' | 'sdk_server' | 'control_plane' | 'webhook_derived';
  purpose: string;
  stability: 'stable' | 'internal' | 'deprecated';
}
interface Taxonomy {
  taxonomyVersion: number;
  events: TaxonomyEntry[];
  prefixFamilies: Array<{ prefix: string; surface: string; purpose: string }>;
}

function loadTaxonomy(): Taxonomy {
  const pkg = require_.resolve('@revt-eng/schema/package.json');
  return JSON.parse(readFileSync(join(dirname(pkg), 'generated', 'event-taxonomy.json'), 'utf8')) as Taxonomy;
}

// `fileURLToPath`, not a hand-rolled `pathname` strip: on POSIX the latter
// turns `/home/runner/…` into a RELATIVE `home/runner/…` and the scan throws
// ENOENT, while still looking correct on Windows (`/C:/…` → `C:/…`).
const WEB_SDK_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Every hand-written SDK source file, RECURSIVELY. Direction 1 claims the SDK
 * emits nothing undeclared; a top-level-only scan cannot support that claim,
 * since an emit added under `placements/` or `react/` would be invisible to it.
 * (No subdirectory emits today — this keeps that true rather than assuming it.)
 */
function sdkSourceFiles(): string[] {
  return readdirSync(WEB_SDK_DIR, { recursive: true, encoding: 'utf8' })
    .map((f) => f.replace(/\\/g, '/'))
    .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
    .filter((f) => !/\.test\.tsx?$|\.stories\.tsx?$/.test(f))
    .filter((f) => !/(^|\/)(generated|node_modules|dist)\//.test(f) && !/^generated/.test(f))
    .map((f) => join(WEB_SDK_DIR, f));
}

/** `const NAME = 'value';` bindings, so a constant emit arg can be resolved. */
function stringConstants(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/(?:const|let)\s+([A-Z][A-Z0-9_]*)\s*(?::\s*[^=]+)?=\s*'([a-z][a-z0-9_]*)'/g)) {
    out.set(m[1], m[2]);
  }
  return out;
}

/**
 * Members of `export type XLifecycleEvent = 'a' | 'b';` — the union-typed
 * arguments passed to lifecycle emitters as variables.
 *
 * Deliberately narrow: an earlier pass matched any `*Event*` type alias and
 * swept in `EventOrigin`'s values ('explicit' | 'automatic' | …), which are
 * origin classifications, not event names. Only `*LifecycleEvent` aliases
 * carry emit names.
 */
function lifecycleUnionMembers(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(?:export )?type \w*LifecycleEvent\s*=\s*((?:\s*\|?\s*'[a-z][a-z0-9_]*')+)\s*;/g)) {
    for (const lit of m[1].matchAll(/'([a-z][a-z0-9_]*)'/g)) out.push(lit[1]);
  }
  return out;
}

const EMIT_CALL = /(?:emitSemantic|capture|postAnonMeta|emitAnonMeta|emitSlotEvent|emitSlotResolution|emitPlacementLifecycle|emitGateEvaluated|emitPlacementOutcome)\(\s*(?:'([a-z][a-z0-9_]*)'|([A-Z][A-Z0-9_]*))/g;

/** Every platform event name the SDK actually emits, per source. */
function scanEmittedNames(): Set<string> {
  const emitted = new Set<string>();
  for (const file of sdkSourceFiles()) {
    const src = readFileSync(file, 'utf8');
    const consts = stringConstants(src);
    for (const m of src.matchAll(EMIT_CALL)) {
      const literal = m[1];
      const identifier = m[2];
      if (literal) emitted.add(literal);
      else if (identifier && consts.has(identifier)) emitted.add(consts.get(identifier) as string);
    }
    for (const name of lifecycleUnionMembers(src)) emitted.add(name);
  }
  return emitted;
}

const taxonomy = loadTaxonomy();
const prefixes = taxonomy.prefixFamilies.map((f) => f.prefix);
const isPrefixFamilyMember = (name: string) => prefixes.some((p) => name.startsWith(p));

// The SDK emits the client + meta surfaces; control-plane events come from
// revturbine-web, so they are out of scope for THIS repo's parity.
const declaredHere = new Set(
  taxonomy.events.filter((e) => e.surface === 'sdk_client').map((e) => e.name),
);
const deprecated = new Set(
  taxonomy.events.filter((e) => e.stability === 'deprecated').map((e) => e.name),
);

describe('event taxonomy parity (plan 181 AC-2)', () => {
  it('the scanner resolves constants and unions — otherwise it lies', () => {
    const emitted = scanEmittedNames();
    // Guards the scanner itself. These four reach their emit call as a
    // constant or a union-typed variable; if the resolver regresses they
    // vanish and this test starts reporting false "never emitted" failures.
    for (const viaIndirection of ['user_context_observed', 'sdk_validation_warning', 'sdk_init', 'slot_filled']) {
      expect(emitted.has(viaIndirection), `${viaIndirection} should resolve through indirection`).toBe(true);
    }
  });

  it('emits nothing undeclared (direction 1)', () => {
    const emitted = scanEmittedNames();
    const undeclared = [...emitted]
      .filter((n) => !declaredHere.has(n))
      .filter((n) => !isPrefixFamilyMember(n))
      // Meta-lane names are declared on the sdk_client surface too; anything
      // else unmatched is a genuine gap.
      .filter((n) => !taxonomy.events.some((e) => e.name === n));
    expect(
      undeclared,
      `SDK emits ${undeclared.join(', ')} but the taxonomy does not declare them — add them to scaffold's taxonomy.ts`,
    ).toEqual([]);
  });

  it('declares nothing it no longer emits (direction 2)', () => {
    const emitted = scanEmittedNames();
    const neverEmitted = [...declaredHere]
      .filter((n) => !emitted.has(n))
      .filter((n) => !deprecated.has(n));
    expect(
      neverEmitted,
      `the taxonomy declares ${neverEmitted.join(', ')} but no SDK emit site produces them — remove them or mark them deprecated`,
    ).toEqual([]);
  });

  it('does not declare fixed names inside an open prefix family (REQ-3)', () => {
    const shadowing = [...declaredHere].filter(isPrefixFamilyMember);
    expect(shadowing, 'an open family cannot also be enumerated').toEqual([]);
  });
});
