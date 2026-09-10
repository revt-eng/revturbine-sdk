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
import { normalizeEventType } from '@revt-eng/core';
import { namespacePlatformCollision } from '@revt-eng/schema';
import { EMITTABLE_PLATFORM_EVENT_NAMES } from './customer-side';

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

// `emitSdkWarning` is deliberately NOT scanned: its first argument is a
// human message, not an event name — the event it emits
// (`sdk_validation_warning`) resolves through its internal `captureRaw`
// call's constant argument.
const EMIT_CALL = /(emitSemantic|emitPlatformEvent|captureRaw|capture|postAnonMeta|emitAnonMeta|emitSlotEvent|emitSlotResolution|emitPlacementLifecycle|emitGateEvaluated|emitPlacementOutcome)\(\s*(?:'([a-z][a-z0-9_]*)'|([A-Z][A-Z0-9_]*))/g;

/**
 * The GENERIC-lane callees, whose argument is a customer-style name that the
 * wire canonicalizes (alias normalization + platform-collision namespacing,
 * plan 228 TASK-4) before it lands. Every other callee is a typed/raw lane
 * whose argument IS the wire name. Direction 1 compares WIRE names — the
 * SDK's internal `capture('page_view', …)` emits `clickstream_page_view`,
 * and scanning the raw literal would report a name that never lands.
 */
const GENERIC_LANE_CALLEES = new Set(['capture', 'emitSemantic']);

/** Every platform event name the SDK actually emits ON THE WIRE, per source. */
function scanEmittedNames(): Set<string> {
  const emitted = new Set<string>();
  for (const file of sdkSourceFiles()) {
    const src = readFileSync(file, 'utf8');
    const consts = stringConstants(src);
    for (const m of src.matchAll(EMIT_CALL)) {
      const callee = m[1];
      const literal = m[2];
      const identifier = m[3];
      const rawName = literal ?? (identifier ? consts.get(identifier) : undefined);
      if (!rawName) continue;
      emitted.add(
        GENERIC_LANE_CALLEES.has(callee)
          ? namespacePlatformCollision(normalizeEventType(rawName))
          : rawName,
      );
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

  it('every non-control-plane taxonomy name is emittable via the typed surface (direction 2)', () => {
    // Direction 2 was a source scan ("declares nothing it no longer emits")
    // when the SDK's fixed emit sites were the only producers. Plan 228
    // TASK-4 replaced that world: the typed emit surface makes EVERY non-CP
    // taxonomy name first-party emittable — promoted milestones, billing
    // vocabulary, growth signals included — so the honest parity claim is
    // totality of the typed surface, checked as runtime set equality here
    // and structurally by the Exclude<> type. The old scan direction would
    // now be vacuous, not stricter: a declared name with no internal emit
    // site is exactly what a customer-emitted milestone looks like.
    const declaredNonCp = taxonomy.events
      .filter((e) => e.surface !== 'control_plane')
      .map((e) => e.name)
      .sort();
    expect([...EMITTABLE_PLATFORM_EVENT_NAMES]).toEqual(declaredNonCp);
  });

  it('the typed surface structurally excludes the control plane (direction 2, CP half)', () => {
    const cpNames = taxonomy.events.filter((e) => e.surface === 'control_plane').map((e) => e.name);
    expect(cpNames.length).toBeGreaterThan(0);
    for (const name of cpNames) {
      expect(EMITTABLE_PLATFORM_EVENT_NAMES, `${name} must not be typed-emittable`).not.toContain(name);
    }
  });

  it('does not declare fixed names inside an open prefix family (REQ-3)', () => {
    const shadowing = [...declaredHere].filter(isPrefixFamilyMember);
    expect(shadowing, 'an open family cannot also be enumerated').toEqual([]);
  });
});
