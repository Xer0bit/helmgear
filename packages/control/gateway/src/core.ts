import { join } from 'node:path'
import { ApprovalQueue } from './approvals.ts'
import { AuditLog } from './audit.ts'
import { Executor } from './execute.ts'
import type { MemoryStore } from './memory.ts'
import type { Connector } from './registry.ts'

export interface GatewayCore { executor: Executor; approvals: ApprovalQueue; audit: AuditLog }

/** Audit log, approval queue and executor wired together over one state folder. */
export function createCore(options: {
  connectors: Connector[]
  stateDir: string
  /** When set, a rejection with a reason becomes a lesson for that tenant and template. */
  memory?: MemoryStore
}): GatewayCore {
  const audit = new AuditLog(join(options.stateDir, 'audit.jsonl'))
  const approvals: ApprovalQueue = new ApprovalQueue({
    dir: join(options.stateDir, 'pending'),
    audit,
    // A resolved action is forgotten, so the same call later is a new request and not a stale "queued".
    onResolved: actionId => executor.forget(actionId),
    // The reason is typed by the approver, so it is trusted guidance, unlike anything an agent read.
    onRejected: (action, _approver, reason) => {
      const why = reason?.replace(/\s+/g, ' ').trim()
      if (!options.memory || !why) return
      options.memory.add(action.ctx.tenant, {
        kind: 'lesson', source: 'rejection', template: action.ctx.template,
        text: `A person rejected a ${action.tool} because: ${why.slice(0, 200)}`,
      })
    },
    run: (action) => {
      const tool = executor.tool(action.tool)
      if (!tool) throw new Error(`unknown tool: ${action.tool}`)
      return tool.run(action.input, action.ctx)
    },
  })
  const executor = new Executor({ connectors: options.connectors, audit, stateDir: options.stateDir, queue: approvals })
  return { executor, approvals, audit }
}
