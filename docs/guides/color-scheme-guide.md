# Light and dark mode

The SDK ships both palettes. Placements follow the OS preference by default, and
you can pin or toggle the scheme at runtime without rebuilding anything.

## The default is `system`

Mount the provider and placements already follow `prefers-color-scheme`:

```tsx
<RevTurbineProvider options={options}>
  <App />
</RevTurbineProvider>
```

That keeps following it. A user flipping their OS theme repaints placements
without a remount.

## Pinning or toggling the scheme

`colorScheme` is a provider prop taking `'light' | 'dark' | 'system'`:

```tsx
import { useState } from 'react';
import { RevTurbineProvider, type RevTurbineColorScheme } from '@revturbine/sdk';

function Root() {
  const [scheme, setScheme] = useState<RevTurbineColorScheme>('system');

  return (
    <RevTurbineProvider options={options} colorScheme={scheme}>
      <button onClick={() => setScheme(scheme === 'dark' ? 'light' : 'dark')}>
        Toggle theme
      </button>
      <App />
    </RevTurbineProvider>
  );
}
```

Wire it to whatever your app already uses — a theme context, a settings store, a
class on `<html>`. The SDK does not own your app's theme state; it only needs to
be told which scheme to paint.

Read the resolved scheme anywhere inside the provider:

```tsx
const { colorScheme } = useRevTurbine(); // 'light' | 'dark' — 'system' already resolved
```

## Why `colorScheme` is a prop and not an init option

**A scheme change must not re-initialize the SDK.** The provider re-initializes
when `options` changes identity, so a scheme toggle placed in `options` would
tear down and rebuild the instance on every switch — discarding decision caches,
interaction state, and any in-flight work, to change a colour.

`colorScheme` sits outside `options` for exactly that reason. Toggling it is a
re-render. The SDK instance is the same object before and after.

This is also why you should not re-mount the provider or rebuild `options` to
change themes. If you find yourself doing either, the scheme prop is what you want.

## Branding and the scheme compose

The scheme selects the **base palette**; your branding tokens still win per token:

```tsx
<RevTurbineProvider
  options={{ ...options, branding: { theme: { colors: { primary: '#ff7a18' } } } }}
  colorScheme="dark"
>
  <App />
</RevTurbineProvider>
```

Your `primary` applies, and every token you did not specify comes from the dark
palette rather than the light one. Partial themes are valid everywhere — omitted
tokens fall back to the base.

## Taking over theming entirely

Mount your own provider around `RevTurbineProvider` and it wins:

```tsx
<RevTurbineThemeProvider theme={myDesignSystemTokens}>
  <RevTurbineProvider options={options}>
    <App />
  </RevTurbineProvider>
</RevTurbineThemeProvider>
```

In that arrangement the SDK does not resolve a theme at all — your tokens paint
placements, `colorScheme` no longer applies, and the SDK says so once in a
development build. Use this when your design system is the source of truth; use
`colorScheme` plus `branding` when you want the SDK to resolve it.

## What the palettes cover

`DEFAULT_THEME` (light) and `DARK_THEME` differ only in colours. Typography,
shape and shadows are scheme-independent and shared, so a token you set once
applies to both.

Both are exported if you want to extend rather than replace them:

```ts
import { DARK_THEME, mergeTheme } from '@revturbine/sdk';

const myDark = mergeTheme({ colors: { surface: '#1b2540' } }, DARK_THEME);
```

See the `SDK/Theme/ColorScheme` Storybook entry for both palettes rendered.
