/**
 * The shared standalone app shell every docs example runs inside.
 *
 * It wires up the one-time setup a real app does once — a `RevTurbineProvider`
 * bound to the demo `exportedConfig`, a demo user, and the UI-path resolvers that
 * handle placement CTAs — so each example only has to show the part that matters:
 * the component (or hook) being demonstrated.
 *
 * Swap `user` to see how the same slot resolves differently for different plans,
 * usage, and entitlements.
 *
 * NOTE: this file is mounted into the Sandpack sandbox by `CodeExample.tsx` and is
 * only ever `?raw`-imported. Its imports (`@revturbine/sdk`, `./exported_config.json`)
 * resolve inside the sandbox, not in this repo.
 */
import React, { useMemo } from 'react';
import { RevTurbineProvider } from '@revturbine/sdk';
import exportedConfig from './exported_config.json';
import { demoUsers } from './demoUsers';

export type DemoUserKey = keyof typeof demoUsers;

export function DemoApp({
  user = 'user_alice',
  children,
}: {
  /** Which demo user to run as — `user_alice` | `user_bob` | `user_carol` | `user_dan` | `user_eve` | `user_frank`. */
  user?: DemoUserKey;
  children: React.ReactNode;
}) {
  const options = useMemo(
    () => ({
      localRuntime: { exportedConfig },
      user: demoUsers[user].context,
      // Placement CTAs call back into your app's navigation. Here we just log.
      uiPathResolvers: {
        navigate_to_plans: async (ctx) => console.log('[cta] navigate_to_plans', ctx),
        open_checkout_modal: async (ctx) => console.log('[cta] open_checkout_modal', ctx),
        book_demo: async (ctx) => console.log('[cta] book_demo', ctx),
        custom_url: async (ctx) => console.log('[cta] custom_url', ctx),
      },
    }),
    [user],
  );

  return <RevTurbineProvider options={options}>{children}</RevTurbineProvider>;
}
