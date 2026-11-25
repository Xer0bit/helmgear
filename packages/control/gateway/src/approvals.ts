import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type AuditLog, payloadSha256 } from './audit.ts'
import type { PendingRequest } from './registry.ts'

export interface PendingAction extends PendingRequest {
  /** ISO 8601 UTC. */
  createdAt: string
}

export type ApprovalResult = { status: 'executed'; result: unknown } | { status: 'refused'; reason: string }

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

/**
 * `send` actions waiting for a person, one JSON file each. The audit log
 * records every request before its file is written; approval executes the
 * stored file only if its payload and caller still match that record.
 */
export class ApprovalQueue {
  private readonly dir: string
  private readonly audit: AuditLog
  private readonly run: (action: PendingAction) => Promise<unknown>

  private readonly onResolved: ((actionId: string) => void) | undefined
  private readonly onRejected: ((action: PendingAction, approver: string, reason: string | undefined) => void) | undefined

  constructor(options: {
    dir: string
    audit: AuditLog
    run: (action: PendingAction) => Promise<unknown>
    /** Called once an action stops being pending: after it executed, and after it was rejected. */
    onResolved?: (actionId: string) => void
    /** Called after a rejection is audited. The reason is the approver's own words. */
    onRejected?: (action: PendingAction, approver: string, reason: string | undefined) => void
  }) {
    this.onResolved = options.onResolved
    this.onRejected = options.onRejected
    this.dir = options.dir
    this.audit = options.audit
    this.run = options.run
    mkdirSync(this.dir, { recursive: true })
  }

  private file(actionId: string): string { return join(this.dir, `${actionId}.json`) }

  enqueue(action: PendingRequest): void {
    if (!SAFE_ID.test(action.actionId)) throw new Error('action id must match [A-Za-z0-9_-]{1,128}')
    const file = this.file(action.actionId)
    if (existsSync(file)) return
    const { tenant, sessionId, template } = action.ctx
    // Audit first: a file with no audited request is never approvable.
    this.audit.append({ tenant, sessionId, template, tool: action.tool, tier: 'send', event: 'pending', actionId: action.actionId, payloadSha256: action.payloadSha256, ...(action.untrustedSources?.length ? { detail: `after reading ${action.untrustedSources.join(', ')}` } : {}) })
    const stored: PendingAction = { ...action, createdAt: new Date().toISOString() }
    writeFileSync(`${file}.tmp`, JSON.stringify(stored, null, 2), { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
  }

  /** Waiting actions, oldest first. A file that cannot be read is left out, not fatal. */
  list(tenant?: string): PendingAction[] {
    return readdirSync(this.dir)
      .filter(name => name.endsWith('.json'))
      .flatMap((name) => {
        try { return [JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as PendingAction] } catch { return [] }
      })
      .filter(action => tenant === undefined || action.ctx?.tenant === tenant)
      .sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)
  }

  async approve(actionId: string, approver: string): Promise<ApprovalResult> {
    const gone: ApprovalResult = { status: 'refused', reason: `no pending action ${actionId}` }
    if (!SAFE_ID.test(actionId)) return gone
    if (!approver.trim()) return { status: 'refused', reason: 'an approver is required' }
    const file = this.file(actionId)
    // Claim the action by renaming it: of two concurrent approvals, one rename fails.
    // ponytail: a crash while the send is running leaves a .running file that is neither
    // listed nor approvable, because nobody knows whether it went out. Resolve those by hand.
    const claimed = `${file}.running`
    try { renameSync(file, claimed) } catch { return gone }

    // Everything before the run puts the file back on failure, so only a send that
    // actually started can be left as .running.
    let action: PendingAction
    let record: { tenant: string; sessionId: string; template: string; tool: string; tier: 'send'; actionId: string; approver: string; payloadSha256: string }
    try {
      let problem: string | undefined
      try { action = JSON.parse(readFileSync(claimed, 'utf8')) as PendingAction } catch { action = undefined as never }
      // ponytail: linear scan of the audit log per approval; index it if the log grows large.
      const requested = this.audit.read().find(e => e.actionId === actionId && e.event === 'pending')
      if (!action?.ctx || typeof action.tool !== 'string' || typeof action.input !== 'object' || action.input === null) problem = 'stored action is unreadable'
      else if (!requested) problem = 'the audit log has no request for this action'
      else if (payloadSha256(action.tool, action.input) !== requested.payloadSha256 || action.payloadSha256 !== requested.payloadSha256) {
        problem = 'stored payload does not match the hash recorded when it was requested'
      } else if (action.tool !== requested.tool || action.ctx.tenant !== requested.tenant || action.ctx.sessionId !== requested.sessionId || action.ctx.template !== requested.template) {
        problem = 'stored tool or caller does not match what was recorded when it was requested'
      }
      if (problem !== undefined) {
        renameSync(claimed, file)
        // The refusal is audited under the recorded caller, never the possibly altered one.
        if (requested) {
          const { tenant, sessionId, template, tool, payloadSha256: hash } = requested
          this.audit.append({ tenant, sessionId, template, tool, tier: 'send', event: 'refused', actionId, approver, payloadSha256: hash, detail: problem })
        }
        return { status: 'refused', reason: problem }
      }
      const { tenant, sessionId, template } = action.ctx
      record = { tenant, sessionId, template, tool: action.tool, tier: 'send', actionId, approver, payloadSha256: action.payloadSha256 }
      this.audit.append({ ...record, event: 'approved' })
    } catch (error) {
      renameSync(claimed, file)
      throw error
    }

    let result: unknown
    try {
      result = await this.run(action)
    } catch (error) {
      this.audit.append({ ...record, event: 'failed', detail: error instanceof Error ? error.message : String(error) })
      renameSync(claimed, file)
      throw error
    }
    this.audit.append({ ...record, event: 'executed' })
    rmSync(claimed)
    this.onResolved?.(actionId)
    return { status: 'executed', result }
  }

  reject(actionId: string, approver: string, reason?: string): void {
    const file = SAFE_ID.test(actionId) ? this.file(actionId) : undefined
    if (!approver.trim()) throw new Error('an approver is required')
    if (!file || !existsSync(file)) throw new Error(`no pending action ${actionId}`)
    let action: Partial<PendingAction> = {}
    try { action = JSON.parse(readFileSync(file, 'utf8')) as PendingAction } catch { /* an unreadable action can still be rejected */ }
    rmSync(file)
    this.audit.append({
      tenant: action.ctx?.tenant ?? '', sessionId: action.ctx?.sessionId ?? '', template: action.ctx?.template ?? '',
      tool: action.tool ?? '', tier: 'send', event: 'rejected', actionId, approver,
      payloadSha256: action.payloadSha256 ?? '', ...(reason ? { detail: reason } : {}),
    })
    this.onResolved?.(actionId)
    if (action.ctx && action.tool) this.onRejected?.(action as PendingAction, approver, reason)
  }
}
