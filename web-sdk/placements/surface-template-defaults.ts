/**
 * Pre-defined surface template ID sets.
 *
 * Each array represents a semantic grouping of template IDs that a
 * SurfaceSlot can accept. Components can import these directly or
 * pass them as `surfaceTemplateIds` props.
 */

/** Banner templates only — for fixed or triggered banner slots. */
export const FIXED_BANNER_TEMPLATE_IDS: readonly string[] = [
  'banner_placement',
];

/** General banner slot — accepts banners and in-page cards. */
export const GENERAL_BANNER_TEMPLATE_IDS: readonly string[] = [
  'banner_placement',
  'in_page_card',
];

/** General toast slot — accepts toast messages. */
export const GENERAL_TOAST_TEMPLATE_IDS: readonly string[] = [
  'toast_message',
];

/** General modal slot — accepts modal overlays. */
export const GENERAL_MODAL_TEMPLATE_IDS: readonly string[] = [
  'modal_overlay',
];
