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

it('says how long a string is when it breaks a length limit, so the agent knows how much to cut', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'helmgear-exec-'))
  const audit = new AuditLog(join(stateDir, 'audit.jsonl'))
  const inputSchema = { type: 'object', properties: { text: { type: 'string', minLength: 3, maxLength: 10 } }, required: ['text'] }
  const connectors: Connector[] = [{ name: 'x', tools: [{ name: 'x.post', description: 'post', inputSchema, tier: 'send', run: async () => ({}) }] }]
  const executor = new Executor({ connectors, audit, stateDir, queue: { enqueue: () => {} } })
  // Code points, as the schema counts them: the emoji is one character, not two.
  expect(await executor.call('x.post', { text: '😀bcdefghijkl' }, CTX, 'k1')).toEqual({
    status: 'refused', reason: 'invalid input: /text must NOT have more than 10 characters (it has 12, 2 over)',
  })
  expect(await executor.call('x.post', { text: 'ab' }, CTX, 'k2')).toEqual({
    status: 'refused', reason: 'invalid input: /text must NOT have fewer than 3 characters (it has 2)',
  })
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

it('rejects a connector or tool name that is not <connector>.<action> in lowercase letters, digits, - and _', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'helmgear-exec-'))
  const audit = new AuditLog(join(stateDir, 'audit.jsonl'))
  const make = (connector: string, tool: string) => new Executor({
    stateDir, audit, queue: { enqueue: () => {} },
    connectors: [{ name: connector, tools: [{ name: tool, description: 'x', inputSchema: { type: 'object' }, tier: 'read', run: async () => 1 }] }],
  })
  for (const [connector, tool] of [['my__conn', 'my__conn.send'], ['a', 'a.b.c'], ['Fake', 'Fake.read'], ['a.b', 'a.b.read']]) {
    expect(() => make(connector!, tool!), tool).toThrow(/name/)
  }
  expect(() => make('my-conn', 'my-conn.do_it')).not.toThrow()
})

it('allows a single tool when the context lists its full name and refuses its siblings', async () => {
  const { executor, calls } = setup()
  const ctx = { ...CTX, connectors: ['fake.read'] }
  expect(await executor.call('fake.read', { q: 'hi' }, ctx, 'k1')).toMatchObject({ status: 'ok' })
  expect(await executor.call('fake.send', { q: 'hi' }, ctx, 'k2')).toMatchObject({ status: 'refused' })
  expect(calls).toHaveLength(1)
})

it('truncates a long tool name in the audit entry to 200 characters', async () => {
  const { executor, audit } = setup()
  await executor.call(`fake.${'x'.repeat(5000)}`, {}, CTX, 'k1')
  const [entry] = audit.read()
  expect(entry!.tool.length).toBeLessThanOrEqual(200)
  expect(entry!.detail!.length).toBeLessThanOrEqual(200)
})
