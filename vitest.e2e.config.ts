import { existsSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import base from './vitest.config.ts'

// Live tests: they call real services and self-skip when a key is missing.
// Keys come from the git-ignored .env file, never from the repository.
if (existsSync('.env')) process.loadEnvFile('.env')

export default defineConfig({
  ...base,
  test: { ...base.test, include: ['apps/cli/tests/agent-live.e2e.ts', 'packages/control/*/tests/**/*.e2e.ts'] },
})
