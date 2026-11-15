import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AuditLog, payloadSha256 } from '../src/index.ts'

function file(): string { return join(mkdtempSync(join(tmpdir(), 'helmgear-audit-')), 'nested', 'audit.jsonl') }
const ENTRY = {
  tenant: 't1', sessionId: 's1', template: 'social-post', tool: 'outbox.send', tier: 'send' as const,
  event: 'pending' as const, actionId: 'a1', payloadSha256: 'abc',
}

it('appends one JSON line per entry and stamps a UTC time', () => {
  const path = file()
  const log = new AuditLog(path)
  log.append(ENTRY)
  log.append({ ...ENTRY, event: 'approved', approver: 'sam' })
  const lines = readFileSync(path, 'utf8').split('\n')
  expect(lines).toHaveLength(3)
  expect(lines[2]).toBe('')
  const first = JSON.parse(lines[0]!)
  expect(first).toMatchObject(ENTRY)
  expect(first.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
})

it('read returns entries in write order', () => {
  const log = new AuditLog(file())
  expect(log.read()).toEqual([])
  for (const actionId of ['a', 'b', 'c']) log.append({ ...ENTRY, actionId })
  expect(log.read().map(e => e.actionId)).toEqual(['a', 'b', 'c'])
})

it('never rewrites earlier lines', () => {
  const path = file()
  const log = new AuditLog(path)
  log.append(ENTRY)
  const before = readFileSync(path)
  log.append({ ...ENTRY, actionId: 'a2' })
  expect(readFileSync(path).subarray(0, before.length).equals(before)).toBe(true)
})

it('stores the payload hash, not the payload', () => {
  const path = file()
  const marker = 'MARKER-ONLY-IN-PAYLOAD'
  new AuditLog(path).append({ ...ENTRY, payloadSha256: payloadSha256('outbox.send', { body: marker }) })
  expect(readFileSync(path, 'utf8')).not.toContain(marker)
})

it('hashes a payload the same whatever the key order, and differently when a value changes', () => {
  const a = payloadSha256('outbox.send', { to: 'x', nested: { b: 1, a: [2, { d: 1, c: 2 }] } })
  expect(payloadSha256('outbox.send', { nested: { a: [2, { c: 2, d: 1 }], b: 1 }, to: 'x' })).toBe(a)
  expect(a).toMatch(/^[0-9a-f]{64}$/)
  expect(payloadSha256('outbox.send', { to: 'y', nested: { b: 1, a: [2, { d: 1, c: 2 }] } })).not.toBe(a)
  expect(payloadSha256('outbox.draft', { to: 'x', nested: { b: 1, a: [2, { d: 1, c: 2 }] } })).not.toBe(a)
})
