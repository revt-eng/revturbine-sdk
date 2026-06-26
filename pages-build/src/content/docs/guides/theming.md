---
title: Theming
description: Customize the appearance of built-in slot components with themes.
sidebar:
  order: 8
---

import { Aside } from '@astrojs/starlight/components';

Built-in slot components (banner, modal, toast, etc.) use a theme system for colors, typography, shapes, and shadows. You can use the default theme, apply a built-in variant, or define your own.

## Theme Structure

```ts
interface RevTurbineTheme {
  colors: RevTurbineThemeColors;
  typography: RevTurbineThemeTypography;
  shape: RevTurbineThemeShape;
  shadows: RevTurbineThemeShadows;
}
```

## Color Tokens

| Token | Default | Purpose |
|---|---|---|
| `primary` | `#1e40af` | Primary CTA buttons, links |
| `primaryText` | `#ffffff` | Text on primary background |
| `secondary` | `#f3f4f6` | Secondary buttons, backgrounds |
| `secondaryText` | `#1f2937` | Text on secondary background |
| `accent` | `#7c3aed` | Highlight elements |
| `accentText` | `#ffffff` | Text on accent background |
| `background` | `#ffffff` | Page background |
| `surface` | `#f8fafc` | Card/surface background |
| `surfaceBorder` | `#e2e8f0` | Card borders |
| `text` | `#111827` | Primary text |
| `textSecondary` | `#4b5563` | Secondary/description text |
| `textMuted` | `#6b7280` | Muted/hint text |
| `overlay` | `rgba(0,0,0,0.5)` | Modal backdrop |
| `success` | `#16a34a` | Success states |
| `warning` | `#f59e0b` | Warning states (quota 70–90%) |
| `danger` | `#dc2626` | Danger states (quota > 90%) |
| `info` | `#60a5fa` | Informational states |
| `track` | `#e5e7eb` | Meter/progress track background |
| `toastBackground` | `#1f2937` | Toast notification background |
| `toastText` | `#ffffff` | Toast notification text |

## Typography Tokens

| Token | Default | Purpose |
|---|---|---|
| `fontFamily` | `system-ui, -apple-system, sans-serif` | Body text |
| `fontFamilyMono` | `ui-monospace, SFMono-Regular, ...` | Code/CLI text |
| `fontSize` | `14px` | Base font size |
| `fontSizeSmall` | `13px` | Small text |
| `fontSizeHeader` | `20px` | Section headers |
| `fontSizeLargeHeader` | `28px` | Page/modal titles |

## Shape Tokens

| Token | Default | Purpose |
|---|---|---|
| `borderRadiusSmall` | `6px` | Buttons, inputs |
| `borderRadius` | `8px` | Cards, panels |
| `borderRadiusLarge` | `12px` | Modals, large surfaces |

## Shadow Tokens

| Token | Default | Purpose |
|---|---|---|
| `medium` | `0 10px 40px rgba(0,0,0,0.25)` | Toast, dropdown |
| `large` | `0 20px 60px rgba(0,0,0,0.3)` | Modal |

## Applying a Custom Theme

Pass your theme through the ExportedConfig or provider:

```tsx
const customTheme = {
  colors: {
    primary: '#6366f1',      // Indigo
    primaryText: '#ffffff',
    accent: '#ec4899',       // Pink
    accentText: '#ffffff',
    surface: '#fafafa',
    surfaceBorder: '#e5e5e5',
    text: '#171717',
    textSecondary: '#525252',
    // ... other tokens use defaults
  },
  typography: {
    fontFamily: '"Inter", system-ui, sans-serif',
    fontSizeHeader: '18px',
  },
  shape: {
    borderRadius: '12px',
    borderRadiusSmall: '8px',
  },
  shadows: {
    large: '0 25px 50px rgba(0,0,0,0.15)',
  },
};
```

Partial themes are merged with defaults — you only need to specify the tokens you want to change.

## Accessing the Theme

### In React Components

```tsx
import { useRevTurbineTheme } from '@revturbine/sdk';

function ThemedBadge({ label }) {
  const theme = useRevTurbineTheme();

  return (
    <span style={{
      background: theme.colors.accent,
      color: theme.colors.accentText,
      borderRadius: theme.shape.borderRadiusSmall,
      fontFamily: theme.typography.fontFamily,
      fontSize: theme.typography.fontSizeSmall,
      padding: '2px 8px',
    }}>
      {label}
    </span>
  );
}
```

### In Custom Slot Components

Custom slot components receive the theme as a prop:

```tsx
function MySlot({ content, theme }: PlacementSlotProps) {
  return (
    <div style={{
      background: theme.colors.surface,
      color: theme.colors.text,
      borderRadius: theme.shape.borderRadius,
    }}>
      {content?.body}
    </div>
  );
}
```

## Theme Priority

The theme is resolved from multiple sources, in priority order:

1. **ExportedConfig snapshot** — theme bundled in the config (no network call)
2. **API / localStorage** — fetched from the RevTurbine API or cached
3. **Default theme** — built-in defaults

In `local_only` mode, the theme always comes from the ExportedConfig.

## Next Steps

- [Custom Slot Types](/guides/custom-slots/) — build components that use the theme
- [Component Gallery](/components/) — built-in slot demos with theme switching
