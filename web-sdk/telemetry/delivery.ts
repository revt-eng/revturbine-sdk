/**
 * Bounded, best-effort delivery for the RevTurbine ingest call (plan 144 TASK-7).
 *
 * REQ-4 / AC-23: telemetry delivery previously fired once and swallowed every
 * failure. This adds a bounded retry — but the retry MUST resend the identical
 * bytes the caller built, never a rebuilt payload. Each ingest row's
 * `request_id` is minted per build, and `events_clickstream` is a
 * `ReplacingMergeTree` whose sorting key ends on `request_id`; a rebuilt retry
 * would carry a fresh key and land as a *second* row. Re-sending the same body
 * lets storage collapse the re-delivery to exactly one row.
 */

/** How a delivery attempt sequence should be retried. `sleep` is injectable for tests. */
export interface DeliverOptions {
  /** Max additional attempts after the first. Default 2 (3 attempts total). */
  retries?: number;
  /** Backoff base; the wait before attempt N (1-indexed) is `baseDelayMs * N`. Default 200ms. */
  baseDelayMs?: number;
  /** Overridable delay so tests stay deterministic and fast. Defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

/** Outcome of a delivery attempt sequence. This never throws — telemetry is best-effort. */
export interface DeliveryOutcome {
  /** True once a 2xx response was received. */
  delivered: boolean;
  /** HTTP status of the final attempt, when one returned a response. */
  status?: number;
  /** The last transport error, when every attempt failed to get a response. */
  error?: Error;
  /** Total attempts made (1 = delivered on the first try). */
  attempts: number;
}

const DEFAULT_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 200;

// Statuses worth resending the identical row for. Any other 4xx is a permanent
// reject — resending the same bytes cannot fix it, so we don't waste attempts.
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Invoke `attempt` with bounded retry and resolve (never reject) with the
 * outcome.
 *
 * `attempt` MUST be a thunk that resends bytes the caller built once — e.g.
 * `() => fetch(url, init)` where `init.body` was serialized *before* this call.
 * Re-invoking the same thunk resends the identical body; rebuilding the payload
 * inside the thunk would defeat storage-layer dedup (see the module doc) and
 * manufacture a duplicate row.
 *
 * @param attempt - resends the pre-built request; called once per attempt
 * @param options - retry bounds and injectable sleep
 * @returns the delivery outcome; the promise never rejects
 */
export async function deliverWithRetry(
  attempt: () => Promise<Response>,
  options: DeliverOptions = {},
): Promise<DeliveryOutcome> {
  const retries = options.retries ?? DEFAULT_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: Error | undefined;
  for (let i = 0; i <= retries; i += 1) {
    try {
      const response = await attempt();
      if (response.ok) return { delivered: true, status: response.status, attempts: i + 1 };
      if (!RETRYABLE_STATUSES.has(response.status)) {
        return { delivered: false, status: response.status, attempts: i + 1 };
      }
      lastError = new Error(`ingest_status_${response.status}`);
    } catch (err) {
      // A caught value is `unknown`; normalize to Error so the outcome type
      // stays concrete (the SDK type-safety gate forbids `unknown` surfaces).
      lastError = err instanceof Error ? err : new Error(String(err));
    }
    if (i < retries) await sleep(baseDelayMs * (i + 1));
  }
  return { delivered: false, error: lastError, attempts: retries + 1 };
}
