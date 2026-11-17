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

  add(tenant: string, entry: Omit<MemoryEntry, 'id' | 'at'>): MemoryEntry {
    // One line per entry: an entry cannot smuggle in a second list item or a heading.
    const text = entry.text.replace(/\s+/g, ' ').trim()
    if (!text) throw new Error('memory text is empty')
    if (text.length > MAX_TEXT) throw new Error(`memory text is longer than ${MAX_TEXT} characters`)
    const stored: MemoryEntry = { id: randomBytes(9).toString('base64url'), at: new Date().toISOString(), ...entry, text }
    appendFileSync(this.file(tenant), `${JSON.stringify(stored)}\n`, { mode: 0o600 })
    return stored
  }

  /** Entries that apply to every template, plus the named template's. Without a template: all. Oldest first. */
  list(tenant: string, template?: string): MemoryEntry[] {
    return this.all(tenant).filter(entry => template === undefined || entry.template === undefined || entry.template === template)
  }

  remove(tenant: string, id: string): void {
    const file = this.file(tenant)
    const kept = this.all(tenant).filter(entry => entry.id !== id)
    writeFileSync(`${file}.tmp`, kept.map(entry => `${JSON.stringify(entry)}\n`).join(''), { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
  }

  /**
   * The text to put in front of an agent: the newest entries that fit
   * `maxChars`, one `- ` line each, oldest first. Older entries drop out
   * first, so memory cannot grow the prompt without bound.
   */
  render(tenant: string, template?: string, maxChars = 2000): string {
    const lines: string[] = []
    let used = 0
    for (const entry of this.list(tenant, template).reverse()) {
      const line = `- ${entry.text}`
      if (used + line.length + (lines.length ? 1 : 0) > maxChars) break
      used += line.length + (lines.length ? 1 : 0)
      lines.unshift(line)
    }
    return lines.join('\n')
  }
}
