import { createHash } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RiskTier } from '@helmgear/template'

export interface AuditEntry {
  /** ISO 8601 UTC. */
  at: string
  tenant: string
  sessionId: string
  template: string
  /** `<connector>.<action>`. */
  tool: string
  tier: RiskTier
  event: 'executed' | 'pending' | 'approved' | 'rejected' | 'failed' | 'refused'
  /** Idempotency key. */
  actionId: string
  payloadSha256: string
  approver?: string
  /** Error message or external object id. Never a payload or a secret. */
  detail?: string
}

/** Append-only JSON Lines record of every gateway decision. It stores payload hashes, never payloads. */
export class AuditLog {
  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true })
  }

  append(entry: Omit<AuditEntry, 'at'>): void {
    const fd = openSync(this.file, 'a', 0o600)
    try {
      // `at` goes last so nothing in the entry can set the time.
      writeSync(fd, `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`)
      fsyncSync(fd)
    } finally { closeSync(fd) }
  }

  read(): AuditEntry[] {
    if (!existsSync(this.file)) return []
    // A crash can leave one torn line; skip it instead of making the whole log unreadable.
    return readFileSync(this.file, 'utf8').split('\n').flatMap((line) => {
      try { return line ? [JSON.parse(line) as AuditEntry] : [] } catch { return [] }
    })
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value !== 'object' || value === null) return value
  const source = value as Record<string, unknown>
  return Object.fromEntries(Object.keys(source).sort().map(key => [key, canonical(source[key])]))
}

/** Canonical JSON: object keys sorted at every depth, so equal payloads serialise identically. */
export function canonicalJson(value: unknown): string { return JSON.stringify(canonical(value)) }

/** SHA-256 over the tool name and the canonical JSON of its input. */
export function payloadSha256(tool: string, input: Record<string, unknown>): string {
  return createHash('sha256').update(`${tool}\n${canonicalJson(input)}`).digest('hex')
}
