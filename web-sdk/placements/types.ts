import type { RevTurbineSurfaceType, PlacementOutput } from '../customer-side';
import type { RevTurbineConfigUiPathActionType, RuntimePromotionSnapshot } from '../generated';

/**
 * Content fields common to most surface templates.
 * Individual placement slot types extend or narrow these.
 */
export interface PlacementContentFields {
  header?: string;
  body?: string;
  cta_label?: string;
  secondary_cta_label?: string;
  message?: string;
  image_url?: string;
  style?: string;
  dismissible?: boolean;
  position?: string;
  duration?: number;
}

/** Resolved content with personalization tokens expanded. */
export type ResolvedContent = PlacementContentFields & Record<string, unknown>; // sdk-ok: type-definition

/**
 * CTA action types recognized by the SDK.
 *
 * The built-in action types come from the schema's
 * `RevTurbineConfigUiPathActionType` (the single source of truth). The
 * `(string & {})` member keeps autocomplete for the built-ins while also
 * admitting **tenant-defined custom action names** — a placement authored
 * with a `custom` (or any unmapped) CTA action flows through the engine as
 * `{ type: <action-name>, ...config }`, and the SDK preserves that name so a
 * {@link CtaResolver} can be registered against it via `registerCtaResolver`.
 */
export type PlacementUiPathActionType = RevTurbineConfigUiPathActionType | (string & {});

/** UI path action that the CTA triggers. */
export interface PlacementUiPath {
  type: PlacementUiPathActionType;
  plan_handle?: string;
  promotion_id?: string;
  placement_handle?: string;
  url?: string;
  tour_id?: string;
  /**
   * Non-whitelisted config keys carried by a tenant-defined custom CTA.
   *
   * The engine spreads a custom CTA's authored `config` into the `cta_path`
   * record; {@link parseUiPath} lifts the known fields (`url`, `plan_handle`,
   * …) onto this object and collects every remaining key here so a custom
   * {@link CtaResolver} can read tenant-specific parameters. Omitted when the
   * action carries no extra params.
   */
  params?: Record<string, unknown>; // sdk-ok: type-definition
}

/**
 * Context handed to a {@link CtaResolver} when a placement CTA is activated.
 */
export interface CtaResolverContext {
  /** The full placement output whose CTA was activated. */
  placement: PlacementOutput;
  /** Which CTA fired — the primary button or a secondary action. */
  kind: 'primary' | 'secondary';
}

/**
 * A resolver bound to a CTA action type via `registerCtaResolver`.
 *
 * When a placement's CTA is clicked and a resolver is registered for the
 * parsed `uiPath.type`, the renderer invokes it instead of the generic
 * `onCtaClick` callback — letting customers handle tenant-defined custom
 * actions (e.g. opening an integration flow) with their own logic.
 */
export type CtaResolver = (uiPath: PlacementUiPath, context: CtaResolverContext) => void;

/**
 * Promotion attached to a placement payload.
 *
 * Re-exported from the schema's {@link RuntimePromotionSnapshot} —
 * lightweight promotion snapshot for placement rendering contexts.
 */
export type PlacementPromotion = RuntimePromotionSnapshot;

/**
 * Props passed to every placement slot renderer.
 *
 * The generic parameter `C` allows custom slot types to narrow
 * the `content` field to a specific shape, eliminating `unknown` casts:
 *
 * ```ts
 * interface MyContent extends ResolvedContent {
 *   modal_type: string;
 *   benefits: Array<{ text: string }>;
 * }
 * function MySlot(props: PlacementSlotProps<MyContent>) {
 *   props.content.modal_type; // string — no cast needed
 * }
 * ```
 */
export interface PlacementSlotProps<C extends ResolvedContent = ResolvedContent> {
  /** The full placement output from the decision engine. */
  placement: PlacementOutput;
  /** Resolved content fields with personalization tokens expanded. */
  content: C;
  /** Parsed UI path for CTA handling. */
  uiPath: PlacementUiPath;
  /** Optional promotion data. */
  promotion?: PlacementPromotion;
  /** Callback when user clicks the primary CTA. */
  onCtaClick: () => void;
  /** Callback when user clicks a secondary CTA. */
  onSecondaryCtaClick?: () => void;
  /** Callback when user dismisses the placement. */
  onDismiss: () => void;
  /** Whether the placement is currently visible. */
  visible: boolean;
  /** Custom CSS class name for styling overrides. */
  className?: string;
  /** Custom inline styles. */
  style?: React.CSSProperties;
}

/**
 * A placement slot type definition.
 *
 * Each slot type provides:
 * - A unique `id` matching a surface type or custom identifier
 * - A human-readable `label`
 * - A description of the slot behavior
 * - A React component that renders the placement
 * - Optional `defaultProps` for sensible defaults
 * - An `accepts` predicate controlling which outputs this type handles
 */
export interface PlacementSlotType<P extends PlacementSlotProps = PlacementSlotProps> {
  /** Unique identifier for this slot type (e.g. 'banner', 'modal', 'custom:my-widget'). */
  id: string;
  /** Human-readable label for the studio UI. */
  label: string;
  /** Description of this placement type. */
  description: string;
  /** The surface type this slot type handles, or 'custom' for custom types. */
  surfaceType: RevTurbineSurfaceType;
  /** The React component that renders this placement type. */
  component: React.ComponentType<P>;
  /** Default props merged with resolved props before rendering. */
  defaultProps?: Partial<P>;
  /**
   * Predicate to determine if this slot type can handle a given output.
   * Defaults to matching on `surfaceType`. Custom implementations can
   * match on template name, content shape, etc.
   */
  accepts?: (output: PlacementOutput) => boolean;
  /**
   * Resolution priority. Higher values are evaluated first when multiple
   * slot types match the same surface type. Use this to let narrow/specific
   * predicates take precedence over broad ones without relying on
   * registration order. Default `0`.
   */
  priority: number;
}

/**
 * Options for registering a custom placement type.
 * Identical to PlacementSlotType but all fields are required except defaultProps, accepts, and priority.
 */
export type RegisterPlacementSlotTypeOptions<P extends PlacementSlotProps = PlacementSlotProps> =
  Omit<PlacementSlotType<P>, 'accepts' | 'defaultProps' | 'priority'> & {
    defaultProps?: Partial<P>;
    accepts?: (output: PlacementOutput) => boolean;
    /** Resolution priority (default `0`). Higher values are evaluated first. */
    priority?: number;
  };

/**
 * Personalization token context for resolving `{{token}}` placeholders in content.
 */
export interface PersonalizationContext {
  user_name?: string;
  plan_name?: string;
  plan_price?: string;
  upgrade_plan_name?: string;
  upgrade_plan_price?: string;
  usage_current?: string | number;
  usage_limit?: string | number;
  usage_percent?: string | number;
  usage_remaining?: string | number;
  reset_date?: string;
  trial_days_remaining?: string | number;
  trial_days_total?: string | number;
  trial_plan_name?: string;
  trial_features_used?: string | number;
  premium_features_used_count?: string | number;
  top_unused_premium_feature?: string;
  premium_action_count?: string | number;
  specific_features_lost?: string;
  estimated_depletion_date?: string;
  credits_remaining?: string | number;
  seat_count?: string | number;
  seat_limit?: string | number;
  promo_discount?: string;
  [key: string]: string | number | undefined;
}

/**
 * Configuration for the placement preview sandbox.
 */
export interface PlacementPreviewConfig {
  /** The placement output to preview. */
  placement: PlacementOutput;
  /** Personalization context for token resolution. */
  personalization?: PersonalizationContext;
  /** Whether to render in a sandboxed iframe. */
  sandboxed?: boolean;
  /** Viewport width for preview. */
  viewportWidth?: number;
  /** Viewport height for preview. */
  viewportHeight?: number;
  /** Device form factor for preview. */
  device?: 'desktop' | 'tablet' | 'mobile';
}

/**
 * Custom code bundle uploaded by a customer for custom placement rendering.
 */
export interface PlacementCustomCode {
  /** Unique identifier for this code bundle. */
  id: string;
  /** The placement slot type this code renders. */
  slotTypeId: string;
  /** The React component source code (JSX/TSX). */
  code: string;
  /** Optional CSS/styling to apply. */
  css?: string;
  /** Version identifier for cache busting. */
  version: string;
  /** When this code was last updated. */
  updatedAt: string;
}
