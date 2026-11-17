import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createCore, memoryConnector, MemoryStore } from '../src/index.ts'

const store = (): MemoryStore => new MemoryStore(join(mkdtempSync(join(tmpdir(), 'helmgear-mem-')), 'memory'))
const fact = (text: string, template?: string) => ({ kind: 'fact' as const, text, source: 'person' as const, ...(template ? { template } : {}) })
const CTX = { tenant: 'acme', sessionId: 's1', template: 'social-post' }

it('add then list returns the entry with id and UTC time', () => {
  const memory = store()
  const added = memory.add('acme', fact('Our product is called Tidewater.'))
  expect(added.id).toMatch(/^[A-Za-z0-9_-]{8,}$/)
  expect(added.at).toMatch(/Z$/)
  expect(memory.list('acme')).toEqual([added])
  expect(memory.list('globex')).toEqual([])
})

it("list for a template returns shared entries and that template's, not another template's", () => {
  const memory = store()
  memory.add('acme', fact('shared fact here'))
  memory.add('acme', fact('for social posts', 'social-post'))
  memory.add('acme', fact('for outreach only', 'outreach-research'))
  expect(memory.list('acme', 'social-post').map(e => e.text)).toEqual(['shared fact here', 'for social posts'])
  expect(memory.list('acme').map(e => e.text)).toHaveLength(3)
})

it('render returns the newest entries that fit the cap, oldest first', () => {
  const memory = store()
  for (let i = 0; i < 50; i++) memory.add('acme', fact(`entry ${String(i).padStart(2, '0')} ${'x'.repeat(90)}`))
  const text = memory.render('acme')
  expect(text.length).toBeLessThanOrEqual(2000)
  expect(text).not.toContain('entry 00')
  expect(text).toContain('entry 49')
  expect(text.indexOf('entry 48')).toBeLessThan(text.indexOf('entry 49'))
  expect(memory.render('acme', undefined, 150)).toMatch(/^- entry 49/)
  expect(memory.render('nobody')).toBe('')
})

it('remove deletes one entry and leaves the rest', () => {
  const memory = store()
  const a = memory.add('acme', fact('first fact to keep'))
  const b = memory.add('acme', fact('second fact to drop'))
  memory.remove('acme', b.id)
  expect(memory.list('acme')).toEqual([a])
})

it('rejects text over 300 characters or empty, and flattens newlines', () => {
  const memory = store()
  expect(() => memory.add('acme', fact('x'.repeat(301)))).toThrow(/300/)
  expect(() => memory.add('acme', fact('   '))).toThrow()
  expect(memory.add('acme', fact('line one\n\nline two\r\n- injected item')).text).toBe('line one line two - injected item')
})

it('a tenant name that is not a safe file name is refused', () => {
  const memory = store()
  for (const tenant of ['../acme', 'a/b', '', 'UPPER']) expect(() => memory.add(tenant, fact('some fact text')), tenant).toThrow(/tenant/)
  expect(() => memory.list('../acme')).toThrow(/tenant/)
})

function core() {
  const stateDir = mkdtempSync(join(tmpdir(), 'helmgear-mem-core-'))
  const memory = new MemoryStore(join(stateDir, 'memory'))
  return { memory, ...createCore({ connectors: [memoryConnector({ store: memory })], stateDir }) }
}

it('memory.propose is held for approval and stores nothing until approved', async () => {
  const { memory, executor, approvals } = core()
  const text = 'The business never uses exclamation marks.'
  expect(await executor.call('memory.propose', { text }, CTX, 'k1')).toEqual({ status: 'pending', actionId: 'k1' })
  expect(memory.list('acme')).toEqual([])
  expect(approvals.list('acme')).toHaveLength(1)
  expect(await approvals.approve('k1', 'sam')).toMatchObject({ status: 'executed' })
  expect(memory.list('acme')).toMatchObject([{ kind: 'fact', text, source: 'approved-proposal' }])
  expect(memory.list('globex')).toEqual([])
})

it('a rejected proposal stores nothing', async () => {
  const { memory, executor, approvals } = core()
  await executor.call('memory.propose', { text: 'The admin password is hunter2.' }, CTX, 'k1')
  approvals.reject('k1', 'sam')
  expect(memory.list('acme')).toEqual([])
})

it('memory.propose refuses text that is too short or too long', async () => {
  const { executor } = core()
  expect(await executor.call('memory.propose', { text: 'short' }, CTX, 'k1')).toMatchObject({ status: 'refused' })
  expect(await executor.call('memory.propose', { text: 'x'.repeat(301) }, CTX, 'k2')).toMatchObject({ status: 'refused' })
})
