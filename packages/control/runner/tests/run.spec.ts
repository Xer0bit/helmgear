import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Classifier } from '@helmgear/router'
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

interface Started { options: HelmgearOptions; patch: string; closed: boolean; ran: { request: string; sessionId: string }[] }

function setup(overrides: Partial<RunnerOptions> & { run?: HarnessLike['run']; pending?: { actionId: string; ctx: { sessionId: string; tenant: string } }[] } = {}) {
  const started: Started[] = []
  const stateDir = mkdtempSync(join(tmpdir(), 'helmgear-run-state-'))
  const { run, pending, ...rest } = overrides
  const runner = createRunner({
    templatesDir: templatesDir(), stateDir,
    gateway: { url: 'http://127.0.0.1:4555/mcp', token: 'gw-token', approvals: { list: () => (pending ?? []) as never } },
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
  return { runner, started, stateDir }
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
  expect(patch).toContain(`x-helmgear-session: "${ran[0]!.sessionId}"`)
  expect(patch).toContain('x-helmgear-tenant: "acme"')
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
  expect(env.HELMGEAR_GATEWAY_TOKEN).toBe('gw-token')
  expect(env.PATH).toBe(process.env.PATH)
  expect(env.FIRECRAWL_API_KEY).toBeUndefined()
  expect(env.TYPESAFE_API_KEY).toBeUndefined()
  const custom = setup({ env: { ONLY: 'this' } })
  await custom.runner.runTask({ tenant: 'acme', request: 'a' })
  expect(custom.started[0]!.options.env).toEqual({ ONLY: 'this', HELMGEAR_GATEWAY_TOKEN: 'gw-token' })
})
