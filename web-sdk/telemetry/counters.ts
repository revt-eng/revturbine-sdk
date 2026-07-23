/**
 * Telemetry pipeline counters (plan 144 TASK-8).
 *
 * Per-stage tallies for the event delivery pipeline — a cheap diagnostic
 * surface for answering "why did my events not show up?" without a debugger.
 * `sampled` and `deduped` are wired here but stay zero until the sampling and
 * client-dedupe stages land in later tasks.
 */

/** Running counts for each stage an event passes through (or is dropped at). */
export interface TelemetryCounters {
  /** Envelopes built after passing the consent gate. */
  created: number;
  /** Events dropped before any destination — currently the consent gate. */
  dropped: number;
  /** Property values scrubbed by PII redaction. */
  redacted: number;
  /** Events dropped by sampling. Zero until sampling ships. */
  sampled: number;
  /** Events collapsed by client-side dedupe. Zero until dedupe ships. */
  deduped: number;
  /** Envelopes buffered for a later batch flush. */
  queued: number;
  /** Rows the ingest call delivered (2xx). */
  sent: number;
  /** Rows whose ingest delivery failed after retries. */
  failed: number;
}

/** A fresh zeroed counter set. */
export function createTelemetryCounters(): TelemetryCounters {
  return {
    created: 0,
    dropped: 0,
    redacted: 0,
    sampled: 0,
    deduped: 0,
    queued: 0,
    sent: 0,
    failed: 0,
  };
}
