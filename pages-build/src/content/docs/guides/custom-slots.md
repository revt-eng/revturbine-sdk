---
title: Custom Slot Types
description: Register custom placement components beyond the built-in slots.
sidebar:
  order: 7
---

import { Aside } from '@astrojs/starlight/components';

The SDK ships with 11 built-in slot components (banner, modal, toast, etc.). When those don't fit your use case, you can register custom slot types.

## Built-In Slot Types

| ID | Component | Component Type |
|---|---|---|
| `banner` | `BannerSlot` | `banner` |
| `modal` | `ModalSlot` | `modal` |
| `toast` | `ToastSlot` | `toast` |
| `inline_embed` | `InlineEmbedSlot` | `inline_embed` |
| `button` | `ButtonSlot` | `button` |
| `quota_meter` | `QuotaMeterSlot` | `quota_meter` |
| `full_page` | `FullPageSlot` | `full_page` |
| `cli` | `CliSlot` | `cli` |
| `credit_balance` | `CreditBalanceSlot` | `credit_balance` |
| `tooltip` | `TooltipSlot` | `tooltip` |
| `agent_connector` | `AgentConnectorSlot` | `agent_connector` |

:::tip[Visual gallery]
Every built-in slot has a co-located `.stories.tsx` file in `web-sdk/placements/slots/`.
Run `pnpm storybook` in the SDK repo to preview all variants, or try the
[Playground](/playground/) for live Sandpack demos.
:::

## Registering a Custom Slot

Create a `PlacementSlotType` definition and register it:

```tsx
import { PlacementTypeRegistry, useRevTurbineTheme } from '@revturbine/sdk';
import type { PlacementSlotProps } from '@revturbine/sdk';

// 1. Define the component
function FeedbackWidget({ content, onDismiss, onCtaClick, exposureRef }: PlacementSlotProps) {
  const theme = useRevTurbineTheme();
  return (
    <div ref={exposureRef} className="feedback-widget" style={{ color: theme.colors.text }}>
      <p>{content?.body}</p>
      <div>
        <button onClick={onCtaClick}>{content?.cta_label ?? 'Submit'}</button>
        <button onClick={onDismiss}>Not now</button>
      </div>
    </div>
  );
}

// 2. Register it
const registry = new PlacementTypeRegistry();

registry.register({
  id: 'custom:feedback-widget',
  label: 'Feedback Widget',
  description: 'In-app feedback collection prompt',
  // One of the SDK's component types — see the table below.
  componentType: 'in_page',
  component: FeedbackWidget,
  priority: 10,
  // The template id lives on the decision's surface, not at the top level.
  accepts: (output) => output.surface.template === 'feedback_v1',
});
```

### Registration Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | ✅ | Unique identifier (prefix with `custom:`) |
| `label` | `string` | ✅ | Human-readable label (shown in Studio) |
| `description` | `string` | ✅ | What this slot type does |
| `componentType` | `RevTurbineComponentType` | ✅ | Canonical component type |
| `component` | `ComponentType<PlacementSlotProps>` | ✅ | React component to render |
| `accepts` | `(output) => boolean` | — | Predicate to match specific placements |
| `priority` | `number` | — | Higher = evaluated first (default: 0) |
| `defaultProps` | `Partial<PlacementSlotProps>` | — | Default props merged into component |

## PlacementSlotProps Contract

All slot components (built-in and custom) receive the same props:

```ts
interface PlacementSlotProps {
  placement: PlacementOutput;
  content: ResolvedContent;
  uiPath: PlacementUiPath;
  promotion?: PlacementPromotion;

  // Renderer callbacks
  onCtaClick: () => void;
  onSecondaryCtaClick?: () => void;
  onDismiss: () => void;
  onRemindLater?: () => void;

  visible: boolean;
  className?: string;
  style?: React.CSSProperties;
  exposureRef?: (element: Element | null) => void;
}
```

:::caution
Never narrow the `PlacementSlotProps` interface — only extend it. Custom slots should accept all props even if they don't use them.
:::

## Using the Registry

Pass your registry to `<Slot>`:

```tsx
<Slot
  id="feedback_slot"
  surfaceTemplateIds={['feedback_v1']}
  registry={registry}
/>
```

The SDK evaluates registered types by priority, calling `accepts()` on each until one matches.

## Theme Integration

Custom slots obtain the active theme with `useRevTurbineTheme()`:

```tsx
function CustomCard({ content, onCtaClick }: PlacementSlotProps) {
  const theme = useRevTurbineTheme();
  return (
    <div style={{
      background: theme.colors.surface,
      borderRadius: theme.shape.borderRadius,
      border: `1px solid ${theme.colors.surfaceBorder}`,
      fontFamily: theme.typography.fontFamily,
      color: theme.colors.text,
      padding: 16,
    }}>
      <h3 style={{ fontSize: theme.typography.fontSizeHeader }}>
        {content?.header}
      </h3>
      <p>{content?.body}</p>
      <button
        style={{
          background: theme.colors.primary,
          color: theme.colors.primaryText,
          borderRadius: theme.shape.borderRadiusSmall,
        }}
        onClick={() => onCtaClick()}
      >
        {content?.cta_label}
      </button>
    </div>
  );
}
```

## Next Steps

- [Theming Guide](/guides/theming/) — customize colors, typography, and shapes
- [Component Gallery](/components/) — built-in slot demos
- [API Reference](/api/) — `PlacementTypeRegistry` and `PlacementSlotProps` docs
