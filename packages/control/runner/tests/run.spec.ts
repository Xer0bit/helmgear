import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Classifier, Judge } from '@helmgear/router'
import { TransportClosedError, type HelmgearOptions } from '@helmgear/sdk-client'
import { afterEach, expect, it } from 'vitest'
import { createRunner, RunnerError, type HarnessLike, type RunnerOptions } from '../src/index.ts'

function templatesDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'helmgear-run-tpl-'))
  const write = (name: string, dataClass: string) => {
    mkdirSync(join(dir, name))
    const front = { name, description: `Does ${name}.`, metadata: { helmgear: { persona: `You do ${name}.`, connectors: ['outbox'], dataClass, reasoningEffort: name === 'social-post' ? 'low' : undefined } } }
    writeFileSync(join(dir, name, 'SKILL.md'), `---\n${JSON.stringify(front)}\n---\nbody\n`)
  }
  write('social-post', 'public')
  write('email-triage', 'sensitive')
  return dir
}

const always = (label: string): Classifier => ({ classify: async ({ options }) => ({ choices: options.map(o => ({ label: o.label, probability: o.label === label ? 0.95 : 0 })), noneFits: 0.05 }) })

interface Grant { tenant: string; sessionId: string; template: string; connectors: string[]; revoked: boolean }
interface Started { options: HelmgearOptions; patch: string; closed: boolean; ran: { request: string; sessionId: string }[] }

type AuditFact = { sessionId: string; tool: string; event: string; actionId: string }
function setup(overrides: Partial<RunnerOptions> & { run?: HarnessLike['run']; pending?: { actionId: string; ctx: { sessionId: string; tenant: string } }[]; audit?: AuditFact[] } = {}) {
  const started: Started[] = []
  const grants: Grant[] = []
  const stateDir = mkdtempSync(join(tmpdir(), 'helmgear-run-state-'))
  const { run, pending, audit, ...rest } = overrides
  const runner = createRunner({
    templatesDir: templatesDir(), stateDir,
    gateway: {
      url: 'http://127.0.0.1:4555/mcp',
      grant: (ctx) => { grants.push({ ...ctx, revoked: false }); return `run-token-${grants.length}` },
      revoke: (token) => { grants[Number(token.split('-')[2]) - 1]!.revoked = true },
      approvals: { list: () => (pending ?? []) as never },
      audit: { read: () => (audit ?? []) as never },
    },
    classifier: always('social-post'),
    model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    harnessFactory(options) {
      const record: Started = { options, patch: readFileSync(options.patches![0]!, 'utf8'), closed: false, ran: [] }
      started.push(record)
      return {
        run: run ?? (async (request, runOptions) => {
          record.ran.push({ request, sessionId: runOptions.sessionId })
          return { sessionId: runOptions.sessionId, finalResponse: 'done it', finishReason: 'completed', events: [], notifications: [] }
        }),
        close: async () => { record.closed = true },
      }
    },
    ...rest,
  })
  return { runner, started, stateDir, grants }
}

const saved = { ...process.env }
afterEach(() => { process.env = { ...saved } })

it('routes, runs the template and returns the response with the session pending actions', async () => {
  const pending = [{ actionId: 'other', ctx: { sessionId: 'someone-else', tenant: 'acme' } }]
  const { runner, started } = setup({ pending })
  const promise = runner.runTask({ tenant: 'acme', request: 'draft a tweet' })
  const result = await promise
  expect(result).toMatchObject({ status: 'done', template: 'social-post', response: 'done it', pendingActionIds: [] })
  expect(started).toHaveLength(1)
  const { options, patch, ran } = started[0]!
  expect(options).toMatchObject({ profile: 'agent', provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'low' })
  expect(ran).toEqual([{ request: 'draft a tweet', sessionId: (result as { sessionId: string }).sessionId }])
  expect(patch).not.toContain('x-helmgear')
})

it('returns the ids of actions this session left pending', async () => {
  const pending: { actionId: string; ctx: { sessionId: string; tenant: string } }[] = []
  const { runner } = setup({
    pending,
    run: async (_request, { sessionId }) => {
      pending.push({ actionId: 'mine', ctx: { sessionId, tenant: 'acme' } }, { actionId: 'theirs', ctx: { sessionId: 'x', tenant: 'acme' } })
      return { sessionId, finalResponse: 'queued', finishReason: 'completed', events: [], notifications: [] }
    },
  })
  expect(await runner.runTask({ tenant: 'acme', request: 'send it' })).toMatchObject({ status: 'done', pendingActionIds: ['mine'] })
})

it('returns no-template and starts no harness when routing returns none', async () => {
  const failing: Classifier = { classify: async () => { throw new Error('jev unreachable') } }
  const { runner, started } = setup({ classifier: failing })
  expect(await runner.runTask({ tenant: 'acme', request: 'anything' })).toEqual({ status: 'no-template', reason: 'classifier-error: jev unreachable' })
  expect(started).toHaveLength(0)
})

it('uses a named template without calling the classifier, and refuses an unknown name', async () => {
  const never: Classifier = { classify: async () => { throw new Error('must not be called') } }
  const { runner, started } = setup({ classifier: never })
  expect(await runner.runTask({ tenant: 'acme', request: 'x', template: 'social-post' })).toMatchObject({ status: 'done', template: 'social-post' })
  expect(await runner.runTask({ tenant: 'acme', request: 'x', template: 'nope' })).toEqual({ status: 'refused', reason: 'unknown template: nope' })
  expect(started).toHaveLength(1)
})

it('refuses a sensitive template on deepseek-official without starting a harness', async () => {
  const { runner, started } = setup({ classifier: always('email-triage') })
  const result = await runner.runTask({ tenant: 'acme', request: 'triage this' })
  expect(result).toMatchObject({ status: 'refused' })
  expect((result as { reason: string }).reason).toContain('sensitive')
  expect(started).toHaveLength(0)
  const elsewhere = setup({ classifier: always('email-triage'), model: { provider: 'eu-host', model: 'deepseek-v4-flash' } })
  expect(await elsewhere.runner.runTask({ tenant: 'acme', request: 'triage this' })).toMatchObject({ status: 'done', template: 'email-triage' })
})

it('uses <stateDir>/tenants/<tenant> as the home, a different folder per tenant', async () => {
  const { runner, started, stateDir } = setup()
  await runner.runTask({ tenant: 'acme', request: 'a' })
  await runner.runTask({ tenant: 'globex', request: 'b' })
  expect(started.map(s => s.options.helmgearHome)).toEqual([join(stateDir, 'tenants', 'acme'), join(stateDir, 'tenants', 'globex')])
})

it('refuses a tenant name that is not a safe folder name', async () => {
  const { runner, started } = setup()
  for (const tenant of ['../acme', 'a/b', '', '.', 'UPPER case']) {
    expect(await runner.runTask({ tenant, request: 'a' }), tenant).toMatchObject({ status: 'refused' })
  }
  expect(started).toHaveLength(0)
})

it('rejects with RunnerError HARNESS_EXITED when the harness process exits mid-run', async () => {
  const { runner, started } = setup({ run: async () => { throw new TransportClosedError('child exited with code 1') } })
  const error = await runner.runTask({ tenant: 'acme', request: 'a' }).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(RunnerError)
  expect((error as RunnerError).code).toBe('HARNESS_EXITED')
  expect(started[0]!.closed).toBe(true)
})

it('always closes the harness, including after an error', async () => {
  const ok = setup()
  await ok.runner.runTask({ tenant: 'acme', request: 'a' })
  expect(ok.started[0]!.closed).toBe(true)
  const broken = setup({ run: async () => { throw new Error('unexpected') } })
  await expect(broken.runner.runTask({ tenant: 'acme', request: 'a' })).rejects.toThrow('unexpected')
  expect(broken.started[0]!.closed).toBe(true)
})

it('returns failed with the reason when the turn ends in an error', async () => {
  const { runner } = setup({
    run: async (_request, { sessionId }) => ({
      sessionId, finalResponse: '', finishReason: 'error', notifications: [],
      events: [{ type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'no API key', code: 'MISSING_CREDENTIAL' } } } }] as never,
    }),
  })
  expect(await runner.runTask({ tenant: 'acme', request: 'a' })).toMatchObject({ status: 'failed', template: 'social-post', reason: 'no API key' })
})

it('passes only the model key to the child environment by default', async () => {
  process.env.DEEPSEEK_API_KEY = 'model-key'
  process.env.FIRECRAWL_API_KEY = 'fc-key'
  process.env.TYPESAFE_API_KEY = 'jev-key'
  const { runner, started } = setup()
  await runner.runTask({ tenant: 'acme', request: 'a' })
  const env = started[0]!.options.env!
  expect(env.DEEPSEEK_API_KEY).toBe('model-key')
  expect(env.HELMGEAR_GATEWAY_TOKEN).toBe('run-token-1')
  expect(env.PATH).toBe(process.env.PATH)
  expect(env.FIRECRAWL_API_KEY).toBeUndefined()
  expect(env.TYPESAFE_API_KEY).toBeUndefined()
  const custom = setup({ env: { ONLY: 'this' } })
  await custom.runner.runTask({ tenant: 'acme', request: 'a' })
  expect(custom.started[0]!.options.env).toEqual({ ONLY: 'this', HELMGEAR_GATEWAY_TOKEN: 'run-token-1' })
})

it('grants the gateway token for exactly this run and revokes it afterwards, also after an error', async () => {
  const ok = setup()
  const result = await ok.runner.runTask({ tenant: 'acme', request: 'a' }) as { sessionId: string }
  expect(ok.grants).toEqual([{ tenant: 'acme', sessionId: result.sessionId, template: 'social-post', connectors: ['outbox'], revoked: true }])
  const broken = setup({ run: async () => { throw new Error('unexpected') } })
  await expect(broken.runner.runTask({ tenant: 'acme', request: 'a' })).rejects.toThrow('unexpected')
  expect(broken.grants.map(g => g.revoked)).toEqual([true])
})

it('rejects with RunnerError HARNESS_TIMEOUT when the run outlasts its deadline, and closes the harness', async () => {
  const { runner, started, grants } = setup({ timeoutMs: 30, run: () => new Promise(() => {}) })
  const error = await runner.runTask({ tenant: 'acme', request: 'a' }).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(RunnerError)
  expect((error as RunnerError).code).toBe('HARNESS_TIMEOUT')
  expect(started[0]!.closed).toBe(true)
  expect(grants[0]!.revoked).toBe(true)
})

/** A judge whose answer to "claims a send" is read from the reply text itself. */
const literalJudge: Judge = {
  judge: async (state, statements) => {
    const reply = (state as { reply: string }).reply
    const answers: Record<string, number> = { claimsSent: /\b(sent|queued)\b/i.test(reply) ? 0.95 : 0.02, claimsDraft: 0.02, claimsDelivered: 0.02 }
    return Object.fromEntries(Object.keys(statements).map(key => [key, answers[key] ?? 0.02]))
  },
}
const reply = (sessionId: string, text: string) => ({ sessionId, finalResponse: text, finishReason: 'completed', events: [], notifications: [] })

it('returns verified true and the session actions for a truthful reply', async () => {
  const audit: AuditFact[] = [{ sessionId: 'someone-else', tool: 'outbox.send', event: 'pending', actionId: 'x' }]
  const { runner, started } = setup({
    audit, judge: literalJudge,
    run: async (_request, { sessionId }) => {
      audit.push({ sessionId, tool: 'firecrawl.search', event: 'executed', actionId: 'a1' }, { sessionId, tool: 'outbox.send', event: 'pending', actionId: 'a2' })
      return reply(sessionId, 'Queued for approval.')
    },
  })
  const result = await runner.runTask({ tenant: 'acme', request: 'send it' })
  expect(result).toMatchObject({
    status: 'done', verified: true, problems: [], response: 'Queued for approval.',
    actions: [{ tool: 'firecrawl.search', event: 'executed', actionId: 'a1' }, { tool: 'outbox.send', event: 'pending', actionId: 'a2' }],
  })
  expect(started).toHaveLength(1)
})

it('runs one repair turn when the reply claims a send that was not made, and returns the repaired reply', async () => {
  const audit: AuditFact[] = []
  const turns: { request: string; sessionId: string }[] = []
  const { runner } = setup({
    audit, judge: literalJudge,
    run: async (request, { sessionId }) => {
      turns.push({ request, sessionId })
      if (turns.length === 1) return reply(sessionId, 'I sent the message.')
      audit.push({ sessionId, tool: 'outbox.send', event: 'pending', actionId: 'a1' })
      return reply(sessionId, 'Now queued for approval.')
    },
  })
  const result = await runner.runTask({ tenant: 'acme', request: 'send it' })
  expect(result).toMatchObject({ status: 'done', verified: true, problems: [], response: 'Now queued for approval.' })
  expect(turns).toHaveLength(2)
  expect(turns[1]!.sessionId).toBe(turns[0]!.sessionId)
  expect(turns[1]!.request).toMatch(/does not match what you did/)
})

it('returns verified false with problems when the repair turn does not fix it, and repairs only once', async () => {
  let turns = 0
  const { runner } = setup({ judge: literalJudge, run: async (_request, { sessionId }) => { turns++; return reply(sessionId, 'I sent the message.') } })
  const result = await runner.runTask({ tenant: 'acme', request: 'send it' }) as { verified: boolean; problems: string[] }
  expect(result.verified).toBe(false)
  expect(result.problems.length).toBeGreaterThan(0)
  expect(turns).toBe(2)
})

it('does not repair when repair is off', async () => {
  let turns = 0
  const { runner } = setup({ judge: literalJudge, repair: false, run: async (_request, { sessionId }) => { turns++; return reply(sessionId, 'I sent the message.') } })
  expect(await runner.runTask({ tenant: 'acme', request: 'send it' })).toMatchObject({ status: 'done', verified: false })
  expect(turns).toBe(1)
})

it('returns verified false and does not repair when no judge is configured', async () => {
  let turns = 0
  const { runner } = setup({ run: async (_request, { sessionId }) => { turns++; return reply(sessionId, 'I sent the message.') } })
  expect(await runner.runTask({ tenant: 'acme', request: 'send it' })).toMatchObject({ status: 'done', verified: false, problems: ['not verified: no judge configured'], actions: [] })
  expect(turns).toBe(1)
})

it('tells the agent not to call a tool again when the action exists and only the wording is wrong', async () => {
  const audit: AuditFact[] = []
  const prompts: string[] = []
  const delivered: Judge = { judge: async (state, statements) => {
    const text = (state as { reply: string }).reply
    return Object.fromEntries(Object.keys(statements).map(key => [key, (key === 'claimsDelivered' && /delivered/.test(text)) || key === 'claimsSent' ? 0.95 : 0.02]))
  } }
  const { runner } = setup({
    audit, judge: delivered,
    run: async (request, { sessionId }) => {
      prompts.push(request)
      if (prompts.length === 1) { audit.push({ sessionId, tool: 'outbox.send', event: 'pending', actionId: 'a1' }); return reply(sessionId, 'Your email was delivered.') }
      return reply(sessionId, 'Your email is queued for approval.')
    },
  })
  expect(await runner.runTask({ tenant: 'acme', request: 'send it' })).toMatchObject({ verified: true, response: 'Your email is queued for approval.' })
  expect(prompts[1]).toMatch(/Do not call any tool/)
  expect(prompts[1]).not.toMatch(/make the tool call now/)
})

it("passes the tenant's rendered memory for the chosen template into the patch", async () => {
  const asked: [string, string | undefined][] = []
  const { runner, started } = setup({ memory: { render: (tenant, template) => { asked.push([tenant, template]); return '- Our product is called Tidewater.' } } })
  await runner.runTask({ tenant: 'acme', request: 'draft a tweet' })
  expect(asked).toEqual([['acme', 'social-post']])
  expect(started[0]!.patch).toContain('Our product is called Tidewater.')
})
