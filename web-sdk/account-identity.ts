/**
 * The account-identity fallback contract — BL-0117, Kent's ruling **D-13**
 * (2026-09-25): *"Keep the user-id fallback but explicitly prefix it to make it
 * obvious its a fallback key."*
 *
 * `events_clickstream.account_id` and `placement_presentations.account_id` are
 * analytical **join keys**: `monetization_funnel` and `cohort_rollup` build
 * their account map out of them, and every experiment summary pipe reads them
 * whenever `analysis_unit='account'`. Before this contract the SDK sent
 * `userContext.account_id || userId`, so an integration that identified no
 * account contributed a bogus `user_id → user_id` account and an
 * account-grain readout silently returned the user-grain n while looking
 * perfectly valid.
 *
 * The fix is not to drop the key — a row with no account still needs an
 * attribution handle so per-"account" series stay countable and joinable — it
 * is to make the fabricated key **self-describing**. A key derived from a user
 * id is prefixed with {@link FALLBACK_ACCOUNT_ID_PREFIX}, so any reader can
 * tell a real, integration-supplied account from one the SDK invented:
 *
 * - **Warehouse**: read-time guards exclude prefixed ids from account
 *   denominators (`monetization_funnel`, `cohort_rollup`), so "accounts" means
 *   accounts the integration actually identified.
 * - **Wire**: absence remains valid. `TrackEvent.account_id` is optional as of
 *   `@revt-eng/schema` 0.1.325 (scaffold #375), so a non-browser producer may
 *   still omit the field; the browser SDK's default emit uses the prefixed
 *   fallback rather than omitting, because a countable placeholder beats a
 *   hole in a join.
 *
 * The prefix is **not** a sentinel for a missing value and it is **not**
 * hashed: it is a namespace marker in front of whatever identity key the same
 * event carries in `user_id` (already PII-redacted by the caller, so an
 * email-shaped user id is a hash on both sides of the colon boundary).
 *
 * @module
 */

/**
 * Namespace marker in front of an `account_id` the SDK **fabricated** from the
 * user id because the integration identified no account.
 *
 * Stable wire contract: analytics read-time guards match on this literal, so
 * changing it is a breaking change to every pipe that filters on it. Callers
 * should compare with {@link isFallbackAccountId} rather than re-deriving the
 * string.
 *
 * @example
 * ```ts
 * import { FALLBACK_ACCOUNT_ID_PREFIX } from '@revturbine/sdk';
 *
 * FALLBACK_ACCOUNT_ID_PREFIX; // 'user-fallback:'
 * ```
 *
 * @public
 */
export const FALLBACK_ACCOUNT_ID_PREFIX = 'user-fallback:';

/**
 * Build the fallback account key for a user id — {@link
 * FALLBACK_ACCOUNT_ID_PREFIX} followed by the id verbatim.
 *
 * The id is used exactly as given: redaction and trimming belong to the caller,
 * which already resolved the `user_id` it is about to put on the same wire row.
 * Deriving the key here from a *different* normalization is how the two lanes
 * would stop joining.
 *
 * @param userId - The user id (or anonymous id) the event is attributed to,
 *   already normalized/redacted exactly as it will appear in `user_id`.
 * @returns The prefixed fallback account key.
 *
 * @public
 */
export function fallbackAccountId(userId: string): string {
  return `${FALLBACK_ACCOUNT_ID_PREFIX}${userId}`;
}

/**
 * Whether an `account_id` is one the SDK fabricated from a user id rather than
 * one the integration identified.
 *
 * Use it to keep fabricated keys out of account denominators, exactly as the
 * warehouse read-time guards do. `null`, `undefined`, and the bare prefix with
 * nothing after it are **not** fallback keys — the first two are absence, and
 * the third is not a key at all.
 *
 * @param accountId - The account id to classify.
 * @returns `true` only for a non-empty id carrying the fallback prefix.
 *
 * @public
 */
export function isFallbackAccountId(accountId: string | null | undefined): boolean {
  if (typeof accountId !== 'string') return false;
  return (
    accountId.startsWith(FALLBACK_ACCOUNT_ID_PREFIX) &&
    accountId.length > FALLBACK_ACCOUNT_ID_PREFIX.length
  );
}
