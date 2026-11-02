/**
 * Type-only probe (ST-1418). Never executed meaningfully — it fails type
 * checking (`check:types:exact`) if a removed `ExportedConfig`-era key
 * reappears on a public option bag.
 */
import type { RevTurbineLocalRuntimeOptions, RevTurbineLocalRuntimeResolvers } from './customer-side';
import type { BrowserRuntimeOptions } from './browser-runtime';
import type { LocalEvaluationServerOptions } from '../server-node/local-server';

type Absent<T, K extends string> = K extends keyof T ? never : true;

export const noLegacyLocalRuntimeKey: Absent<RevTurbineLocalRuntimeOptions, 'exportedConfig'> = true;
export const noLegacyResolverKey: Absent<RevTurbineLocalRuntimeResolvers, 'resolveExportedConfig'> = true;
export const noLegacyServerKey: Absent<LocalEvaluationServerOptions, 'exportedConfig'> = true;
export const noLegacyBrowserKey: Absent<BrowserRuntimeOptions, 'exportedConfig'> = true;
