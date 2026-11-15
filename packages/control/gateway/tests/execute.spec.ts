import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AuditLog, Executor, payloadSha256, type Connector, type PendingRequest } from '../src/index.ts'

const CTX = { tenant: 't1', sessionId: 's1', template: 'social-post' }

function setup(options: { fail?: boolean } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'helmgear-exec-'))
  const audit = new AuditLog(join(stateDir, 'audit.jsonl'))
  const calls: Record<string, unknown>[] = []
  const queued: PendingRequest[] = []
  const schema = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false }
  const tool = (name: string, tier: 'read' | 'draft' | 'send') => ({
    name, description: name, inputSchema: schema, tier,
    async run(input: Record<string, unknown>) {
      calls.push(input)
      if (options.fail) throw new Error('upstream exploded')
      return { echoed: input.q, n: calls.length }
    },
  })
  const connectors: Connector[] = [{ name: 'fake', tools: [tool('fake.read', 'read'), tool('fake.send', 'send')] }]
  const executor = new Executor({ connectors, audit, stateDir, queue: { enqueue: action => { queued.push(action) } } })
  return { executor, audit, calls, queued }
}

it('runs a read tool and audits executed', async () => {
  const { executor, audit } = setup()
  expect(await executor.call('fake.read', { q: 'hi' }, CTX, 'k1')).toEqual({ status: 'ok', result: { echoed: 'hi', n: 1 } })
  expect(audit.read()).toMatchObject([{
    ...CTX, tool: 'fake.read', tier: 'read', event: 'executed', actionId: 'k1', payloadSha256: payloadSha256('fake.read', { q: 'hi' }),
  }])
})

it('returns the first result for a repeated idempotency key without running the tool again', async () => {
  const { executor, calls } = setup()
  const first = await executor.call('fake.read', { q: 'hi' }, CTX, 'k1')
  const second = await executor.call('fake.read', { q: 'hi' }, CTX, 'k1')
  expect(calls).toHaveLength(1)
  expect(second).toEqual(first)
})

it('runs the tool once when the same key arrives twice at the same time', async () => {
  const { executor, calls } = setup()
  const [a, b] = await Promise.all([executor.call('fake.read', { q: 'hi' }, CTX, 'k1'), executor.call('fake.read', { q: 'hi' }, CTX, 'k1')])
  expect(calls).toHaveLength(1)
  expect(b).toEqual(a)
})

it('refuses input that violates the schema and never calls run', async () => {
  const { executor, calls, audit } = setup()
  const result = await executor.call('fake.read', { q: 5 }, CTX, 'k1')
  expect(result).toMatchObject({ status: 'refused' })
  expect(calls).toHaveLength(0)
  expect(audit.read()).toMatchObject([{ event: 'refused', tool: 'fake.read' }])
})

it('refuses an unknown tool', async () => {
  const { executor, audit } = setup()
  expect(await executor.call('fake.nope', {}, CTX, 'k1')).toEqual({ status: 'refused', reason: 'unknown tool: fake.nope' })
  expect(audit.read()).toMatchObject([{ event: 'refused', tool: 'fake.nope' }])
})

it('does not run a send tool; returns pending', async () => {
  const { executor, calls, queued, audit } = setup()
  expect(await executor.call('fake.send', { q: 'go' }, CTX, 'k9')).toEqual({ status: 'pending', actionId: 'k9' })
  expect(calls).toHaveLength(0)
  expect(queued).toEqual([{ actionId: 'k9', tool: 'fake.send', input: { q: 'go' }, payloadSha256: payloadSha256('fake.send', { q: 'go' }), ctx: CTX }])
  expect(audit.read()).toEqual([])
  // A retry of the same call does not queue a second action.
  expect(await executor.call('fake.send', { q: 'go' }, CTX, 'k9')).toEqual({ status: 'pending', actionId: 'k9' })
  expect(queued).toHaveLength(1)
})

it('audits failed with the error message when run throws, and does not cache the failure', async () => {
  const { executor, calls, audit } = setup({ fail: true })
  await expect(executor.call('fake.read', { q: 'hi' }, CTX, 'k1')).rejects.toThrow('upstream exploded')
  await expect(executor.call('fake.read', { q: 'hi' }, CTX, 'k1')).rejects.toThrow('upstream exploded')
  expect(calls).toHaveLength(2)
  expect(audit.read()).toMatchObject([{ event: 'failed', detail: 'upstream exploded' }, { event: 'failed' }])
})

it('rejects an idempotency key that is not a safe file name', async () => {
  const { executor } = setup()
  await expect(executor.call('fake.read', { q: 'hi' }, CTX, '../escape')).rejects.toThrow(/idempotency key/)
})

it('refuses a tool whose connector the template is not allowed to use', async () => {
  const { executor, calls, audit } = setup()
  const result = await executor.call('fake.read', { q: 'hi' }, { ...CTX, connectors: ['other'] }, 'k1')
  expect(result).toEqual({ status: 'refused', reason: 'tool not available to this template: fake.read' })
  expect(calls).toHaveLength(0)
  expect(audit.read()).toMatchObject([{ event: 'refused', tool: 'fake.read' }])
  expect(await executor.call('fake.read', { q: 'hi' }, { ...CTX, connectors: ['fake'] }, 'k2')).toMatchObject({ status: 'ok' })
})
