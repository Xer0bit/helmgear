import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface MemoryEntry {
  id: string
  /** ISO 8601 UTC. */
  at: string
  /** A fact about the business, or a lesson from a rejected action. */
  kind: 'fact' | 'lesson'
  text: string
  /** Set when the entry applies to one template only. */
  template?: string
  source: 'person' | 'approved-proposal' | 'rejection'
  /** ISO 8601 UTC. After this moment the entry is no longer listed or shown to an agent. */
  expiresAt?: string
}

const TENANT = /^[a-z0-9][a-z0-9_-]{0,63}$/
const MAX_TEXT = 300

/**
 * What each tenant's agents know between runs: one JSON Lines file per
 * tenant. Every entry got here through a person: typed by one, approved by
 * one, or written as the reason for a rejection.
 */
export class MemoryStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  private file(tenant: string): string {
    if (!TENANT.test(tenant)) throw new Error('tenant must match [a-z0-9][a-z0-9_-]{0,63}')
    return join(this.dir, `${tenant}.jsonl`)
  }

  private all(tenant: string): MemoryEntry[] {
    const file = this.file(tenant)
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf8').split('\n').flatMap((line) => {
      try { return line ? [JSON.parse(line) as MemoryEntry] : [] } catch { return [] }
    })
  }

  private clean(raw: string): string {
    // One line per entry: an entry cannot smuggle in a second list item or a heading.
    const text = raw.replace(/\s+/g, ' ').trim()
    if (!text) throw new Error('memory text is empty')
    if (text.length > MAX_TEXT) throw new Error(`memory text is longer than ${MAX_TEXT} characters`)
    return text
  }

  private save(tenant: string, entries: MemoryEntry[]): void {
    const file = this.file(tenant)
    writeFileSync(`${file}.tmp`, entries.map(entry => `${JSON.stringify(entry)}\n`).join(''), { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
  }

  add(tenant: string, entry: Omit<MemoryEntry, 'id' | 'at'>): MemoryEntry {
    const text = this.clean(entry.text)
    if (entry.expiresAt !== undefined && Number.isNaN(Date.parse(entry.expiresAt))) throw new Error('expiresAt must be an ISO 8601 date')
    const stored: MemoryEntry = { id: randomBytes(9).toString('base64url'), at: new Date().toISOString(), ...entry, text }
    appendFileSync(this.file(tenant), `${JSON.stringify(stored)}\n`, { mode: 0o600 })
    return stored
  }

  /** Entries that apply to every template, plus the named template's. Without a template: all. Oldest first. */
  list(tenant: string, template?: string): MemoryEntry[] {
    const now = Date.now()
    return this.all(tenant).filter(entry => (template === undefined || entry.template === undefined || entry.template === template)
      && !(entry.expiresAt && Date.parse(entry.expiresAt) <= now))
  }

  /** Removing also drops entries that have expired. */
  remove(tenant: string, id: string): void {
    this.save(tenant, this.list(tenant).filter(entry => entry.id !== id))
  }

  /** Correct the text of one entry in place. */
  update(tenant: string, id: string, text: string): MemoryEntry {
    const entries = this.all(tenant)
    const entry = entries.find(candidate => candidate.id === id)
    if (!entry) throw new Error(`no memory entry ${id}`)
    entry.text = this.clean(text)
    this.save(tenant, entries)
    return entry
  }

  /**
   * The text to put in front of an agent: facts, then lessons, one `- ` line
   * each, oldest first within a kind. Lessons get at most 30% of `maxChars`
   * and facts the rest, so a run of rejections cannot push what the business
   * is out of the prompt. Within a kind the oldest entries drop out first.
   */
  render(tenant: string, template?: string, maxChars = 2000): string {
    const entries = this.list(tenant, template)
    const newestThatFit = (kind: MemoryEntry['kind'], budget: number): string[] => {
      const lines: string[] = []
      let used = 0
      for (const entry of entries.filter(candidate => candidate.kind === kind).reverse()) {
        const line = `- ${entry.text}`
        if (used + line.length + 1 > budget + 1) break
        used += line.length + 1
        lines.unshift(line)
      }
      return lines
    }
    const lessons = newestThatFit('lesson', Math.floor(maxChars * 0.3))
    const lessonChars = lessons.reduce((sum, line) => sum + line.length + 1, 0)
    return [...newestThatFit('fact', maxChars - lessonChars), ...lessons].join('\n')
  }
}
