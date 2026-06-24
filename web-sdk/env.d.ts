/**
 * Vite import-meta-env type augmentation for the SDK.
 *
 * The generated SDK (generated.ts) references `import.meta.env.VITE_*`
 * variables which are injected by Vite at build time. This declaration
 * ensures TypeScript understands `import.meta.env` even when the SDK
 * is consumed outside a Vite context (e.g. Next.js, Node, tests).
 */
interface ImportMetaEnv {
  readonly VITE_WEBSDK_MODE?: string;
  readonly VITE_BFF_BASE_URL?: string;
  [key: string]: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
