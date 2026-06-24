import type { DemoUserId } from './shared';
import {
  FIXED_BANNER_TEMPLATE_IDS,
  GENERAL_BANNER_TEMPLATE_IDS,
  GENERAL_MODAL_TEMPLATE_IDS,
  GENERAL_TOAST_TEMPLATE_IDS,
} from '../../../web-sdk/placements/surface-template-defaults';

/**
 * Top-level sidebar groups — one per SurfaceSlot component type.
 */
export type SandpackScenarioGroup = 'Fixed Slots' | 'Access Gates' | 'Global Slots' | 'Headless API';

export type SandpackScenario = {
  id: string;
  code: string;
  title: string;
  group: SandpackScenarioGroup;
  /** Surface template ID that this scenario demonstrates. */
  templateId: string;
  /** Surface slot ID (matches the placement trigger's slot_id). */
  slotId: string;
  /** Surface template IDs this slot accepts. */
  surfaceTemplateIds: string[];
  /**
   * Which SurfaceSlot component variant to render.
   *
   * - `FixedSurfaceSlot` — always-visible inline slot
   * - `AccessGateSurfaceSlot` — shows gated content on entitlement denial
   * - `MessageSurfaceSlot` — toast/modal triggered placements
   * - `HeadlessPlacement` — headless PlacementController demo
   * - `HeadlessEntitlementGate` — headless EntitlementGate demo
   * - `HeadlessSession` — headless SdkSession one-shot demo
   */
  component:
    | 'FixedSurfaceSlot'
    | 'AccessGateSurfaceSlot'
    | 'MessageSurfaceSlot'
    | 'HeadlessPlacement'
    | 'HeadlessEntitlementGate'
    | 'HeadlessSession';
  /** For AccessGate / HeadlessEntitlementGate scenarios: entitlement handle to gate on. */
  entitlementHandle?: string;
  demoUserId: DemoUserId;
};

// ── Fixed Slots ──────────────────────────────────────────────────────────

const fixedScenarios: SandpackScenario[] = [
  {
    id: 'fixed-button',
    code: 'F-1',
    title: 'Upgrade Button',
    group: 'Fixed Slots',
    templateId: 'button',
    slotId: 'nav_bar_right',
    surfaceTemplateIds: ['button'],
    component: 'FixedSurfaceSlot',
    demoUserId: 'user_carol',
  },
  {
    id: 'fixed-in-page',
    code: 'F-2',
    title: 'Plans & Pricing Card',
    group: 'Fixed Slots',
    templateId: 'in_page_card',
    slotId: 'pricing_main_content',
    surfaceTemplateIds: ['in_page_card'],
    component: 'FixedSurfaceSlot',
    demoUserId: 'user_alice',
  },
  {
    id: 'fixed-usage-counter',
    code: 'F-3',
    title: 'Quota Meter',
    group: 'Fixed Slots',
    templateId: 'usage_counter',
    slotId: 'sidebar_usage_widget',
    surfaceTemplateIds: ['usage_counter'],
    component: 'FixedSurfaceSlot',
    demoUserId: 'user_alice',
  },
  {
    id: 'fixed-banner',
    code: 'F-4',
    title: 'Annual Nudge Banner',
    group: 'Fixed Slots',
    templateId: 'banner_placement',
    slotId: 'dashboard_top_banner',
    surfaceTemplateIds: FIXED_BANNER_TEMPLATE_IDS as string[],
    component: 'FixedSurfaceSlot',
    demoUserId: 'user_bob',
  },
];

// ── Access Gates ─────────────────────────────────────────────────────────

const accessGateScenarios: SandpackScenario[] = [
  {
    id: 'gate-modal',
    code: 'G-1',
    title: 'Data Export Gate',
    group: 'Access Gates',
    templateId: 'modal_overlay',
    slotId: 'editor_export_action',
    surfaceTemplateIds: GENERAL_MODAL_TEMPLATE_IDS as string[],
    component: 'AccessGateSurfaceSlot',
    entitlementHandle: 'data_export',
    demoUserId: 'user_dan',
  },
  {
    id: 'gate-inline',
    code: 'G-2',
    title: 'Branding Gate',
    group: 'Access Gates',
    templateId: 'inline_gate_message',
    slotId: 'editor_branding_toggle',
    surfaceTemplateIds: ['inline_gate_message'],
    component: 'AccessGateSurfaceSlot',
    entitlementHandle: 'branding',
    demoUserId: 'user_dan',
  },
  {
    id: 'gate-card',
    code: 'G-3',
    title: 'Brand Kit Gate',
    group: 'Access Gates',
    templateId: 'in_page_card',
    slotId: 'settings_brand_section',
    surfaceTemplateIds: ['in_page_card'],
    component: 'AccessGateSurfaceSlot',
    entitlementHandle: 'brand_kit',
    demoUserId: 'user_dan',
  },
];

// ── Global Slots ─────────────────────────────────────────────────────────

const messageScenarios: SandpackScenario[] = [
  {
    id: 'msg-banner',
    code: 'M-1',
    title: 'Usage Warning Banner',
    group: 'Global Slots',
    templateId: 'banner_placement',
    slotId: 'global_banner',
    surfaceTemplateIds: GENERAL_BANNER_TEMPLATE_IDS as string[],
    component: 'MessageSurfaceSlot',
    demoUserId: 'user_alice',
  },
  {
    id: 'msg-modal',
    code: 'M-2',
    title: 'Usage Exhausted Modal',
    group: 'Global Slots',
    templateId: 'modal_overlay',
    slotId: 'global_modal',
    surfaceTemplateIds: GENERAL_MODAL_TEMPLATE_IDS as string[],
    component: 'MessageSurfaceSlot',
    demoUserId: 'user_alice',
  },
  {
    id: 'msg-toast',
    code: 'M-3',
    title: 'Trial Welcome Toast',
    group: 'Global Slots',
    templateId: 'toast_message',
    slotId: 'global_toast',
    surfaceTemplateIds: GENERAL_TOAST_TEMPLATE_IDS as string[],
    component: 'MessageSurfaceSlot',
    demoUserId: 'user_bob',
  },
];

// ── Headless API ─────────────────────────────────────────────────────────

const headlessScenarios: SandpackScenario[] = [
  {
    id: 'headless-placement',
    code: 'H-1',
    title: 'PlacementController',
    group: 'Headless API',
    templateId: 'banner_placement',
    slotId: 'dashboard_top_banner',
    surfaceTemplateIds: FIXED_BANNER_TEMPLATE_IDS as string[],
    component: 'HeadlessPlacement',
    demoUserId: 'user_bob',
  },
  {
    id: 'headless-gate',
    code: 'H-2',
    title: 'EntitlementGate',
    group: 'Headless API',
    templateId: 'in_page_card',
    slotId: 'settings_brand_section',
    surfaceTemplateIds: ['in_page_card'],
    component: 'HeadlessEntitlementGate',
    entitlementHandle: 'brand_kit',
    demoUserId: 'user_dan',
  },
  {
    id: 'headless-session',
    code: 'H-3',
    title: 'SdkSession One-Shot',
    group: 'Headless API',
    templateId: 'banner_placement',
    slotId: 'dashboard_top_banner',
    surfaceTemplateIds: FIXED_BANNER_TEMPLATE_IDS as string[],
    component: 'HeadlessSession',
    entitlementHandle: 'brand_kit',
    demoUserId: 'user_carol',
  },
];

export const sandpackScenarios: SandpackScenario[] = [
  ...fixedScenarios,
  ...accessGateScenarios,
  ...messageScenarios,
  ...headlessScenarios,
];
