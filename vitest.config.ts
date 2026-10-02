import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      'dnt-harness': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
  },
  // Root tsconfig.json has no "jsx" setting, so esbuild would default to the
  // classic React.createElement transform; web/ uses the automatic runtime.
  esbuild: { jsx: 'automatic' },
  test: {
    // React-component smoke tests live under web/ (tsconfig.web owns DOM+JSX
    // libs); everything else stays in tests/.
    include: ['tests/**/*.spec.ts', 'web/**/*.spec.ts', 'web/**/*.spec.tsx'],
    environment: 'node',
    // Deterministic effect-teardown tests need real microtask ordering, not fake timers.
    testTimeout: 10_000,
  },
})
