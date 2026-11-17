import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ApprovalQueue, AuditLog, MemoryStore } from '@helmgear/gateway'
import { route, type Classifier, type Judge } from '@helmgear/router'
import { Helmgear, RequestTimeoutError, TransportClosedError, type HelmgearOptions, type RunResult } from '@helmgear/sdk-client'
import { loadTemplates } from '@helmgear/template'
import { templatePatch } from './patch.ts'
import { verifyReply, type ActionFact } from './verify.ts'

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
    /** The record of what each session actually did; replies are checked against it. */
    audit: Pick<AuditLog, 'read'>
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
  /** What this tenant's agents know between runs; rendered into the persona. */
  memory?: Pick<MemoryStore, 'render'>
  /** Reads each reply so it can be checked against the audit log. Without one, results are returned unverified. */
  judge?: Judge
  /** Give the agent one turn to fix a reply that does not match what it did. Default true when `judge` is set. */
  repair?: boolean
  /** Test seam: build the harness client. */
  harnessFactory?: (options: HelmgearOptions) => HarnessLike
}

/** What the gateway recorded for the session, and whether the reply agrees with it. */
export interface Checked {
  /** This session's tool calls as the gateway recorded them, oldest first. Trust these over the reply. */
  actions: ActionFact[]
  /** True only when a judge read the reply and found no claim the record does not support. */
  verified: boolean
  problems: string[]
}

export type TaskResult =
  | ({ status: 'done'; template: string; sessionId: string; response: string; pendingActionIds: string[] } & Checked)
  | ({ status: 'failed'; template: string; sessionId: string; reason: string; pendingActionIds: string[] } & Checked)
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
        writeFileSync(patchFile, templatePatch(template, options.gateway, options.memory?.render(tenant, template.name)), { mode: 0o600 })
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
        const expired = new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new RunnerError('HARNESS_TIMEOUT', `run exceeded ${timeoutMs} ms`)), timeoutMs)
        })
        const turn = (text: string): Promise<RunResult> => Promise.race([harness!.run(text, { sessionId }), expired])
        const actions = (): ActionFact[] => options.gateway.audit.read()
          .filter(entry => entry.sessionId === sessionId)
          .map(entry => ({ tool: entry.tool, event: entry.event as ActionFact['event'], actionId: entry.actionId }))

        let result = await turn(request)
        if (result.finishReason === 'error') {
          return { status: 'failed', template: template.name, sessionId, reason: turnError(result), pendingActionIds: pendingActionIds(), actions: actions(), verified: false, problems: [] }
        }
        let check = options.judge
          ? await verifyReply(result.finalResponse, actions(), options.judge)
          : { verified: false, problems: ['not verified: no judge configured'], needsAction: false }
        if (options.judge && !check.verified && (options.repair ?? true)) {
          // One chance to make the reply true. If only the wording is wrong, calling a tool again
          // could queue a second, slightly different send, so the agent is told not to.
          const fix = check.needsAction
            ? 'If you meant to act, make the tool call now.'
            : 'Do not call any tool.'
          const repaired = await turn(`Your reply does not match what you did: ${check.problems.join('; ')}. ${fix} Then give a corrected reply that states only what actually happened.`)
          if (repaired.finishReason !== 'error') {
            result = repaired
            check = await verifyReply(result.finalResponse, actions(), options.judge)
          }
        }
        return {
          status: 'done', template: template.name, sessionId, response: result.finalResponse, pendingActionIds: pendingActionIds(),
          actions: actions(), verified: check.verified, problems: check.problems,
        }
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
