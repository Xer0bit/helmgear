import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** `dailyAt` is `HH:MM` in UTC. */
export type When = { everyMinutes: number } | { dailyAt: string }

export interface Job {
  id: string
  tenant: string
  request: string
  template?: string
  when: When
  /** The last slot this job was started for. */
  lastSlot?: string
}

const DAILY = /^([01]\d|2[0-3]):[0-5]\d$/

function checkWhen(when: When): void {
  const every = (when as { everyMinutes?: unknown }).everyMinutes
  const daily = (when as { dailyAt?: unknown }).dailyAt
  if (every !== undefined) {
    if (!Number.isInteger(every) || (every as number) < 1) throw new Error('when.everyMinutes must be a whole number of at least 1')
  } else if (typeof daily !== 'string' || !DAILY.test(daily)) {
    throw new Error('when must be { everyMinutes } or { dailyAt: "HH:MM" } in UTC')
  }
}

/** The period `now` falls in for this job, or undefined when the job is not due yet today. */
function slotOf(when: When, now: Date): string | undefined {
  if ('everyMinutes' in when) {
    const span = when.everyMinutes * 60_000
    return new Date(Math.floor(now.getTime() / span) * span).toISOString()
  }
  const iso = now.toISOString()
  return iso.slice(11, 16) >= when.dailyAt ? iso.slice(0, 10) : undefined
}

/**
 * Recurring tasks without a daemon: the application calls `tick` from its own
 * timer, and each job runs at most once per slot. The slot is written to the
 * file before the job starts, so a restart cannot run it a second time.
 * ponytail: the file is read and rewritten without a lock, so two processes
 * ticking the same file in the same instant could both start a job. Run one
 * scheduler per file; add a file lock if that ever stops being true.
 */
export class Scheduler {
  private readonly inFlight = new Map<string, Promise<void>>()

  constructor(private readonly options: {
    file: string
    run: (job: Job) => Promise<unknown>
    /** Called when a run throws. The slot is not retried. */
    onError?: (job: Job, error: Error) => void
  }) {
    mkdirSync(dirname(options.file), { recursive: true })
  }

  private load(): Job[] {
    return existsSync(this.options.file) ? JSON.parse(readFileSync(this.options.file, 'utf8')) as Job[] : []
  }

  private save(jobs: Job[]): void {
    writeFileSync(`${this.options.file}.tmp`, JSON.stringify(jobs, null, 2), { mode: 0o600 })
    renameSync(`${this.options.file}.tmp`, this.options.file)
  }

  add(job: Omit<Job, 'id' | 'lastSlot'>): Job {
    checkWhen(job.when)
    const stored: Job = { id: randomBytes(9).toString('base64url'), ...job }
    this.save([...this.load(), stored])
    return stored
  }

  remove(id: string): void { this.save(this.load().filter(job => job.id !== id)) }

  list(): Job[] { return this.load() }

  /** Start every job whose current slot has not been started. Returns the ids started; it does not wait for them. */
  async tick(now: Date = new Date()): Promise<string[]> {
    const jobs = this.load()
    const due = jobs.filter((job) => {
      const slot = slotOf(job.when, now)
      if (slot === undefined || slot === job.lastSlot || this.inFlight.has(job.id)) return false
      job.lastSlot = slot
      return true
    })
    if (due.length === 0) return []
    this.save(jobs)
    for (const job of due) {
      const running = Promise.resolve()
        .then(() => this.options.run(job))
        .then(() => undefined, (error: unknown) => { this.options.onError?.(job, error instanceof Error ? error : new Error(String(error))) })
        .finally(() => { this.inFlight.delete(job.id) })
      this.inFlight.set(job.id, running)
    }
    return due.map(job => job.id)
  }

  /** Resolves when no started job is still running. */
  async idle(): Promise<void> { await Promise.all(this.inFlight.values()) }
}
