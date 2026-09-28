/**
 * Built-in segment definitions for a locally supplied Playbook (BL-0365;
 * plan 279 REQ-4 / PD-3).
 *
 * A hosted Playbook carries the built-in `rt.<dimension>.<value>` definitions
 * because web's `buildPlaybook` appends them at export. A Playbook the app
 * supplies itself (`localRuntime.playbook`, or `localRuntime.resolvers`) was
 * never exported, so it carries none. A payload chip or entitlement rule naming
 * a built-in then matches nothing, even when a dimension value is delivered.
 *
 * This module closes that gap at load, from the one scaffold catalogue
 * (`generateBuiltinSegments` in `@revt-eng/core`). No definition is written
 * into the app's file, so nothing can drift from the catalogue.
 *
 * Definitions only, never values (D-46, BL-0381): the browser app cannot set
 * `builtin_dimensions`. The values come from the authenticated
 * `GET /api/sdk/client-context` delivery; with no delivery every built-in
 * trait is absent and its segments fail closed (PD-4).
 */
import type { RevTurbineConfig } from '@revt-eng/schema';
import {
  BUILTIN_DIMENSION_KEYS,
  generateBuiltinSegments,
  isGeneratedBuiltinSegment,
  isReservedSegmentHandle,
  type BuiltinSeatTypeInput,
} from '@revt-eng/core';

type PlaybookSegment = NonNullable<RevTurbineConfig['segments']>[number];

/** The Playbook's own seat types, as generator input for Seat Type. */
function localSeatTypes(playbook: RevTurbineConfig): BuiltinSeatTypeInput[] {
  const seatTypes: BuiltinSeatTypeInput[] = [];
  for (const seatType of playbook.seat_types ?? []) {
    if (typeof seatType.handle !== 'string') continue;
    seatTypes.push({ handle: seatType.handle, name: seatType.name });
  }
  return seatTypes;
}

/**
 * Return the Playbook with the catalogue's built-in segment definitions merged
 * into `segments`.
 *
 * - **All ten dimensions** are generated. `BUILTIN_DIMENSION_AVAILABILITY`
 *   (web) records which dimensions the control plane *delivers*; generating
 *   them all keeps any delivered dimension resolvable. A dimension that is not
 *   delivered stays absent, and its built-ins fail closed (PD-4).
 * - **Seat Type** values come from the Playbook's own `seat_types[]` (there is
 *   no tenant registry locally). A handle the generator cannot use is skipped,
 *   exactly as at export.
 * - **Existing definitions win by handle.** A hosted export used locally
 *   already carries some generated definitions; only the missing ones are
 *   added.
 * - **The reserved prefix stays reserved** (`VAL-SEG-02`). A local Playbook
 *   never passes the Compile+Activate gate, so an authored `rt.*` segment that
 *   is not an exact generated definition is dropped here, with a warning. It
 *   can neither replace a built-in's predicates nor impersonate one.
 *
 * Returns the same object when nothing changes.
 *
 * @internal SDK runtime plumbing, applied to `localRuntime` Playbooks only.
 */
export function withLocalBuiltinSegments(playbook: RevTurbineConfig): RevTurbineConfig;
export function withLocalBuiltinSegments(
  playbook: RevTurbineConfig | undefined,
): RevTurbineConfig | undefined;
export function withLocalBuiltinSegments(
  playbook: RevTurbineConfig | undefined,
): RevTurbineConfig | undefined {
  if (!playbook) return playbook;
  const authored: readonly PlaybookSegment[] = playbook.segments ?? [];

  const kept: PlaybookSegment[] = [];
  const dropped: string[] = [];
  for (const segment of authored) {
    if (isReservedSegmentHandle(segment.handle) && !isGeneratedBuiltinSegment(segment)) {
      dropped.push(segment.handle);
      continue;
    }
    kept.push(segment);
  }

  const present = new Set(kept.map((segment) => segment.handle));
  const { segments: generated } = generateBuiltinSegments({
    dimensions: BUILTIN_DIMENSION_KEYS,
    seatTypes: localSeatTypes(playbook),
  });
  const added = generated.filter((segment) => !present.has(segment.handle));

  if (dropped.length > 0) {
    console.warn(
      `[RevTurbine] localRuntime.playbook defines segment(s) ${dropped.map((h) => `'${h}'`).join(', ')} `
        + "under the reserved 'rt.' prefix. They were ignored: 'rt.' handles are RevTurbine's built-in "
        + 'segments, generated from the catalogue. Rename the segment, or target the built-in; its '
        + 'dimension value is delivered by your server through the client-context fetch.',
    );
  }
  if (dropped.length === 0 && added.length === 0) return playbook;
  return { ...playbook, segments: [...kept, ...added] };
}
