// Lead outreach: research each company from its public website, draft a first
// email, and queue the send for a person to approve.
//
//   pnpm outreach run examples/lead-outreach/leads.sample.json
//   pnpm outreach list
//   pnpm outreach approve <id | all>
//   pnpm outreach reject <id> [reason]
//
// "Send" here writes a file under tmp/outreach/outbox/sent; no email leaves the machine.
import { readFileSync } from 'node:fs'
import { createCore, firecrawlConnector, outboxConnector, startGateway } from '@helmgear/gateway'
import { createRunner } from '@helmgear/runner'

interface Lead { company: string; website: string; email: string }
interface LeadFile { offer: string; sender: string; leads: Lead[] }

const TENANT = 'outreach'
const stateDir = 'tmp/outreach'
const connectors = [firecrawlConnector(), outboxConnector({ dir: `${stateDir}/outbox` })]
const core = createCore({ connectors, stateDir })
const [command, ...rest] = process.argv.slice(2)

function show(): void {
  const waiting = core.approvals.list(TENANT)
  if (waiting.length === 0) { console.log('Nothing is waiting for approval.'); return }
  for (const action of waiting) {
    const { to, subject, body } = action.input as { to: string; subject: string; body: string }
    console.log(`\n── ${action.actionId.slice(0, 12)} ── to ${to}\nSubject: ${subject}\n\n${body}`)
  }
  console.log(`\n${waiting.length} waiting. Approve with: pnpm outreach approve <id | all>`)
}

/** Match a full id or the 12-character prefix `list` prints. */
function resolve(prefix: string): string[] {
  const ids = core.approvals.list(TENANT).map(a => a.actionId)
  const matches = prefix === 'all' ? ids : ids.filter(id => id.startsWith(prefix))
  if (matches.length === 0 || (prefix !== 'all' && matches.length > 1)) throw new Error(`"${prefix}" matches ${matches.length} waiting actions`)
  return matches
}

if (command === 'run') {
  const file = JSON.parse(readFileSync(rest[0] ?? 'examples/lead-outreach/leads.sample.json', 'utf8')) as LeadFile
  const gateway = await startGateway({ executor: core.executor, connectors })
  const runner = createRunner({
    templatesDir: 'templates', stateDir,
    gateway: { ...gateway, approvals: core.approvals },
    // The template is named outright, so nothing is routed and no classifier is called.
    classifier: { classify: async () => { throw new Error('routing is not used here') } },
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  })
  const started = Date.now()
  try {
    // Leads run side by side: each is its own agent process and its own gateway token.
    const results = await Promise.all(file.leads.map(async (lead) => {
      const t = Date.now()
      const request = `Research ${lead.company} (${lead.website}). We offer: ${file.offer}. `
        + `Write a first-touch email from ${file.sender} and send it to ${lead.email}.`
      const result = await runner.runTask({ tenant: TENANT, template: 'outreach-research', request })
        .catch((error: Error) => ({ status: 'error' as const, reason: error.message }))
      return { lead, result, seconds: (Date.now() - t) / 1000 }
    }))
    for (const { lead, result, seconds } of results) {
      console.log(`\n════ ${lead.company} · ${result.status} · ${seconds.toFixed(1)} s ════`)
      console.log('response' in result ? result.response : `reason: ${result.reason}`)
    }
    console.log(`\n${results.length} leads in ${((Date.now() - started) / 1000).toFixed(1)} s. ${core.approvals.list(TENANT).length} emails waiting: pnpm outreach list`)
  } finally {
    await gateway.close()
  }
} else if (command === 'list') {
  show()
} else if (command === 'approve' && rest[0]) {
  for (const id of resolve(rest[0])) console.log(id.slice(0, 12), JSON.stringify(await core.approvals.approve(id, process.env.USER ?? 'operator')))
} else if (command === 'reject' && rest[0]) {
  for (const id of resolve(rest[0])) { core.approvals.reject(id, process.env.USER ?? 'operator', rest.slice(1).join(' ') || undefined); console.log(id.slice(0, 12), 'rejected') }
} else {
  console.error('usage: pnpm outreach run [leads.json] | list | approve <id|all> | reject <id> [reason]')
  process.exit(2)
}
