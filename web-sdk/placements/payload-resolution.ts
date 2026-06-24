/**
 * Payload resolution — re-exported from @revt-eng/core.
 *
 * @see @revt-eng/core/resolution/payload-resolution
 */

export {
  resolveTokens,
  resolveContent,
  resolvePayloadForUser,
  resolvePayloadForUserWithProvider,
  applyValueMaps,
  createStaticPlacementContentLookupProvider,
} from '@revt-eng/core';

export type {
  ResolvedPayload,
  PlacementContentLookupProvider,
} from '@revt-eng/core';
