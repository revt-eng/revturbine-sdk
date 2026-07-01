/**
 * Control-plane semantic events (plan 112).
 *
 * A typed layer over the SDK's generic event emit path for RevTurbine's OWN
 * control-plane activity — web/CLI auth, change-set lifecycle, config, and
 * product-entity actions. This is the "dogfood" surface: RevTurbine emits its
 * product usage through the same SDK a customer uses.
 *
 * The taxonomy itself is the canonical `ControlPlaneEventType` /
 * `ControlPlaneEventSource` enums from `@revt-eng/schema`; this module adds the
 * source classification map and a small builder so emitters never have to
 * remember whether an event is `system` or `workflow`.
 *
 * Identity mapping (plan 112 REQ-3/REQ-4): the operator → `user_id`, the acting
 * RevTurbine customer tenant → `account_id` (set via
 * {@link RevTurbineCustomerSdk.identify} / `setUserContext`). `tenant_id` is
 * always RevTurbine's own tenant, stamped server-side — never carried here.
 *
 * @module
 */

import type { JsonValue } from '@revt-eng/core';
import type { ControlPlaneEventType, ControlPlaneEventSource } from '@revt-eng/schema';

export type { ControlPlaneEventType, ControlPlaneEventSource };

/**
 * Canonical source classification for every control-plane event type — mirrors
 * the scaffold taxonomy. `system` covers identity/auth + CLI command telemetry;
 * `workflow` covers change-set lifecycle, config, and product-entity actions.
 *
 * Typed as a total `Record`, so adding a new `ControlPlaneEventType` in scaffold
 * without classifying it here is a compile error.
 */
export const CONTROL_PLANE_EVENT_SOURCE: Record<ControlPlaneEventType, ControlPlaneEventSource> = {
  // Identity / auth — system
  web_signed_up: 'system',
  web_signed_in: 'system',
  cli_signed_up: 'system',
  cli_signed_in: 'system',
  // CLI commands — system
  cli_command_executed: 'system',
  // Change-set lifecycle — workflow
  changeset_submitted: 'workflow',
  changeset_approved: 'workflow',
  changeset_rejected: 'workflow',
  changeset_deployed: 'workflow',
  changeset_launched: 'workflow',
  changeset_parked: 'workflow',
  changeset_resumed: 'workflow',
  changeset_discarded: 'workflow',
  changeset_archived: 'workflow',
  // Config — workflow
  config_imported: 'workflow',
  config_exported: 'workflow',
  // Product-entity CRUD — workflow
  entity_created: 'workflow',
  entity_updated: 'workflow',
  entity_deleted: 'workflow',
};

/**
 * Property key under which {@link buildControlPlaneEvent} stamps the source
 * classification on an emitted event's properties bag.
 */
export const CONTROL_PLANE_SOURCE_KEY = 'control_plane_source';

/**
 * The `(eventName, properties)` pair produced by {@link buildControlPlaneEvent}.
 * `eventName` is the control-plane `event_type`; `properties` is the payload
 * with the source classification stamped under {@link CONTROL_PLANE_SOURCE_KEY}.
 */
export interface ControlPlaneEmitInput {
  eventName: ControlPlaneEventType;
  properties: Record<string, JsonValue>;
}

/**
 * Build the `(eventName, properties)` pair for a control-plane semantic event,
 * stamping the canonical source classification onto the payload.
 *
 * Pure — used both by the browser SDK's
 * {@link RevTurbineCustomerSdk.trackControlPlaneEvent} and by server/CLI
 * emitters that POST the same shape to the ingest endpoint.
 *
 * @param eventType - A canonical control-plane event type.
 * @param payload - Optional event-specific properties (e.g. `{ resource, resource_id }`).
 * @returns The emit input to hand to the SDK's `capture` path.
 */
export function buildControlPlaneEvent(
  eventType: ControlPlaneEventType,
  payload: Record<string, JsonValue> = {},
): ControlPlaneEmitInput {
  return {
    eventName: eventType,
    properties: {
      [CONTROL_PLANE_SOURCE_KEY]: CONTROL_PLANE_EVENT_SOURCE[eventType],
      ...payload,
    },
  };
}
