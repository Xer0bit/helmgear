import { expect, it } from 'vitest'
import { runBatch, type BatchItem, type BatchResult, type TaskResult } from '../src/index.ts'

const item = (request: string): BatchItem => ({ tenant: 'acme', request })
const ok = (request: string): TaskResult => ({ status: 'no-template', reason: request })
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

it('returns results in input order', async () => {
  const runner = { runTask: async (input: BatchItem) => { await sleep(input.request === 'a' ? 30 : 1); return ok(input.request) } }
  const results = await runBatch(runner, [item('a'), item('b'), item('c')])
  expect(results.map(r => r.item.request)).toEqual(['a', 'b', 'c'])
  expect(results.map(r => 'result' in r && r.result.status === 'no-template' && r.result.reason)).toEqual(['a', 'b', 'c'])
  expect(results.every(r => r.seconds >= 0)).toBe(true)
})

it('never runs more than concurrency tasks at once', async () => {
  let live = 0
  let peak = 0
  const runner = { runTask: async (input: BatchItem) => { peak = Math.max(peak, ++live); await sleep(10); live--; return ok(input.request) } }
  await runBatch(runner, Array.from({ length: 12 }, (_unused, i) => item(String(i))), { concurrency: 3 })
  expect(peak).toBe(3)
  peak = 0
  await runBatch(runner, [item('a'), item('b')], { concurrency: 0 })
  expect(peak).toBe(1)
})

it('one failing task does not stop the others and is returned as error', async () => {
  const runner = { runTask: async (input: BatchItem) => { if (input.request === 'bad') throw new Error('boom'); return ok(input.request) } }
  const results = await runBatch(runner, [item('a'), item('bad'), item('c')])
  expect('error' in results[1]! && results[1].error.message).toBe('boom')
  expect('result' in results[0]! && 'result' in results[2]!).toBe(true)
})

it('calls onResult once per item as each finishes', async () => {
  const seen: BatchResult[] = []
  const runner = { runTask: async (input: BatchItem) => { await sleep(input.request === 'slow' ? 30 : 1); return ok(input.request) } }
  await runBatch(runner, [item('slow'), item('fast')], { onResult: result => { seen.push(result) } })
  expect(seen.map(r => r.item.request)).toEqual(['fast', 'slow'])
})

it('an empty list returns an empty list', async () => {
  expect(await runBatch({ runTask: async () => ok('x') }, [])).toEqual([])
})
