/**
 * Surface template ID constants.
 *
 * Extracted into a standalone .ts file so the headless (React-free) barrel
 * can import them without pulling in React component modules.
 */

/** Default template IDs accepted by `FixedSurfaceSlot`. */
export const FIXED_SURFACE_TEMPLATE_IDS: readonly string[] = [
  'banner_placement',
  'in_page_card',
  'usage_counter',
  'button',
];

/** Default template IDs accepted by `AccessGateSurfaceSlot`. */
export const GATED_SURFACE_TEMPLATE_IDS: readonly string[] = [
  'modal_overlay',
  'inline_gate_message',
];

/** Default template IDs accepted by `MessageSurfaceSlot`. */
export const MESSAGE_SURFACE_TEMPLATE_IDS: readonly string[] = [
  'toast_message',
  'modal_overlay',
  'banner_placement',
];
