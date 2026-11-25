import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Helmgear } from '@helmgear/sdk-client'

it.skipIf(!process.env.DEEPSEEK_API_KEY)('answers one prompt on the agent profile with thinking off', async () => {
  await using harness = new Helmgear({
    helmgearHome: mkdtempSync(join(tmpdir(), 'helmgear-live-')),
    model: 'deepseek-flash',
    reasoningEffort: 'off' as never,
  })
  const result = await harness.run('Reply with exactly the word: ready')
  expect(result.finishReason).not.toBe('error')
  expect(result.finalResponse.toLowerCase()).toContain('ready')
}, 60_000)
