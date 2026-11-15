import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ApprovalQueue } from '@helmgear/gateway'
import { route, type Classifier } from '@helmgear/router'
import { Helmgear, RequestTimeoutError, TransportClosedError, type HelmgearOptions, type RunResult } from '@helmgear/sdk-client'
import { loadTemplates } from '@helmgear/template'
import { templatePatch } from './patch.ts'

/** The part of the harness client the runner uses. */
export interface HarnessLike {
  run(request: string, options: { sessionId: string }): Promise<RunResult>
  close(): Promise<void>
}

export interface RunnerOptions {
  templatesDir: string
  /** `<stateDir>/tenants/<tenant>` is that tenant's harness home. */
  stateDir: string
  gateway: {
    url: string
    /** Mint a token the gateway ties to exactly this run; see `startGateway`. */
    grant(ctx: { tenant: string; sessionId: string; template: string; connectors: string[] }): string
    revoke(token: string): void
    approvals: Pick<ApprovalQueue, 'list'>
  }
  classifier: Classifier
  model: { provider: string; model: string }
  /**
   * The complete environment of the harness process. Default: PATH, HOME and
   * the DeepSeek key only, so no other secret of the application reaches the
   * process that reads untrusted content.
   */
  env?: NodeJS.ProcessEnv
  /** Deadline for one whole run. Default 300,000 ms. */
  timeoutMs?: number
  /** Test seam: build the harness client. */
  harnessFactory?: (options: HelmgearOptions) => HarnessLike
}

export type TaskResult =
  | { status: 'done'; template: string; sessionId: string; response: string; pendingActionIds: string[] }
  | { status: 'failed'; template: string; sessionId: string; reason: string; pendingActionIds: string[] }
  | { status: 'no-template'; reason: string }
  | { status: 'refused'; reason: string }

/** The harness process died or stopped answering. Actions already queued for approval stay queued. */
export class RunnerError extends Error {
  readonly code: 'HARNESS_EXITED' | 'HARNESS_TIMEOUT'
  constructor(code: RunnerError['code'], message: string) {
    super(message)
    this.name = 'RunnerError'
    this.code = code
  }
}

const TENANT = /^[a-z0-9][a-z0-9_-]{0,63}$/
const PASSED_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL']
// DeepSeek's own API stores request data in mainland China.
const PRC_HOSTED_PROVIDERS = ['deepseek-official']

function turnError(result: RunResult): string {
  for (const event of [...result.events].reverse() as { type: string; data?: { reason?: { error?: { message?: string } } } }[]) {
    const message = event.type === 'turn/end' ? event.data?.reason?.error?.message : undefined
    if (message) return message
  }
  return 'the turn ended in an error'
}

export function createRunner(options: RunnerOptions): { runTask(input: { tenant: string; request: string; template?: string }): Promise<TaskResult> } {
  const factory = options.harnessFactory ?? (harnessOptions => new Helmgear(harnessOptions))

  return {
    async runTask({ tenant, request, template: named }) {
      if (!TENANT.test(tenant)) return { status: 'refused', reason: 'tenant must match [a-z0-9][a-z0-9_-]{0,63}' }
      const templates = loadTemplates(options.templatesDir)

      let template = templates.find(t => t.name === named)
      if (named !== undefined && !template) return { status: 'refused', reason: `unknown template: ${named}` }
      if (!template) {
        const routed = await route(request, templates, options.classifier)
        if (routed.kind === 'none') return { status: 'no-template', reason: routed.detail ? `${routed.reason}: ${routed.detail}` : routed.reason }
        template = routed.template
      }
      if (template.dataClass === 'sensitive' && PRC_HOSTED_PROVIDERS.includes(options.model.provider)) {
        return { status: 'refused', reason: `template ${template.name} handles sensitive data and may not run on provider ${options.model.provider}` }
      }

      const home = join(options.stateDir, 'tenants', tenant)
      const sessionId = `session-${randomUUID().replaceAll('-', '')}`
      mkdirSync(join(home, 'work'), { recursive: true })
      const patchFile = join(home, `${sessionId}.patch.yml`)
      const token = options.gateway.grant({ tenant, sessionId, template: template.name, connectors: template.connectors })
      const pendingActionIds = (): string[] =>
        options.gateway.approvals.list(tenant).filter(action => action.ctx.sessionId === sessionId).map(action => action.actionId)
      let harness: HarnessLike | undefined
      let deadline: NodeJS.Timeout | undefined
      try {
        writeFileSync(patchFile, templatePatch(template, options.gateway), { mode: 0o600 })
        const base = options.env ?? Object.fromEntries(PASSED_ENV.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]]))
        harness = factory({
          profile: 'agent',
          patches: [patchFile],
          helmgearHome: home,
          cwd: join(home, 'work'),
          provider: options.model.provider,
          model: options.model.model,
          reasoningEffort: template.reasoningEffort as NonNullable<HelmgearOptions['reasoningEffort']>,
          env: { ...base, HELMGEAR_GATEWAY_TOKEN: token },
        })
        const timeoutMs = options.timeoutMs ?? 300_000
        const result = await Promise.race([
          harness.run(request, { sessionId }),
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(() => reject(new RunnerError('HARNESS_TIMEOUT', `run exceeded ${timeoutMs} ms`)), timeoutMs)
          }),
        ])
        if (result.finishReason === 'error') {
          return { status: 'failed', template: template.name, sessionId, reason: turnError(result), pendingActionIds: pendingActionIds() }
        }
        return { status: 'done', template: template.name, sessionId, response: result.finalResponse, pendingActionIds: pendingActionIds() }
      } catch (error) {
        if (error instanceof TransportClosedError) throw new RunnerError('HARNESS_EXITED', error.message)
        if (error instanceof RequestTimeoutError) throw new RunnerError('HARNESS_TIMEOUT', error.message)
        throw error
      } finally {
        clearTimeout(deadline)
        // Closing ends the process, which is also what stops a run that hit its deadline.
        await harness?.close().catch(() => {})
        options.gateway.revoke(token)
        rmSync(patchFile, { force: true })
      }
    },
  }
}
