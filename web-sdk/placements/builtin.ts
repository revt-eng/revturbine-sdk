import type { PlacementTypeRegistry } from './registry';
import { BannerSlot as BannerComponent } from './slots/BannerSlot';
import { ModalSlot as ModalComponent } from './slots/ModalSlot';
import { InPageSlot as InPageComponent } from './slots/InPageSlot';
import { ToastSlot as ToastComponent } from './slots/ToastSlot';
import { ButtonSlot as ButtonComponent } from './slots/ButtonSlot';
import { QuotaMeterSlot as QuotaMeterComponent } from './slots/QuotaMeterSlot';
import { FullPageSlot as FullPageComponent } from './slots/FullPageSlot';
import { CliSlot as CliComponent } from './slots/CliSlot';
import { CreditBalanceSlot as CreditBalanceComponent } from './slots/CreditBalanceSlot';
import { TooltipSlot as TooltipComponent } from './slots/TooltipSlot';
import { AgentConnectorSlot as AgentConnectorComponent } from './slots/AgentConnectorSlot';
import {
  EmailPreviewSlot as EmailPreviewComponent,
  SmsPreviewSlot as SmsPreviewComponent,
  PushPreviewSlot as PushPreviewComponent,
} from './slots/ChannelPreviewSlots';

/** Canonical fields each built-in component visibly consumes. */
export const COMPONENT_FIELD_CONTRACTS = {
  banner: ['header', 'body', 'cta_label', 'secondary_cta_label', 'image_url', 'dismissible', 'position'],
  modal: ['header', 'body', 'cta_label', 'secondary_cta_label', 'image_url', 'dismissible', 'benefits', 'modal_type'],
  in_page: ['header', 'body', 'cta_label', 'secondary_cta_label', 'image_url', 'style'],
  inline: ['header', 'body', 'cta_label', 'secondary_cta_label', 'message'],
  tooltip: ['header', 'body', 'message', 'position', 'duration'],
  toast: ['header', 'body', 'message', 'cta_label', 'position', 'duration', 'dismissible'],
  button: ['cta_label', 'style'],
  full_page: ['header', 'body', 'cta_label', 'secondary_cta_label', 'image_url', 'benefits'],
  quota_meter: ['header', 'body', 'cta_label', 'usage_current', 'usage_limit', 'usage_percent', 'display_style'],
  credit_balance: ['header', 'body', 'cta_label', 'credits_remaining', 'credit_limit', 'display_style'],
  cli: ['header', 'body', 'message', 'cta_label', 'secondary_cta_label'],
  email: ['header', 'body', 'message', 'cta_label', 'secondary_cta_label'],
  sms: ['body', 'message', 'cta_label'],
  push: ['header', 'body', 'message', 'cta_label'],
  agent: ['header', 'body', 'message', 'cta_label', 'secondary_cta_label'],
} as const;

/**
 * Register all built-in slot types on the given registry.
 *
 * Built-in types cover the core surface types:
 * - banner       → BannerSlot (full-width top/bottom)
 * - modal        → ModalSlot (overlay dialog, optional/blocking)
 * - in_page      → InPageSlot (card/embed in page flow)
 * - toast        → ToastSlot (ephemeral notification)
 * - button       → ButtonSlot (nav bar / CTA button)
 * - full_page    → FullPageSlot (dedicated managed page)
 * - email/sms/push → channel previews (static out-of-band mocks)
 *
 * Additional specialized types registered as in_page variants:
 * - quota_meter  → QuotaMeterSlot (usage meter + upgrade CTA)
 */
export function registerBuiltinSlotTypes(registry: PlacementTypeRegistry): void {
  registry.register({
    id: 'banner',
    label: 'Banner',
    description: 'Full-width banner placement at the top or bottom of the page.',
    componentType: 'banner',
    renderedFields: COMPONENT_FIELD_CONTRACTS.banner,
    component: BannerComponent,
    defaultProps: {
      content: { position: 'top', dismissible: true },
    },
  });

  registry.register({
    id: 'modal',
    label: 'Modal Overlay',
    description: 'Centered overlay dialog. Supports optional (dismissible) and blocking modes.',
    componentType: 'modal',
    renderedFields: COMPONENT_FIELD_CONTRACTS.modal,
    component: ModalComponent,
  });

  registry.register({
    id: 'in_page',
    label: 'Inline Embed',
    description: 'Content card or message embedded in the page flow.',
    componentType: 'in_page',
    renderedFields: COMPONENT_FIELD_CONTRACTS.in_page,
    component: InPageComponent,
  });

  // Specialized in_page variant for plans/pricing CTA blocks.
  registry.register({
    id: 'plans_cta',
    label: 'Plans CTA',
    description: 'Pricing page CTA-focused module with concise upgrade actions.',
    componentType: 'in_page',
    renderedFields: COMPONENT_FIELD_CONTRACTS.in_page,
    component: InPageComponent,
    priority: 30,
    accepts: (output) =>
      output.surface.type === 'in_page' &&
      typeof output.surface.template === 'string' &&
      ['plans_cta', 'pricing_page_cta', 'plans_pricing_cta'].includes(output.surface.template),
  });

  // Specialized full-page pricing renderer variant.
  registry.register({
    id: 'plans_full',
    label: 'Plans Full Page',
    description: 'Dedicated plans and pricing full-page experience.',
    componentType: 'full_page',
    renderedFields: COMPONENT_FIELD_CONTRACTS.full_page,
    component: FullPageComponent,
    priority: 30,
    accepts: (output) =>
      typeof output.surface.template === 'string' &&
      ['plans_full', 'pricing_page_full', 'plans_pricing_full'].includes(output.surface.template),
  });

  // Specialized inline gate message variant (feature blocked inline prompt).
  registry.register({
    id: 'inline_gate_message',
    label: 'Inline Gate Message',
    description: 'Inline entitlement gate message with upgrade CTA.',
    componentType: 'inline',
    renderedFields: COMPONENT_FIELD_CONTRACTS.inline,
    component: InPageComponent,
    priority: 40,
    accepts: (output) =>
      output.surface.type === 'inline' &&
      typeof output.surface.template === 'string' &&
      ['inline_gate_message', 'inline_feature_gate', 'feature_gate_inline'].includes(output.surface.template),
  });

  // Tooltip-style compact guidance. Uses toast renderer for compact styling semantics.
  registry.register({
    id: 'tooltip',
    label: 'Tooltip',
    description: 'Compact tooltip-like guidance near a feature surface.',
    componentType: 'tooltip',
    renderedFields: COMPONENT_FIELD_CONTRACTS.tooltip,
    component: TooltipComponent,
    priority: 50,
    accepts: (output) => {
      const template = typeof output.surface.template === 'string' ? output.surface.template : '';
      return template === 'tooltip' || template === 'feature_tooltip' || template === 'inline_tooltip';
    },
    defaultProps: {
      content: { position: 'top-right', duration: 0 },
    },
  });

  registry.register({
    id: 'toast',
    label: 'Toast Notification',
    description: 'Small transient notification that auto-dismisses.',
    componentType: 'toast',
    renderedFields: COMPONENT_FIELD_CONTRACTS.toast,
    component: ToastComponent,
    defaultProps: {
      content: { position: 'bottom-right', duration: 5 },
    },
  });

  registry.register({
    id: 'button',
    label: 'Button',
    description: 'Persistent button in the product navigation or UI.',
    componentType: 'button',
    renderedFields: COMPONENT_FIELD_CONTRACTS.button,
    component: ButtonComponent,
    defaultProps: {
      content: { style: 'primary' },
    },
  });

  registry.register({
    id: 'full_page',
    label: 'Full Page',
    description: 'Dedicated managed page (e.g. plans & pricing).',
    componentType: 'full_page',
    renderedFields: COMPONENT_FIELD_CONTRACTS.full_page,
    component: FullPageComponent,
  });

  // Specialized in_page variant for quota/usage meters
  registry.register({
    id: 'quota_meter',
    label: 'Quota Meter',
    description: 'Visual usage meter with upgrade CTA. Triggers at configurable threshold.',
    componentType: 'in_page',
    renderedFields: COMPONENT_FIELD_CONTRACTS.quota_meter,
    component: QuotaMeterComponent,
    accepts: (output) =>
      output.surface.type === 'in_page' &&
      (output.surface.template === 'quota_meter' ||
        output.surface.template === 'quota_meter_counter_upgrade_button'),
  });

  // Specialized in_page trial counter variant.
  registry.register({
    id: 'trial_counter',
    label: 'Trial Counter',
    description: 'Trial countdown/counter with conversion CTA.',
    componentType: 'in_page',
    renderedFields: COMPONENT_FIELD_CONTRACTS.quota_meter,
    component: QuotaMeterComponent,
    priority: 35,
    accepts: (output) =>
      output.surface.type === 'in_page' &&
      typeof output.surface.template === 'string' &&
      ['trial_counter', 'trial_countdown', 'trial_days_counter'].includes(output.surface.template),
    defaultProps: {
      content: {
        display_style: 'numeric_counter',
      },
    },
  });

  registry.register({
    id: 'cli',
    label: 'CLI Message',
    description: 'Message in a CLI or chat-style interface with action links.',
    componentType: 'cli',
    renderedFields: COMPONENT_FIELD_CONTRACTS.cli,
    component: CliComponent,
  });

  // Out-of-band channel previews (plan 76 TASK-15). These surface types are
  // delivered outside the product DOM (email service, SMS gateway, push
  // provider), so they render a static channel mock rather than a live
  // in-product surface — without these the renderer silently no-ops on them.
  registry.register({
    id: 'email',
    label: 'Email Preview',
    description: 'Static email channel preview (subject + body + CTAs).',
    componentType: 'email',
    renderedFields: COMPONENT_FIELD_CONTRACTS.email,
    component: EmailPreviewComponent,
  });

  registry.register({
    id: 'sms',
    label: 'SMS Preview',
    description: 'Static SMS channel preview (message bubble + CTAs).',
    componentType: 'sms',
    renderedFields: COMPONENT_FIELD_CONTRACTS.sms,
    component: SmsPreviewComponent,
  });

  registry.register({
    id: 'push',
    label: 'Push Preview',
    description: 'Static push-notification channel preview (title + body + CTAs).',
    componentType: 'push',
    renderedFields: COMPONENT_FIELD_CONTRACTS.push,
    component: PushPreviewComponent,
  });

  // Agent connector renderer variant (agent surface parity).
  registry.register({
    id: 'agent_connector',
    label: 'Agent Connector',
    description: 'Agent-surface placement for assistant/connector experiences.',
    componentType: 'agent',
    renderedFields: COMPONENT_FIELD_CONTRACTS.agent,
    component: AgentConnectorComponent,
    priority: 30,
    accepts: (output) => {
      const template = typeof output.surface.template === 'string' ? output.surface.template : '';
      return output.surface.type === 'agent' || template === 'agent_connector';
    },
  });

  // Specialized in_page variant for credit balance counters
  registry.register({
    id: 'credit_balance',
    label: 'Credit Balance Counter',
    description: 'Depleting credit balance display with purchase/upgrade CTA.',
    componentType: 'in_page',
    renderedFields: COMPONENT_FIELD_CONTRACTS.credit_balance,
    component: CreditBalanceComponent,
    accepts: (output) =>
      output.surface.type === 'in_page' &&
      (output.surface.template === 'credit_balance_counter' ||
        output.surface.template === 'credit_balance'),
  });
}
