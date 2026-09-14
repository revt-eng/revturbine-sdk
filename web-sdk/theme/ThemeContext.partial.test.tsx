/**
 * @vitest-environment jsdom
 *
 * Plan 233 TASK-4 / AC-5 — a partial theme is a valid theme.
 *
 * `RevTurbineThemeProvider` typed its `theme` prop as a complete
 * `RevTurbineTheme` and passed it into context untouched, while
 * `RevTurbineThemeInput` documented itself as "all values are optional — the SDK
 * deep-merges with defaults". Nothing did that merge at this boundary, so a
 * caller supplying `{ colors: { primary: '#f00' } }` produced a context value
 * with no `typography`, and every component reading `theme.typography.fontSize`
 * threw on an undefined section.
 *
 * `mergeTheme` itself was always correct — the gap was that this component never
 * called it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RevTurbineThemeProvider, useRevTurbineTheme } from './ThemeContext';
import { DEFAULT_THEME } from './defaults';
import type { RevTurbineTheme, RevTurbineThemeInput } from './types';

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let seen: RevTurbineTheme;

/** Reads the theme the way every built-in placement component does. */
function Consumer() {
  seen = useRevTurbineTheme();
  return <div>{seen.typography.fontSize}</div>;
}

async function render(theme: RevTurbineThemeInput): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <RevTurbineThemeProvider theme={theme}>
        <Consumer />
      </RevTurbineThemeProvider>,
    );
  });
}

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
});

describe('AC-5 — a one-token theme renders and defaults the rest', () => {
  it('renders without throwing and keeps the supplied token', async () => {
    await render({ colors: { primary: '#f00' } });

    expect(seen.colors.primary).toBe('#f00');
  });

  it('defaults a token from a section the caller never mentioned', async () => {
    // The guard TASK-4 names. Before this change `seen.typography` was
    // undefined and this read threw.
    await render({ colors: { primary: '#f00' } });

    expect(seen.typography.fontSize).toBe(DEFAULT_THEME.typography.fontSize);
    expect(container?.textContent).toBe(DEFAULT_THEME.typography.fontSize);
  });

  it('defaults sibling tokens within the section it did mention', async () => {
    await render({ colors: { primary: '#f00' } });

    // A partial `colors` map must extend the default map, not replace it.
    expect(seen.colors.background).toBe(DEFAULT_THEME.colors.background);
    expect(seen.colors.text).toBe(DEFAULT_THEME.colors.text);
  });

  it('fills every top-level section for a theme that sets none of them', async () => {
    await render({});

    for (const section of ['colors', 'typography', 'shape', 'shadows'] as const) {
      expect(seen[section], section).toBeDefined();
    }
  });

  it('still accepts a complete theme unchanged', async () => {
    // Widening the prop must not break callers already passing a full theme.
    await render(DEFAULT_THEME);

    expect(seen).toEqual(DEFAULT_THEME);
  });

  it('merges each section independently', async () => {
    await render({ shape: { borderRadius: '999px' } });

    expect(seen.shape.borderRadius).toBe('999px');
    expect(seen.shape.borderRadiusSmall).toBe(DEFAULT_THEME.shape.borderRadiusSmall);
    expect(seen.colors.primary).toBe(DEFAULT_THEME.colors.primary);
  });
});
