/**
 * Type-only probe fixture for the `exportedConfig` deprecation-surfacing test
 * (BL-0172). Never executed — `playbook-deprecation-arms.test.ts` compiles
 * this file with the real TypeScript checker and inspects the resolved
 * `.localRuntime.exportedConfig` (or `.exportedConfig`) property on each
 * function's parameter type. Declaring a real property access on each
 * composed bag, rather than re-deriving the unions by hand, is what lets the
 * test ask the checker what it actually believes about the tag instead of
 * assuming it.
 *
 * Covers every SDK-side bag that carries the `playbook` / deprecated
 * `exportedConfig` alias through a *union* (so the tag must be repeated on
 * every arm, not just documented once): the `localRuntime` shape required by
 * {@link RevTurbineInitOptionsStrict}'s local-only-with-a-Playbook arm, and
 * the matching overload parameters of `createLocalRuntimeConfig` and
 * `createStrictLocalRuntimeConfig` (all in `customer-side.ts`).
 *
 * {@link BrowserRuntimeOptions} and {@link LocalEvaluationServerOptions} are
 * included too, even though both already carried the tag on every arm
 * before this change — kept here as a regression guard so a future edit
 * can't silently drop it from either.
 */
import type {
  RevTurbineInitOptionsStrict,
  RevTurbineUiPathResolverMap,
} from './customer-side';
import type { BrowserRuntimeOptions } from './browser-runtime';
import type { LocalEvaluationServerOptions } from '../server-node/local-server';

/**
 * The one `RevTurbineInitOptionsStrict` member whose `uiPathResolvers` is
 * required — that's the local-only-with-a-Playbook arm, the only one whose
 * `localRuntime` carries the `playbook` / `exportedConfig` union.
 */
type LocalOnlyWithPlaybookInit = Extract<
  RevTurbineInitOptionsStrict,
  { uiPathResolvers: RevTurbineUiPathResolverMap }
>;

export declare function useInitOptionsStrictLocalRuntime(
  localRuntime: LocalOnlyWithPlaybookInit['localRuntime'],
): void;
export declare function useBrowserRuntimeOptions(options: BrowserRuntimeOptions): void;
export declare function useLocalEvaluationServerOptions(options: LocalEvaluationServerOptions): void;
