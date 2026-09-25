/**
 * Trial-revision and account-creation recording (plan 276 TASK-13 / BL-0237,
 * under workspace ruling D-21).
 *
 * The SDK gained an emit surface for the two lifecycle facts plan 276 R-1 makes
 * authoritative, and this module holds everything about it that is not the
 * `RevTurbineCustomerSdk` method itself: the payload shapes, the translation
 * from an episode's facts to a wire payload, and the console notice.
 *
 * **Trial execution and ownership stay with the customer app.** The SDK never
 * runs a trial, never enrols one, never decides one ended and holds no
 * trial-enrollment service — that would be the server-side evaluation the SDK
 * boundary forbids. What it does is *record* what the app states, after running
 * the same pure classifier every other port runs, so the fact that reaches the
 * warehouse agrees with the fact the app believes.
 *
 * The classifier is the load-bearing part. `classifyTrialRevision` reads no
 * clock, so an episode whose scheduled end has merely passed produces **no
 * event at all** — which is the behaviour plan 276 TASK-2 found violated in
 * shipped code, where expiry was derived from the clock at read time.
 */

import type { EventPayloadInput } from '@revt-eng/schema';
import {
  classifyTrialRevision,
  type TrialEpisodeFacts,
  type TrialRevisionClassification,
  type TrialRevisionKind,
} from '@revt-eng/core/trials';

export type { TrialEpisodeFacts, TrialRevisionClassification, TrialRevisionKind };

/**
 * The wire payload for one `trial_revision`.
 *
 * Extends scaffold's own contract input rather than restating it, so the two
 * cannot drift and the loose-object openness REQ-9's additive-only policy needs
 * is inherited rather than re-declared. The fields below NARROW the contract to
 * what a producer must actually supply: every one of them is required here,
 * where the wire contract tolerates their absence from an older producer.
 * `emitPlatformEvent` validates against the contract in development builds and
 * the ingest boundary revalidates authoritatively.
 *
 * @public
 */
export interface TrialRevisionPayload extends EventPayloadInput<'trial_revision'> {
  trial_episode_id: string;
  account_id: string;
  subject_scope: 'account' | 'user';
  rule_handle: string | null;
  plan_handle: string | null;
  trial_type: string | null;
  revision: TrialRevisionKind;
  effective_at: string;
  scheduled_end_at: string | null;
  actual_end_at: string | null;
  evidence: { kind: 'provider_fact' | 'app_fact' | 'usage_exhaustion'; ref: string };
  provider_ref: string | null;
}

/**
 * The app-owned vocabulary that does not live on `TrialEpisodeFacts`, because
 * the classifier has no use for it: a Playbook rule handle, the trialed plan
 * and the trial type are labels the warehouse groups by, never inputs to the
 * decision (plan 276 R-1(c) — a Playbook trial rule supplies vocabulary only).
 *
 * @public
 */
export interface TrialRevisionLabels {
  rule_handle?: string | null;
  plan_handle?: string | null;
  trial_type?: string | null;
  provider_ref?: string | null;
}

/**
 * The payload for one `account_created`, with plan 276 REQ-3 evidence.
 *
 * Narrows scaffold's contract the same way {@link TrialRevisionPayload} does:
 * the wire contract keeps the evidence fields optional+nullable so the
 * pre-existing bare milestone shape stays valid, while this surface requires
 * them — an unevidenced emission is not an authority, so there is no reason to
 * offer a typed way to make one.
 *
 * @public
 */
export interface AccountCreatedPayload extends EventPayloadInput<'account_created'> {
  account_id: string;
  created_at: string;
  /** `self_serve_signup` | `invite_accepted` | `provisioned` | `import`. A USER
   * signup is not account creation (plan 276 R-2) and is refused. */
  source: string;
  evidence: { kind: 'provider_fact' | 'app_fact' | 'usage_exhaustion'; ref: string };
  acquisition_source?: string;
}

/** Why a recording call did or did not put a fact on the wire. @public */
export type TrialRevisionRecordStatus =
  /** Classified, emitted on the typed platform lane. */
  | 'recorded'
  /** Classified and emitted, but this SDK is `local_only`: the fact reached any
   * registered event consumer and never RevTurbine, because local mode makes no
   * server calls at all. */
  | 'recorded_locally'
  /** The evidence supports no revision. Nothing was emitted — by design. */
  | 'pending_unknown'
  /** No trial provider is registered and no episode was supplied. Nothing was
   * emitted, and the one-time console notice names the gap. */
  | 'no_trial_provider';

/**
 * The outcome of recording one episode. Always returned, never thrown: a
 * telemetry surface must not break the host app, and `pending_unknown` is a
 * legitimate answer rather than a failure.
 *
 * @public
 */
export interface TrialRevisionRecordResult {
  status: TrialRevisionRecordStatus;
  /** The classifier's verdict, or null when nothing was classified. */
  classification: TrialRevisionClassification | null;
  /** What was emitted, or null when nothing was. */
  payload: TrialRevisionPayload | null;
}

/**
 * The gentle nudge (ruling D-21). One info-level line, once per SDK runtime,
 * never an error, and it never blocks a decision.
 *
 * The wording is fixed and asserted by `trial-revision-provider-nudge.test.ts`,
 * because this string IS the integrator's only signal that the trial episodes
 * they are pushing into the SDK are going nowhere.
 *
 * @public
 */
export const NO_TRIAL_PROVIDER_NOTICE =
  '[RevTurbine] No trial provider supplied; trial revisions will not be recorded — '
  + 'see https://docs.revturbine.com/sdk/trials. Register a domain provider with '
  + "`domain: 'trial'`, or call `recordTrialRevision(episode)` yourself. Trials keep "
  + 'working; only the lifecycle facts are missing.';

/**
 * Translate an episode plus the classifier's verdict into a wire payload.
 *
 * Every field comes from the facts or the verdict — nothing is derived here,
 * and in particular `effective_at` is the verdict's, which is the proving
 * fact's own time rather than any write clock.
 */
export function buildTrialRevisionPayload(
  facts: TrialEpisodeFacts,
  classification: TrialRevisionClassification,
  labels: TrialRevisionLabels = {},
): TrialRevisionPayload | null {
  if (classification.status !== 'revision') return null;
  return {
    trial_episode_id: facts.trial_episode_id,
    account_id: facts.account_id,
    subject_scope: facts.subject_scope,
    rule_handle: labels.rule_handle ?? null,
    plan_handle: labels.plan_handle ?? null,
    trial_type: labels.trial_type ?? null,
    revision: classification.revision,
    effective_at: classification.effective_at,
    scheduled_end_at: facts.scheduled_end_at,
    actual_end_at: facts.actual_end_at,
    evidence: { kind: classification.evidence.kind, ref: classification.evidence.ref },
    provider_ref: labels.provider_ref ?? null,
  };
}

/**
 * Classify one episode and produce the payload it warrants, if any.
 *
 * Split out from the SDK method so both the web client and the server ports can
 * assert identical behaviour over the same fixtures.
 */
export function resolveTrialRevision(
  facts: TrialEpisodeFacts,
  labels: TrialRevisionLabels = {},
): { classification: TrialRevisionClassification; payload: TrialRevisionPayload | null } {
  const classification = classifyTrialRevision(facts);
  return { classification, payload: buildTrialRevisionPayload(facts, classification, labels) };
}

/**
 * Sources that name a USER-grain act. Plan 276 R-2: a user signup does not
 * establish account creation, and neither does a first observation — so
 * `recordAccountCreated` refuses them rather than recording an account that may
 * not exist.
 *
 * @public
 */
export const USER_GRAIN_SIGNUP_SOURCES: readonly string[] = [
  'user_signup',
  'user_signed_up',
  'first_seen',
];
