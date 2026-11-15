import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'

// Unit tests for the agent runtime. Workspace imports resolve to package
// sources through tsconfig.base.json, so no build is needed first.
export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] }), standardDecoratorPlugin()],
  test: {
    // Forked workers: several suites own process-wide state (cwd, signals, env).
    pool: 'forks',
    execArgv: vitestExecArgv,
    setupFiles: ['./test-setup.ts'],
    include: ['packages/*/*/tests/**/*.spec.{ts,tsx}', 'apps/*/tests/**/*.spec.{ts,tsx}'],
  },
})
