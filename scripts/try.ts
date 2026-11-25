// Run one request through the whole stack and print what happened.
//   pnpm try "Draft a post about our new invoice feature and send it to press@example.com"
//   pnpm try --approve "..."        also approve whatever the agent queued
//   pnpm try --template social-post "..."   skip routing
import { createCore, firecrawlConnector, memoryConnector, MemoryStore, outboxConnector, startGateway } from '@helmgear/gateway'
import { jevClassifier } from '@helmgear/router'
import { createRunner } from '@helmgear/runner'

const args = process.argv.slice(2)
const approve = args.includes('--approve')
const at = args.indexOf('--template')
const template = at >= 0 ? args[at + 1] : undefined
const request = args.filter((arg, i) => !arg.startsWith('--') && (at < 0 || i !== at + 1)).join(' ')
if (!request) { console.error('usage: pnpm try [--approve] [--template <name>] "<request>"'); process.exit(2) }

const stateDir = 'tmp/state'
const memory = new MemoryStore(`${stateDir}/memory`)
const connectors = [firecrawlConnector(), outboxConnector({ dir: `${stateDir}/outbox` }), memoryConnector({ store: memory })]
const core = createCore({ connectors, stateDir })
const gateway = await startGateway({ executor: core.executor, connectors })
try {
  const runner = createRunner({
    templatesDir: 'templates', stateDir,
    gateway: { ...gateway, approvals: core.approvals, audit: core.audit },
    classifier: jevClassifier({ apiKey: process.env.TYPESAFE_API_KEY ?? '' }),
    model: { provider: 'deepseek-official', model: 'deepseek-flash' },
    memory,
  })
  const started = Date.now()
  const result = await runner.runTask({ tenant: 'demo', request, ...(template ? { template } : {}) })
  console.log(`\n[${result.status}] in ${((Date.now() - started) / 1000).toFixed(1)} s`, 'template' in result ? `· template: ${result.template}` : '')
  console.log('response' in result ? `\n${result.response}\n` : 'reason' in result ? `reason: ${result.reason}\n` : `\n${result.plan}\n`)
  for (const action of core.approvals.list('demo')) {
    console.log(`waiting for approval: ${action.tool} ${JSON.stringify(action.input)}`)
    if (approve) console.log('  approved ->', JSON.stringify(await core.approvals.approve(action.actionId, 'you')))
  }
  console.log(`\naudit log: ${stateDir}/audit.jsonl · outbox: ${stateDir}/outbox/`)
} finally {
  await gateway.close()
}
