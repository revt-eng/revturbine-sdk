/**
 * Telemetry delivery pipeline internals (plan 144 TASK-7).
 *
 * Home for the cross-cutting delivery concerns extracted from the customer SDK:
 * sortable event-id minting and bounded byte-identical retry. Consent gating and
 * the created/dropped/redacted/sampled/deduped/queued/sent/failed counters land
 * here in TASK-8.
 */
export { createEventIdGenerator, eventIds } from './event-id';
export type { EventIdGenerator } from './event-id';
export { deliverWithRetry } from './delivery';
export type { DeliverOptions, DeliveryOutcome } from './delivery';
export { createTelemetryCounters } from './counters';
export type { TelemetryCounters } from './counters';
export { createExposureManager, exposureManager } from './visibility';
export type { ExposureBasis, ExposureManager, ExposureObserveOptions } from './visibility';
