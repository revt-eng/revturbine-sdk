// Type system
export type {
  PlacementSlotType,
  PlacementSlotProps,
  PlacementContentFields,
  ResolvedContent,
  PlacementUiPath,
  PlacementUiPathActionType,
  PlacementPromotion,
  RegisterPlacementSlotTypeOptions,
  PersonalizationContext,
  PlacementPreviewConfig,
  PlacementCustomCode,
  CtaResolver,
  CtaResolverContext,
} from './types';

// Registry
export {
  PlacementTypeRegistry,
  getDefaultRegistry,
  resetDefaultRegistry,
  resolveContent,
  resolveTokens,
  parseUiPath,
  parsePromotion,
} from './registry';

// CTA resolver registry (custom CTA action dispatch)
export {
  CtaResolverRegistry,
  getDefaultCtaResolverRegistry,
  resetDefaultCtaResolverRegistry,
  registerCtaResolver,
  unregisterCtaResolver,
  dispatchCtaClick,
} from './cta-resolvers';

// Built-in slot type registration
export { registerBuiltinSlotTypes } from './builtin';

// Built-in slot components (for direct use or extension)
export {
  BannerSlot,
  ModalSlot,
  InlineEmbedSlot,
  InPageSlot,
  ToastSlot,
  ButtonSlot,
  QuotaMeterSlot,
  FullPageSlot,
  CliSlot,
  CreditBalanceSlot,
  TooltipSlot,
  AgentConnectorSlot,
} from './slots';
export type {
  BannerSlotProps,
  ModalSlotProps,
  InlineEmbedSlotProps,
  InPageSlotProps,
  ToastSlotProps,
  ButtonSlotProps,
  QuotaMeterSlotProps,
  FullPageSlotProps,
  CliSlotProps,
  CreditBalanceSlotProps,
  TooltipSlotProps,
  AgentConnectorSlotProps,
} from './slots';

// React components
export { PlacementRenderer } from './PlacementRenderer';
export type { PlacementRendererProps } from './PlacementRenderer';

// Surface-slot rendering (hook + component)
export { useSurfaceSlot } from './useSurfaceSlot';
export type { UseSurfaceSlotOptions, UseSurfaceSlotResult } from './useSurfaceSlot';

export { usePlacementPersonalization } from './usePlacementPersonalization';
export type { UsePlacementPersonalizationOptions } from './usePlacementPersonalization';

// Surface slot components
export {
  SurfaceSlotComponent,
} from './SurfaceSlotComponent';
export type {
  SurfaceSlotComponentProps,
  SurfaceSlotCategory,
} from './SurfaceSlotComponent';

// Semantic surface slots
export { FixedSurfaceSlot, FIXED_SURFACE_TEMPLATE_IDS } from './FixedSurfaceSlot';
export type { FixedSurfaceSlotProps } from './FixedSurfaceSlot';

export { AccessGateSurfaceSlot, GATED_SURFACE_TEMPLATE_IDS } from './AccessGateSurfaceSlot';
export type { AccessGateSurfaceSlotProps, AccessGateCheck } from './AccessGateSurfaceSlot';

export { MessageSurfaceSlot, MESSAGE_SURFACE_TEMPLATE_IDS } from './MessageSurfaceSlot';
export type { MessageSurfaceSlotProps, MessageSurfaceSlotRef, MessageTriggerType } from './MessageSurfaceSlot';

// Pre-defined surface template ID sets
export {
  FIXED_BANNER_TEMPLATE_IDS,
  GENERAL_BANNER_TEMPLATE_IDS,
  GENERAL_TOAST_TEMPLATE_IDS,
  GENERAL_MODAL_TEMPLATE_IDS,
} from './surface-template-defaults';

// Payload resolution
export {
  resolvePayloadForUser,
  resolvePayloadForUserWithProvider,
  applyValueMaps,
  createStaticPlacementContentLookupProvider,
} from './payload-resolution';
export type {
  ResolvedPayload,
  PlacementContentLookupProvider,
} from './payload-resolution';

// Local-only placement resolver factory
export {
  createStaticPlacementResolver,
} from './local-resolver';
export type {
  LocalPlacementDataset,
  LocalPlacementEntry,
  LocalPlacementPayload,
  LocalPlacementSurface,
  StaticPlacementResolverOptions,
} from './local-resolver';

// Provider-derived token context utilities
export { derivePlacementPersonalizationTokens } from './token-derivation';

// Abstract base components for customer extension
export * from './abstract';
