import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Scheduler, type Job } from '../src/index.ts'

const at = (time: string): Date => new Date(`2026-11-17T${time}Z`)
function setup(run?: (job: Job) => Promise<unknown>) {
  const file = join(mkdtempSync(join(tmpdir(), 'helmgear-sched-')), 'jobs.json')
  const ran: string[] = []
  const options = { file, run: run ?? (async (job: Job) => { ran.push(job.id) }) }
  return { file, ran, options, scheduler: new Scheduler(options) }
}
const JOB = { tenant: 'acme', request: 'brief on x', template: 'competitor-brief' }

it('runs a job once per slot and not again within the slot', async () => {
  const { scheduler, ran } = setup()
  const job = scheduler.add({ ...JOB, when: { everyMinutes: 15 } })
  expect(await scheduler.tick(at('10:02:00'))).toEqual([job.id])
  await scheduler.idle()
  expect(await scheduler.tick(at('10:14:59'))).toEqual([])
  expect(ran).toEqual([job.id])
})

it('runs again in the next slot', async () => {
  const { scheduler, ran } = setup()
  const job = scheduler.add({ ...JOB, when: { everyMinutes: 15 } })
  await scheduler.tick(at('10:02:00'))
  await scheduler.idle()
  expect(await scheduler.tick(at('10:15:00'))).toEqual([job.id])
  await scheduler.idle()
  expect(ran).toHaveLength(2)
})

it('a dailyAt job runs once after its time and not before', async () => {
  const { scheduler, ran } = setup()
  const job = scheduler.add({ ...JOB, when: { dailyAt: '09:30' } })
  expect(await scheduler.tick(at('09:29:59'))).toEqual([])
  expect(await scheduler.tick(at('09:30:00'))).toEqual([job.id])
  await scheduler.idle()
  expect(await scheduler.tick(at('23:59:00'))).toEqual([])
  expect(await scheduler.tick(new Date('2026-11-18T09:31:00Z'))).toEqual([job.id])
  await scheduler.idle()
  expect(ran).toHaveLength(2)
})

it('records the slot before running, so a second Scheduler on the same file does not run it again', async () => {
  let release = (): void => {}
  const { scheduler, options } = setup(() => new Promise<void>((resolve) => { release = resolve }))
  scheduler.add({ ...JOB, when: { everyMinutes: 15 } })
  await scheduler.tick(at('10:02:00'))
  // The first run is still in flight; a restarted process must already see the slot as taken.
  const restarted = new Scheduler(options)
  expect(restarted.list()[0]!.lastSlot).toBeDefined()
  expect(await restarted.tick(at('10:03:00'))).toEqual([])
  release()
  await scheduler.idle()
})

it('skips a job whose previous run has not finished', async () => {
  let release = (): void => {}
  let runs = 0
  const { scheduler } = setup(() => { runs++; return new Promise<void>((resolve) => { release = resolve }) })
  const job = scheduler.add({ ...JOB, when: { everyMinutes: 1 } })
  await scheduler.tick(at('10:00:00'))
  expect(await scheduler.tick(at('10:01:00'))).toEqual([])
  release()
  await scheduler.idle()
  expect(await scheduler.tick(at('10:02:00'))).toEqual([job.id])
  release()
  await scheduler.idle()
  expect(runs).toBe(2)
})

it('a failing run does not stop other due jobs and is not retried in the same slot', async () => {
  const ran: string[] = []
  const errors: string[] = []
  const file = join(mkdtempSync(join(tmpdir(), 'helmgear-sched-')), 'jobs.json')
  const scheduler = new Scheduler({
    file, onError: (job, error) => { errors.push(`${job.request}: ${error.message}`) },
    run: async (job) => { ran.push(job.request); if (job.request === 'bad') throw new Error('boom') },
  })
  scheduler.add({ tenant: 'acme', request: 'bad', when: { everyMinutes: 15 } })
  scheduler.add({ tenant: 'acme', request: 'good', when: { everyMinutes: 15 } })
  expect(await scheduler.tick(at('10:00:00'))).toHaveLength(2)
  await scheduler.idle()
  expect(await scheduler.tick(at('10:05:00'))).toEqual([])
  expect(ran.sort()).toEqual(['bad', 'good'])
  expect(errors).toEqual(['bad: boom'])
})

it('rejects everyMinutes below 1 and a malformed dailyAt', () => {
  const { scheduler } = setup()
  for (const when of [{ everyMinutes: 0 }, { everyMinutes: 1.5 }, { dailyAt: '25:00' }, { dailyAt: '9:5' }, { dailyAt: 'noon' }, {} as never]) {
    expect(() => scheduler.add({ ...JOB, when }), JSON.stringify(when)).toThrow(/when/)
  }
})

it('jobs survive a restart, and remove deletes one', () => {
  const { scheduler, options } = setup()
  const a = scheduler.add({ ...JOB, when: { everyMinutes: 15 } })
  const b = scheduler.add({ ...JOB, when: { dailyAt: '09:30' } })
  expect(new Scheduler(options).list().map(j => j.id)).toEqual([a.id, b.id])
  scheduler.remove(a.id)
  expect(new Scheduler(options).list().map(j => j.id)).toEqual([b.id])
})
