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

Pass an optional `branding` value in your SDK options. This local React example changes a few tokens and lets the rest use defaults:

```tsx
import { RevTurbineProvider } from '@revturbine/sdk';
import { useMemo, type ReactNode } from 'react';
import playbook from './revturbine.playbook.json';

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

export function App({ children }: { children: ReactNode }) {
  const options = useMemo(() => ({
    localRuntime: { playbook },
    branding: { theme: customTheme },
  }), []);

  return (
    <RevTurbineProvider options={options} colorScheme="system">
      {children}
    </RevTurbineProvider>
  );
}
```

Partial themes are merged with defaults — you only need to specify the tokens you want to change.

### Light and dark palettes

Set the provider's `colorScheme` prop to `'light'`, `'dark'` or `'system'` (the default). System follows the device's preference. Pass your app's current preference to that prop when the user changes it; placements repaint without reinitializing the SDK. Keep it outside `options`.

`useRevTurbine().colorScheme` reports the resolved `'light'` or `'dark'` value. The selected palette supplies the defaults; explicit branding tokens still override those defaults.

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

1. **Explicit `branding` option** — supplied by your app at initialization
2. **Branding API** — supplied or fetched workspace branding
3. **Legacy config `theme`** — accepted for older artifacts, deprecated for new integrations
4. **Defaults** — the selected light or dark palette

The selected source's partial theme merges over defaults. For local mode, pass branding explicitly or use defaults. A legacy config theme still resolves for older artifacts; new Playbooks do not need one.

An app-mounted `RevTurbineThemeProvider` above `RevTurbineProvider` owns the rendered theme and takes precedence over this automatic resolution. Development builds warn about that override. Use this wrapper when your app deliberately manages the rendered theme; otherwise let `RevTurbineProvider` resolve it.

## Next Steps

- [Custom Slot Types](/guides/custom-slots/) — build components that use the theme
- [Component Gallery](/components/) — built-in slot demos with theme switching
