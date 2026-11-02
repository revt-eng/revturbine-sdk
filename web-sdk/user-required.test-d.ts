/**
 * Type-level fixtures for the required UserContext (ST-1416, SDK 0.13.0).
 *
 * A Playbook can only be evaluated against a UserContext and anonymous users
 * never receive one, so `user` with an `id` is required at EVERY public init
 * entry point. These assert COMPILE-TIME behaviour and are checked by `tsc`
 * (`pnpm check:types:exact`), not vitest. Every `@ts-expect-error` is an
 * assertion in the strict sense: if a line ever stops erroring, `tsc` fails
 * with "Unused '@ts-expect-error' directive" and the guarantee is gone.
 *
 * Entry points covered: the core `initRevTurbine` (also
 * `window.RevTurbine.init`, the snippet entry), the session
 * `initRevTurbine` from `controllers`, `<RevTurbineProvider options>`
 * (through its real props type) and `RevTurbineInitOptions` itself.
 *
 * The type cannot say "non-empty": a blank `id` is refused at runtime and
 * pinned in `user-required.test.ts`.
 */
import { initRevTurbine } from './customer-side';
import type {
  RevTurbineInitInputOptions,
  RevTurbineInitOptions,
  RevTurbineInitUser,
} from './customer-side';
import { initRevTurbine as initRevTurbineSession } from './controllers';
import type { RevTurbineProviderProps } from './react/RevTurbineProvider';
import type { ConfigArtifact } from './config-artifact';

declare function acceptsProviderProps<
  TUser extends RevTurbineInitUser,
  TOptions extends RevTurbineInitInputOptions,
>(props: RevTurbineProviderProps<TUser, TOptions>): void;

const transport = { publicKey: 'rtk_test', endpoint: 'https://edge.example.com', mode: 'react' } as const;

/* ── Accepted: a user with an id ──────────────────────────────────────── */

initRevTurbine({ ...transport, user: { id: 'user_1' } });
initRevTurbine({ ...transport, user: { id: 'user_1', plan_handle: 'pro', email: 'a@example.com' } });
void initRevTurbineSession({ ...transport, user: { id: 'user_1' } });
acceptsProviderProps({ options: { ...transport, user: { id: 'user_1' } }, children: null });

// The option type itself.
const ok: RevTurbineInitOptions = { ...transport, user: { id: 'user_1' } };
void ok;

/* ── Rejected: no user ────────────────────────────────────────────────── */

// @ts-expect-error - `user` is required.
initRevTurbine({ ...transport });
// @ts-expect-error - `user` is required (session entry point).
void initRevTurbineSession({ ...transport });
// @ts-expect-error - `user` is required (React provider options).
acceptsProviderProps({ options: { ...transport }, children: null });
// @ts-expect-error - `user` is required on the option type.
const missingUser: RevTurbineInitOptions = { ...transport };
void missingUser;

/* ── Rejected: a user with no id ──────────────────────────────────────── */

// @ts-expect-error - `user.id` is required.
initRevTurbine({ ...transport, user: {} });
// @ts-expect-error - `user.id` is required, even with other user fields.
initRevTurbine({ ...transport, user: { plan_handle: 'pro' } });
// @ts-expect-error - `user.id` is required (session entry point).
void initRevTurbineSession({ ...transport, user: { plan_handle: 'pro' } });
// @ts-expect-error - `user.id` is required (React provider options).
acceptsProviderProps({ options: { ...transport, user: { plan_handle: 'pro' } }, children: null });
// @ts-expect-error - `user.id` is required on the option type.
const missingId: RevTurbineInitOptions = { ...transport, user: { plan_handle: 'pro' } };
void missingId;

/* ── Rejected: `id` that is not a string ──────────────────────────────── */

// @ts-expect-error - `user.id` is a string.
initRevTurbine({ ...transport, user: { id: 42 } });

/* ── Local-only minimal options still need the user ───────────────────── */

const playbook = {} as ConfigArtifact;
initRevTurbine({ user: { id: 'user_1' }, localRuntime: { playbook } });
// @ts-expect-error - local_only needs a user too: the Playbook is evaluated for someone.
initRevTurbine({ localRuntime: { playbook } });
