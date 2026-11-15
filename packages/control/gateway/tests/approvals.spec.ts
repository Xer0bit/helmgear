import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ApprovalQueue, AuditLog, createCore, payloadSha256, type PendingAction, type PendingRequest } from '../src/index.ts'

const CTX = { tenant: 't1', sessionId: 's1', template: 'social-post' }
const INPUT = { to: 'press@example.com', body: 'hello' }
const ACTION: PendingRequest = { actionId: 'a1', tool: 'fake.send', input: INPUT, payloadSha256: payloadSha256('fake.send', INPUT), ctx: CTX }

function setup(run?: (action: PendingAction) => Promise<unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'helmgear-appr-'))
  const audit = new AuditLog(join(dir, 'audit.jsonl'))
  const ran: PendingAction[] = []
  const options = { dir: join(dir, 'pending'), audit, run: run ?? (async (action: PendingAction) => { ran.push(action); return { id: 'sent-1' } }) }
  return { dir: options.dir, audit, ran, options, queue: new ApprovalQueue(options) }
}

it('enqueue then list returns the action with its exact input', () => {
  const { queue } = setup()
  queue.enqueue(ACTION)
  queue.enqueue({ ...ACTION, actionId: 'a2', ctx: { ...CTX, tenant: 't2' } })
  expect(queue.list()).toHaveLength(2)
  const mine = queue.list('t1')
  expect(mine).toHaveLength(1)
  expect(mine[0]).toMatchObject(ACTION)
  expect(mine[0]!.createdAt).toMatch(/Z$/)
})

it('approve runs the stored payload once and audits approved then executed', async () => {
  const { queue, ran, audit } = setup()
  queue.enqueue(ACTION)
  expect(await queue.approve('a1', 'sam')).toEqual({ status: 'executed', result: { id: 'sent-1' } })
  expect(ran).toHaveLength(1)
  expect(ran[0]!.input).toEqual(INPUT)
  expect(audit.read()).toMatchObject([
    { event: 'pending', actionId: 'a1', tier: 'send', tool: 'fake.send', payloadSha256: ACTION.payloadSha256, ...CTX },
    { event: 'approved', actionId: 'a1', approver: 'sam', tier: 'send', tool: 'fake.send', ...CTX },
    { event: 'executed', actionId: 'a1', approver: 'sam' },
  ])
  expect(queue.list()).toEqual([])
})

it("approve refuses when the stored file's input no longer matches its recorded hash", async () => {
  const { queue, ran, audit, dir } = setup()
  queue.enqueue(ACTION)
  const file = join(dir, 'a1.json')
  const stored = JSON.parse(readFileSync(file, 'utf8'))
  stored.input.to = 'attacker@example.com'
  writeFileSync(file, JSON.stringify(stored))
  expect(await queue.approve('a1', 'sam')).toMatchObject({ status: 'refused' })
  expect(ran).toHaveLength(0)
  expect(audit.read().slice(1)).toMatchObject([{ event: 'refused', actionId: 'a1', approver: 'sam' }])
  // The refused action is still there to inspect or reject, not stranded.
  expect(queue.list().map(a => a.actionId)).toEqual(['a1'])
})

it('approve refuses a stored file whose input and hash were both rewritten, using the audited hash', async () => {
  const { queue, ran, dir } = setup()
  queue.enqueue(ACTION)
  const altered = { to: 'attacker@example.com', body: 'hello' }
  const file = join(dir, 'a1.json')
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), input: altered, payloadSha256: payloadSha256('fake.send', altered) }))
  expect(await queue.approve('a1', 'sam')).toMatchObject({ status: 'refused' })
  expect(ran).toHaveLength(0)
})

it('a second approve of the same action is refused', async () => {
  const { queue, ran } = setup()
  queue.enqueue(ACTION)
  const [a, b] = await Promise.all([queue.approve('a1', 'sam'), queue.approve('a1', 'sam')])
  expect([a.status, b.status].sort()).toEqual(['executed', 'refused'])
  expect(await queue.approve('a1', 'sam')).toMatchObject({ status: 'refused' })
  expect(ran).toHaveLength(1)
})

it('keeps the action approvable and audits failed when the run throws', async () => {
  let attempts = 0
  const { queue, audit } = setup(async () => { if (++attempts === 1) throw new Error('smtp down'); return 'ok' })
  queue.enqueue(ACTION)
  await expect(queue.approve('a1', 'sam')).rejects.toThrow('smtp down')
  expect(audit.read().map(e => e.event)).toEqual(['pending', 'approved', 'failed'])
  expect(queue.list()).toHaveLength(1)
  expect(await queue.approve('a1', 'sam')).toEqual({ status: 'executed', result: 'ok' })
})

it('reject removes the action and audits rejected with the approver', () => {
  const { queue, audit, ran } = setup()
  queue.enqueue(ACTION)
  queue.reject('a1', 'sam', 'wrong recipient')
  expect(queue.list()).toEqual([])
  expect(audit.read().slice(1)).toMatchObject([{ event: 'rejected', actionId: 'a1', approver: 'sam', detail: 'wrong recipient' }])
  expect(ran).toHaveLength(0)
  expect(() => queue.reject('a1', 'sam')).toThrow(/a1/)
})

it('pending actions survive constructing a new ApprovalQueue on the same dir', async () => {
  const { queue, options, ran } = setup()
  queue.enqueue(ACTION)
  const reopened = new ApprovalQueue(options)
  expect(reopened.list()).toMatchObject([ACTION])
  expect(await reopened.approve('a1', 'sam')).toMatchObject({ status: 'executed' })
  expect(ran).toHaveLength(1)
})

it('refuses an action id that is not a safe file name', async () => {
  const { queue } = setup()
  expect(await queue.approve('../audit', 'sam')).toMatchObject({ status: 'refused' })
  expect(() => queue.enqueue({ ...ACTION, actionId: '../x' })).toThrow(/action id/)
})

it('createCore wires a send tool through the queue: pending, then approve runs it', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'helmgear-core-'))
  const sent: unknown[] = []
  const core = createCore({
    stateDir,
    connectors: [{ name: 'fake', tools: [{
      name: 'fake.send', description: 'send', tier: 'send', inputSchema: { type: 'object' },
      async run(input) { sent.push(input); return { id: 'x' } },
    }] }],
  })
  expect(await core.executor.call('fake.send', INPUT, CTX, 'k1')).toEqual({ status: 'pending', actionId: 'k1' })
  expect(sent).toHaveLength(0)
  expect(core.approvals.list('t1').map(a => a.actionId)).toEqual(['k1'])
  expect(await core.approvals.approve('k1', 'sam')).toEqual({ status: 'executed', result: { id: 'x' } })
  expect(sent).toEqual([INPUT])
  expect(core.audit.read().map(e => e.event)).toEqual(['pending', 'approved', 'executed'])
  expect(readdirSync(stateDir).sort()).toEqual(['audit.jsonl', 'pending', 'results'])
})

it('refuses a pending file that was never requested through the queue', async () => {
  const { queue, ran, dir } = setup()
  writeFileSync(join(dir, 'planted.json'), JSON.stringify({ ...ACTION, actionId: 'planted', createdAt: new Date().toISOString() }))
  expect(await queue.approve('planted', 'sam')).toMatchObject({ status: 'refused' })
  expect(ran).toHaveLength(0)
})

it('refuses when the stored tenant, session or template was altered', async () => {
  for (const field of ['tenant', 'sessionId', 'template'] as const) {
    const { queue, ran, dir } = setup()
    queue.enqueue(ACTION)
    const file = join(dir, 'a1.json')
    const stored = JSON.parse(readFileSync(file, 'utf8'))
    stored.ctx[field] = 'globex'
    writeFileSync(file, JSON.stringify(stored))
    expect(await queue.approve('a1', 'sam'), field).toMatchObject({ status: 'refused' })
    expect(ran, field).toHaveLength(0)
  }
})

it('still approves after a torn line in the audit log', async () => {
  const { queue, ran, dir } = setup()
  queue.enqueue(ACTION)
  appendFileSync(join(dir, '..', 'audit.jsonl'), '{"at":"2026-01-01T00:00:00.000Z","ten')
  expect(await queue.approve('a1', 'sam')).toMatchObject({ status: 'executed' })
  expect(ran).toHaveLength(1)
})

it('an unreadable pending file is refused, not stranded, and does not break list', async () => {
  const { queue, dir } = setup()
  queue.enqueue(ACTION)
  queue.enqueue({ ...ACTION, actionId: 'a2' })
  writeFileSync(join(dir, 'a1.json'), '{ not json')
  expect(queue.list().map(a => a.actionId)).toEqual(['a2'])
  expect(await queue.approve('a1', 'sam')).toMatchObject({ status: 'refused' })
  expect(existsSync(join(dir, 'a1.json'))).toBe(true)
  expect(existsSync(join(dir, 'a1.json.running'))).toBe(false)
})
