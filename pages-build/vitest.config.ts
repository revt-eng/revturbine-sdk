import { defineConfig } from 'vitest/config';

// pages-build's own unit tests (BL-0401). Scoped to tests/ so vitest never
// wanders into src/content or the Astro build output.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
