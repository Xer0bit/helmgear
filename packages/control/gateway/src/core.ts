import { join } from 'node:path'
import { ApprovalQueue } from './approvals.ts'
import { AuditLog } from './audit.ts'
import { Executor } from './execute.ts'
import type { Connector } from './registry.ts'

export interface GatewayCore { executor: Executor; approvals: ApprovalQueue; audit: AuditLog }

/** Audit log, approval queue and executor wired together over one state folder. */
export function createCore(options: { connectors: Connector[]; stateDir: string }): GatewayCore {
  const audit = new AuditLog(join(options.stateDir, 'audit.jsonl'))
  const approvals: ApprovalQueue = new ApprovalQueue({
    dir: join(options.stateDir, 'pending'),
    audit,
    // A resolved action is forgotten, so the same call later is a new request and not a stale "queued".
    onResolved: actionId => executor.forget(actionId),
    run: (action) => {
      const tool = executor.tool(action.tool)
      if (!tool) throw new Error(`unknown tool: ${action.tool}`)
      return tool.run(action.input, action.ctx)
    },
  })
  const executor = new Executor({ connectors: options.connectors, audit, stateDir: options.stateDir, queue: approvals })
  return { executor, approvals, audit }
}
