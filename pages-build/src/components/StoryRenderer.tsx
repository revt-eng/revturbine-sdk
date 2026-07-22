import React, { useState, useMemo } from 'react';
import {
  RevTurbineThemeProvider,
  DEFAULT_THEME,
  mergeTheme,
  type RevTurbineTheme,
  type RevTurbineThemeColors,
} from '@revturbine/sdk';

/* ── Theme presets (matching Storybook config) ─────────────────────── */

const darkOverrides: Partial<RevTurbineThemeColors> = {
  primary: '#6366f1',
  primaryText: '#ffffff',
  background: '#0f172a',
  surface: '#1e293b',
  surfaceBorder: '#334155',
  text: '#f1f5f9',
  textSecondary: '#94a3b8',
  textMuted: '#64748b',
  toastBackground: '#1e293b',
  toastText: '#f1f5f9',
};

const warmOverrides: Partial<RevTurbineThemeColors> = {
  primary: '#c2410c',
  primaryText: '#ffffff',
  accent: '#b45309',
  accentText: '#ffffff',
  secondary: '#fef3c7',
  secondaryText: '#78350f',
  info: '#f59e0b',
};

const THEMES: Record<string, RevTurbineTheme> = {
  default: DEFAULT_THEME,
  dark: mergeTheme({ colors: darkOverrides }),
  warm: mergeTheme({ colors: warmOverrides }),
};

/* ── Types ─────────────────────────────────────────────────────────── */

interface StoryVariant {
  name?: string;
  args?: Record<string, unknown>;
}

interface StoryMeta {
  component: React.ComponentType<Record<string, unknown>>;
  args?: Record<string, unknown>;
}

export interface StoryRendererCoreProps {
  meta: StoryMeta;
  stories: Record<string, StoryVariant>;
}

/* ── CSS ───────────────────────────────────────────────────────────── */

const storyCSS = `
.rt-story-gallery {
  --rt-border: #e2e8f0;
  --rt-surface: #f8fafc;
  --rt-text: #1e293b;
  --rt-text-muted: #64748b;
  border: 1px solid var(--rt-border);
  border-radius: 10px;
  overflow: hidden;
  font-family: ui-sans-serif, system-ui, sans-serif;
  margin: 1.5rem 0;
}
.rt-story-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  background: var(--rt-surface);
  border-bottom: 1px solid var(--rt-border);
  flex-wrap: wrap;
}
.rt-story-toolbar label {
  font-size: 12px;
  font-weight: 500;
  color: var(--rt-text-muted);
}
.rt-story-select {
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid var(--rt-border);
  background: #ffffff;
  color: var(--rt-text);
  font-size: 12px;
  cursor: pointer;
}
.rt-story-select:focus {
  outline: 2px solid #6366f1;
  outline-offset: 1px;
}
.rt-story-viewport {
  padding: 32px;
  min-height: 200px;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}
.rt-story-viewport[data-bg="light"] {
  background: #ffffff;
}
.rt-story-viewport[data-bg="dark"] {
  background: #0f172a;
}
`;

/* ── Core renderer (used by per-slot wrappers) ─────────────────────── */

export function StoryRendererCore({ meta, stories }: StoryRendererCoreProps) {
  const storyKeys = Object.keys(stories);
  const [activeKey, setActiveKey] = useState(storyKeys[0] ?? '');
  const [themeKey, setThemeKey] = useState('default');

  const theme = THEMES[themeKey] ?? DEFAULT_THEME;
  const activeStory = stories[activeKey];
  const Component = meta.component;

  const mergedArgs = useMemo(
    () => ({
      ...meta.args,
      ...activeStory?.args,
      content: {
        ...(meta.args?.content as Record<string, unknown> | undefined),
        ...(activeStory?.args?.content as Record<string, unknown> | undefined),
      },
      onCtaClick: () => console.log('[story] CTA click'),
      onSecondaryCtaClick: () => console.log('[story] secondary CTA click'),
      onDismiss: () => console.log('[story] dismiss'),
    }),
    [meta.args, activeStory?.args],
  );

  const bgMode = themeKey === 'dark' ? 'dark' : 'light';

  return (
    <div className="rt-story-gallery">
      <style dangerouslySetInnerHTML={{ __html: storyCSS }} />
      <div className="rt-story-toolbar">
        <label htmlFor="rt-story-variant">Variant:</label>
        <select
          id="rt-story-variant"
          className="rt-story-select"
          value={activeKey}
          onChange={(e) => setActiveKey(e.target.value)}
        >
          {storyKeys.map((key) => (
            <option key={key} value={key}>
              {stories[key].name ?? key.replace(/([A-Z])/g, ' $1').trim()}
            </option>
          ))}
        </select>

        <label htmlFor="rt-story-theme">Theme:</label>
        <select
          id="rt-story-theme"
          className="rt-story-select"
          value={themeKey}
          onChange={(e) => setThemeKey(e.target.value)}
        >
          <option value="default">Default</option>
          <option value="dark">Dark</option>
          <option value="warm">Warm Brand</option>
        </select>
      </div>
      <div className="rt-story-viewport" data-bg={bgMode}>
        <RevTurbineThemeProvider theme={theme}>
          <Component {...mergedArgs} />
        </RevTurbineThemeProvider>
      </div>
    </div>
  );
}
