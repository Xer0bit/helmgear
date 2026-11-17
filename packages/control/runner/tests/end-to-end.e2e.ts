import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCore, firecrawlConnector, outboxConnector, startGateway } from '@helmgear/gateway'
import type { Classifier } from '@helmgear/router'
import { expect, it } from 'vitest'
import { createRunner } from '../src/index.ts'

const always = (label: string): Classifier => ({
  classify: async ({ options }) => ({ choices: options.map(o => ({ label: o.label, probability: o.label === label ? 0.95 : 0 })), noneFits: 0.05 }),
})

it.skipIf(!process.env.DEEPSEEK_API_KEY)('a request becomes a pending send, and approving it executes and audits it', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'helmgear-e2e-'))
  const outbox = join(stateDir, 'outbox')
  const connectors = [firecrawlConnector(), outboxConnector({ dir: outbox })]
  const core = createCore({ connectors, stateDir })
  const gateway = await startGateway({ executor: core.executor, connectors })
  try {
    const runner = createRunner({
      templatesDir: fileURLToPath(new URL('../../../../templates', import.meta.url)),
      stateDir,
      gateway: { ...gateway, approvals: core.approvals, audit: core.audit },
      classifier: always('social-post'),
      model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })
    const started = Date.now()
    const result = await runner.runTask({
      tenant: 'acme',
      request: 'Draft a short post announcing our new invoice feature and send it to press@example.com',
    })
    console.log(`runTask took ${Date.now() - started} ms; audit events: ${core.audit.read().map(e => `${e.tool}:${e.event}`).join(', ')}`)
    expect(result).toMatchObject({ status: 'done', template: 'social-post' })
    if (result.status !== 'done') return
    expect(result.pendingActionIds.length).toBeGreaterThanOrEqual(1)
    expect(readdirSync(join(outbox, 'sent'))).toEqual([])

    const actionId = result.pendingActionIds[0]!
    expect(await core.approvals.approve(actionId, 'e2e-approver')).toMatchObject({ status: 'executed' })
    const sent = readdirSync(join(outbox, 'sent'))
    expect(sent).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(outbox, 'sent', sent[0]!), 'utf8')).to).toBe('press@example.com')
    expect(core.audit.read().filter(e => e.actionId === actionId).map(e => e.event)).toEqual(['pending', 'approved', 'executed'])
  } finally {
    await gateway.close()
  }
}, 180_000)
