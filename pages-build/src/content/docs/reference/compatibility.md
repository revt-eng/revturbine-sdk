---
title: Compatibility Matrix
description: SDK version compatibility, supported browsers, runtimes, and feature support by mode.
---

## SDK Versions

| SDK Version | Schema Version | API Version | Status |
|---|---|---|---|
| `0.1.x` | `0.1.x` | `v1` | Current |

## Browser Support

| Browser | Minimum Version | Notes |
|---|---|---|
| Chrome | 90+ | Full support |
| Firefox | 90+ | Full support |
| Safari | 15+ | Full support |
| Edge | 90+ | Full support (Chromium-based) |
| iOS Safari | 15+ | Full support |
| Chrome Android | 90+ | Full support |

### Required APIs

The SDK requires these browser APIs:

| API | Used For | Fallback |
|---|---|---|
| `fetch` | API calls | Required — no fallback |
| `localStorage` | Decision cache, interaction state | In-memory fallback |
| `sessionStorage` | Session state | In-memory fallback |
| `JSON.parse/stringify` | Data serialization | Required — no fallback |
| `Promise` | Async operations | Required — no fallback |

## React Requirements

| Dependency | Minimum Version | Recommended |
|---|---|---|
| React | 18.0 | 19.x |
| React DOM | 18.0 | 19.x |

The SDK uses React hooks (`useState`, `useEffect`, `useContext`, `useRef`). React 17 and below are not supported.

## Node.js Requirements

| Package | Runtime | Minimum Version |
|---|---|---|
| `@revturbine/sdk` (web) | Browser | — |
| `@revt-eng/server-node` | Node.js | 20.0 |

## Build Tool Compatibility

| Tool | Support | Notes |
|---|---|---|
| Vite | ✅ | Recommended |
| Next.js | ✅ | App Router and Pages Router |
| webpack | ✅ | Version 5+ |
| Parcel | ✅ | Version 2+ |
| esbuild | ✅ | Used internally for bundling |

## Feature Support by Mode

| Feature | `react` | `snippet` | `iframe` |
|---|---|---|---|
| `RevTurbineProvider` | ✅ | — | — |
| React hooks | ✅ | — | — |
| Drop-in slot components | ✅ | — | — |
| Headless controllers | ✅ | ✅ | — |
| Custom slot types | ✅ | — | — |
| Theming | ✅ | ✅ | ✅ |
| Event tracking | ✅ | ✅ | ✅ |
| localStorage persistence | ✅ | ✅ | ✅ |

## Feature Support by Runtime Mode

| Feature | `revturbine_server` | `local_only` | `custom_endpoints` |
|---|---|---|---|
| Placement resolution | ✅ Server | ✅ Client | ✅ Custom server |
| Entitlement checks | ✅ Server | ✅ Client | ✅ Custom server |
| Usage tracking | ✅ Server | ✅ Client-only | ✅ Custom server |
| Event delivery | ✅ Server | ❌ Local storage only | ✅ Custom server |
| Config updates | ✅ Real-time | ❌ Snapshot only | ✅ Custom schedule |
| Decision caching | ✅ | ✅ | ✅ |
| Cap enforcement | ✅ Client | ✅ Client | ✅ Client |

## TypeScript

| TypeScript Version | Support |
|---|---|
| 5.0+ | ✅ Full support |
| 4.9 | ⚠️ May work, not tested |
| 4.8 and below | ❌ Not supported |

The SDK ships with `.d.ts` type declarations. All public APIs are fully typed.

## Bundle Size

| Package | Size (minified + gzip) |
|---|---|
| `@revturbine/sdk` (full) | ~45 KB |
| `@revturbine/sdk` (headless only) | ~15 KB |
| `@revt-eng/server-node` | ~8 KB |

Tree-shakeable — unused slot components are excluded from the bundle.

## Related

- [Installation](/getting-started/installation/) — installation instructions
- [Configuration Reference](/reference/configuration/) — full options specification
