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
 * `send` actions waiting for a person, one JSON file each. Approval executes
 * the stored payload, and only if it still hashes to what was recorded when
 * the model asked for it.
 */
export class ApprovalQueue {
  private readonly dir: string
  private readonly audit: AuditLog
  private readonly run: (action: PendingAction) => Promise<unknown>

  constructor(options: { dir: string; audit: AuditLog; run: (action: PendingAction) => Promise<unknown> }) {
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
    const stored: PendingAction = { ...action, createdAt: new Date().toISOString() }
    writeFileSync(`${file}.tmp`, JSON.stringify(stored, null, 2), { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
  }

  list(tenant?: string): PendingAction[] {
    return readdirSync(this.dir)
      .filter(name => name.endsWith('.json'))
      .map(name => JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as PendingAction)
      .filter(action => tenant === undefined || action.ctx.tenant === tenant)
      .sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)
  }

  async approve(actionId: string, approver: string): Promise<ApprovalResult> {
    const gone: ApprovalResult = { status: 'refused', reason: `no pending action ${actionId}` }
    if (!SAFE_ID.test(actionId)) return gone
    const file = this.file(actionId)
    // Claim the action by renaming it: of two concurrent approvals, one rename fails.
    // ponytail: a crash while running leaves a .running file that is neither listed nor
    // approvable, because nobody knows whether the send went out. Resolve those by hand.
    const claimed = `${file}.running`
    try { renameSync(file, claimed) } catch { return gone }

    const action = JSON.parse(readFileSync(claimed, 'utf8')) as PendingAction
    const record = { ...action.ctx, tool: action.tool, tier: 'send', actionId, approver } as const
    const actual = payloadSha256(action.tool, action.input)
    // The hash stored beside the payload can be rewritten with it, so also check the
    // hash the audit log recorded when the model asked. ponytail: linear scan of the log.
    const audited = this.audit.read().find(e => e.actionId === actionId && e.event === 'pending')?.payloadSha256
    if (actual !== action.payloadSha256 || (audited !== undefined && actual !== audited)) {
      renameSync(claimed, file)
      const reason = 'stored payload does not match the hash recorded when it was requested'
      this.audit.append({ ...record, event: 'refused', payloadSha256: actual, detail: reason })
      return { status: 'refused', reason }
    }

    this.audit.append({ ...record, event: 'approved', payloadSha256: actual })
    let result: unknown
    try {
      result = await this.run(action)
    } catch (error) {
      this.audit.append({ ...record, event: 'failed', payloadSha256: actual, detail: error instanceof Error ? error.message : String(error) })
      renameSync(claimed, file)
      throw error
    }
    this.audit.append({ ...record, event: 'executed', payloadSha256: actual })
    rmSync(claimed)
    return { status: 'executed', result }
  }

  reject(actionId: string, approver: string, reason?: string): void {
    const file = SAFE_ID.test(actionId) ? this.file(actionId) : undefined
    if (!file || !existsSync(file)) throw new Error(`no pending action ${actionId}`)
    const action = JSON.parse(readFileSync(file, 'utf8')) as PendingAction
    rmSync(file)
    this.audit.append({
      ...action.ctx, tool: action.tool, tier: 'send', event: 'rejected', actionId, approver,
      payloadSha256: action.payloadSha256, ...(reason ? { detail: reason } : {}),
    })
  }
}
