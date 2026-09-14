'use client';

/**
 * Init status — the one surface that is reachable when the SDK is not.
 *
 * Plan 233 TASK-2. Every diagnostic the SDK ships (`getPolicy()`,
 * `getExportedConfig()`, `getTargeting()`, `getTelemetryCounters()`,
 * `validateUiPathResolvers()`, `explainPlacementDecision()`) is an instance
 * method, so all of them are unreachable in precisely the failure mode that
 * matters most: the one where the instance was never created. When init throws,
 * `useRevTurbine().sdk` is `null` and there is nothing left to ask.
 *
 * The provider already caught the error and logged it, but a `console.error` in
 * an app that renders correctly without us is indistinguishable from silence —
 * a customer ran dead for 36 hours and found it only by pasting a raw browser
 * console log. So the status lives on the context value, beside `sdk`, and is
 * populated exactly when `sdk` is not.
 */

/**
 * Where initialization was when it failed. Useful because the phases fail for
 * different reasons: `construct` is almost always malformed options, `theme`
 * a branding/network problem, `bootstrap` a placement that does not resolve.
 *
 * @public
 */
export type RevTurbineInitPhase =
  | 'construct'
  | 'identify'
  | 'theme'
  | 'placements'
  | 'bootstrap';

/**
 * The provider's initialization outcome, readable with no SDK instance.
 *
 * `ok: true` with no other fields is the healthy state. On failure every field
 * is populated — `remediation` is never empty, because a diagnostic that only
 * restates the error leaves the reader exactly where they started.
 *
 * @public
 */
export interface RevTurbineInitStatus {
  /** `false` once initialization has thrown; `true` while healthy. */
  readonly ok: boolean;
  /** Which phase threw. Absent while healthy. */
  readonly phase?: RevTurbineInitPhase;
  /** The underlying error message, unmodified. Absent while healthy. */
  readonly message?: string;
  /** What to actually change, in the caller's own code. Absent while healthy. */
  readonly remediation?: string;
}

/** The healthy status. Frozen so a consumer cannot mutate the shared default. */
export const INIT_STATUS_OK: RevTurbineInitStatus = Object.freeze({ ok: true });

/**
 * Known failure signatures → the fix, in the caller's terms.
 *
 * Matched against the thrown message. Ordered, first match wins. These are the
 * failures we have actually seen in the field or in the init path's own throws;
 * anything unmatched still gets the generic remediation below, so the contract
 * "remediation is never empty" holds for errors nobody anticipated.
 */
const REMEDIATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /missing non-empty string "tenant_id"/i,
    'Pass `tenantId` in the SDK init options, or stamp `tenant_id` into the Playbook. '
      + 'A Playbook served over the wire commonly has it stripped — the init option is the authority, '
      + 'so supplying it there is the fix.',
  ],
  [
    /missing non-empty string "environment_id"/i,
    'Pass `environmentId` in the SDK init options, or stamp `environment_id` into the Playbook. '
      + 'Omitted environments resolve to "production".',
  ],
  [
    /missing array "(\w+)"/i,
    'The Playbook is missing a required top-level array. Re-export it from the control plane or the CLI '
      + 'rather than hand-editing — a partial Playbook cannot be evaluated.',
  ],
  [
    /unsupported "?(artifact_type|format_version)"?/i,
    'The Playbook was produced by a newer or unrecognized exporter. Upgrade @revturbine/sdk, or re-export '
      + 'the Playbook at a format this SDK version reads.',
  ],
  [
    /empty action_type|uiPathResolvers/i,
    'One `uiPathResolvers` key is empty or malformed. Every key must be a non-empty `action_type` string.',
  ],
  [
    /expected top-level object/i,
    '`localRuntime.playbook` is not an object. Import the Playbook JSON and pass the parsed value, '
      + 'not a string or a URL.',
  ],
];

/**
 * The fallback. Deliberately not "check the console" — the whole failure mode
 * is that the console was the only signal and nobody read it.
 */
const GENERIC_REMEDIATION =
  'RevTurbine did not start, so no placement renders and every entitlement check reads denied. '
  + 'Check the SDK init options and the Playbook passed to `localRuntime`. '
  + 'The app keeps rendering without the SDK by design, so this status is the only signal that it is down.';

/**
 * Resolve the remediation for a thrown init error.
 *
 * @param message - The error message as thrown.
 * @returns Actionable guidance. Never empty.
 * @public
 */
export function remediationFor(message: string): string {
  for (const [pattern, remediation] of REMEDIATIONS) {
    if (pattern.test(message)) return remediation;
  }
  return GENERIC_REMEDIATION;
}

/**
 * Build the failure status for a thrown init error.
 *
 * @param phase - The phase that was running when the error was thrown.
 * @param error - The thrown value; non-Errors are stringified.
 * @returns A fully-populated failure status.
 * @public
 */
export function initStatusForError(
  phase: RevTurbineInitPhase,
  error: unknown, // sdk-ok: boundary-parse — a thrown value is unknown by definition
): RevTurbineInitStatus {
  const message = error instanceof Error ? error.message : String(error);
  return Object.freeze({
    ok: false,
    phase,
    message,
    remediation: remediationFor(message),
  });
}
