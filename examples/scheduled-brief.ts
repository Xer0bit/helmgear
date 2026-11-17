// A recurring task: a fresh competitor brief every 60 minutes.
//
//   TSX_TSCONFIG_PATH=tsconfig.base.json node --env-file=.env --import tsx examples/scheduled-brief.ts https://plausible.io
//
// The application owns the timer: this script ticks the scheduler every 30
// seconds, and the scheduler runs each job at most once per slot. Stop it with Ctrl-C.
import { createCore, firecrawlConnector, startGateway } from '@helmgear/gateway'
import { createRunner } from '@helmgear/runner'
import { Scheduler } from '@helmgear/scheduler'

const site = process.argv[2] ?? 'https://plausible.io'
const stateDir = 'tmp/scheduled'
const connectors = [firecrawlConnector()]
const core = createCore({ connectors, stateDir })
const gateway = await startGateway({ executor: core.executor, connectors })
const runner = createRunner({
  templatesDir: 'templates', stateDir,
  gateway: { ...gateway, approvals: core.approvals, audit: core.audit },
  classifier: { classify: async () => { throw new Error('the job names its template') } },
  model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
})

const scheduler = new Scheduler({
  file: `${stateDir}/jobs.json`,
  onError: (job, error) => console.error(`job ${job.id} failed: ${error.message}`),
  run: async (job) => {
    const result = await runner.runTask(job)
    console.log(`\n[${new Date().toISOString()}] ${result.status}\n${'response' in result ? result.response : result.reason}`)
  },
})
if (scheduler.list().length === 0) scheduler.add({ tenant: 'demo', template: 'competitor-brief', request: `Write a competitor brief on ${site}.`, when: { everyMinutes: 60 } })
console.log(`Scheduled ${scheduler.list().length} job(s). First run starts now; then once per hour.`)
await scheduler.tick()
setInterval(() => { void scheduler.tick() }, 30_000)
