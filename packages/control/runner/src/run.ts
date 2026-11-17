import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ApprovalQueue, AuditLog, MemoryStore } from '@helmgear/gateway'
import { route, type Classifier, type Judge } from '@helmgear/router'
import { Helmgear, RequestTimeoutError, TransportClosedError, type HelmgearOptions, type RunResult } from '@helmgear/sdk-client'
import { loadTemplates, type ReasoningEffort } from '@helmgear/template'
import { templatePatch, type ToolInfo } from './patch.ts'
import { verifyReply, type ActionFact } from './verify.ts'

/** The part of the harness client the runner uses. */
export interface HarnessLike {
  run(request: string, options: { sessionId: string }): Promise<RunResult>
  close(): Promise<void>
  /** Open a session an earlier process started, so the next `run` continues it. */
  resume?(sessionId: string): Promise<void>
}

export interface RunnerOptions {
  templatesDir: string
  /** `<stateDir>/tenants/<tenant>` is that tenant's harness home. */
  stateDir: string
  gateway: {
    url: string
    /** Mint a token the gateway ties to exactly this run; see `startGateway`. */
    grant(ctx: { tenant: string; sessionId: string; template: string; connectors: string[]; maxToolCalls?: number }): string
    revoke(token: string): void
    approvals: Pick<ApprovalQueue, 'list'>
    /** The record of what each session actually did; replies are checked against it. */
    audit: Pick<AuditLog, 'read'>
    /** The tools a grant for these connectors would see; they are listed in the agent's instructions. */
    describe?(connectors: string[]): ToolInfo[]
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
  /**
   * How the repair turn runs when a reply fails its check: in a new process with this reasoning effort
   * that resumes the session. Default `{ reasoningEffort: 'high' }`; `false` repairs in the same process.
   */
  escalate?: { reasoningEffort: ReasoningEffort } | false
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
  /** Model tokens used by every turn of this run. */
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number }
}

export type TaskResult =
  | ({ status: 'done'; template: string; sessionId: string; response: string; pendingActionIds: string[] } & Checked)
  | ({ status: 'failed'; template: string; sessionId: string; reason: string; pendingActionIds: string[] } & Checked)
  | { status: 'plan'; template: string; sessionId: string; plan: string; usage: Checked['usage'] }
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
const SESSION = /^[A-Za-z0-9_-]{1,128}$/
const PLAN_REQUEST = 'Do not act yet and do not call any tool. Write a short plan for the request below, in plain language without tool names: the few steps you will take, what you will hand back, any assumption you are making, and at most one question if the task cannot be done without an answer. Keep it under 90 words.\n\nRequest: '
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

export interface TaskInput {
  tenant: string
  request: string
  /** Name a template to skip routing. */
  template?: string
  /** Use this reasoning effort for this task instead of the template's. */
  reasoningEffort?: ReasoningEffort
  /**
   * `plan`: the agent gets no tools and only writes what it would do; nothing is acted on.
   * Continue the returned session to carry the plan out. Default `act`.
   */
  mode?: 'plan' | 'act'
  /** Continue an earlier session of this tenant instead of starting a new one. Needs `template`. */
  continue?: { sessionId: string }
  /** Called once the agent is about to start, before its first tool call. */
  onStart?: (info: { sessionId: string; template: string }) => void
}

export function createRunner(options: RunnerOptions): { runTask(input: TaskInput): Promise<TaskResult> } {
  const factory = options.harnessFactory ?? ((harnessOptions): HarnessLike => {
    const client = new Helmgear(harnessOptions)
    return {
      run: (request, runOptions) => client.run(request, runOptions),
      close: () => client.close(),
      resume: async (sessionId) => { await client.resumeSession(sessionId) },
    }
  })

  return {
    async runTask({ tenant, request, template: named, reasoningEffort, onStart, mode, continue: earlier }) {
      if (!TENANT.test(tenant)) return { status: 'refused', reason: 'tenant must match [a-z0-9][a-z0-9_-]{0,63}' }
      if (earlier && !SESSION.test(earlier.sessionId)) return { status: 'refused', reason: 'session id is not valid' }
      if (earlier && named === undefined) return { status: 'refused', reason: 'continuing a session needs its template' }
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
      const sessionId = earlier?.sessionId ?? `session-${randomUUID().replaceAll('-', '')}`
      const planning = mode === 'plan'
      mkdirSync(join(home, 'work'), { recursive: true })
      const patchFile = join(home, `${sessionId}.patch.yml`)
      // While planning the agent holds a token that opens no connector, so a plan cannot act.
      const token = options.gateway.grant({ tenant, sessionId, template: template.name, connectors: planning ? [] : template.connectors, maxToolCalls: template.maxToolCalls })
      const pendingActionIds = (): string[] =>
        options.gateway.approvals.list(tenant).filter(action => action.ctx.sessionId === sessionId).map(action => action.actionId)
      let harness: HarnessLike | undefined
      let deadline: NodeJS.Timeout | undefined
      try {
        writeFileSync(patchFile, templatePatch(template, options.gateway, {
          memory: options.memory?.render(tenant, template.name),
          tools: options.gateway.describe?.(template.connectors),
          planning,
        }), { mode: 0o600 })
        const base = options.env ?? Object.fromEntries(PASSED_ENV.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]]))
        const start = (effort: ReasoningEffort): HarnessLike => factory({
          profile: 'agent',
          patches: [patchFile],
          helmgearHome: home,
          cwd: join(home, 'work'),
          provider: options.model.provider,
          model: options.model.model,
          reasoningEffort: effort as NonNullable<HelmgearOptions['reasoningEffort']>,
          env: { ...base, HELMGEAR_GATEWAY_TOKEN: token },
        })
        harness = start(reasoningEffort ?? template.reasoningEffort)
        if (earlier) {
          if (!harness.resume) return { status: 'refused', reason: 'this harness cannot continue a session' }
          await harness.resume(sessionId)
        }
        onStart?.({ sessionId, template: template.name })
        const timeoutMs = options.timeoutMs ?? 300_000
        const expired = new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new RunnerError('HARNESS_TIMEOUT', `run exceeded ${timeoutMs} ms`)), timeoutMs)
        })
        const turn = (text: string): Promise<RunResult> => Promise.race([harness!.run(text, { sessionId }), expired])
        const actions = (): ActionFact[] => options.gateway.audit.read()
          .filter(entry => entry.sessionId === sessionId)
          .map(entry => ({ tool: entry.tool, event: entry.event as ActionFact['event'], actionId: entry.actionId }))

        const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }
        const count = (turnResult: RunResult): RunResult => {
          for (const event of turnResult.events as { type: string; data?: { usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } } }[]) {
            if (event.type !== 'assistant/message') continue
            usage.inputTokens += event.data?.usage?.inputTokens ?? 0
            usage.outputTokens += event.data?.usage?.outputTokens ?? 0
            usage.cachedInputTokens += event.data?.usage?.cacheReadTokens ?? 0
          }
          return turnResult
        }
        let result = count(await turn(planning ? PLAN_REQUEST + request : request))
        if (result.finishReason === 'error') {
          return { status: 'failed', template: template.name, sessionId, reason: turnError(result), pendingActionIds: pendingActionIds(), actions: actions(), verified: false, problems: [], usage }
        }
        if (planning) return { status: 'plan', template: template.name, sessionId, plan: result.finalResponse, usage }
        let check = options.judge
          ? await verifyReply(result.finalResponse, actions(), options.judge)
          : { verified: false, problems: ['not verified: no judge configured'], needsAction: false }
        if (options.judge && !check.verified && (options.repair ?? true)) {
          // One chance to make the reply true. If only the wording is wrong, calling a tool again
          // could queue a second, slightly different send, so the agent is told not to.
          const fix = check.needsAction
            ? 'If you meant to act, make the tool call now.'
            : 'Do not call any tool.'
          // The repair is the step that matters, so it gets more thinking: a new process with a higher
          // reasoning effort resumes the same session. One session, one process at a time.
          const escalate = options.escalate ?? { reasoningEffort: 'high' as const }
          if (escalate && harness.resume) {
            await harness.close().catch(() => {})
            harness = start(escalate.reasoningEffort)
            await harness.resume!(sessionId)
          }
          const repaired = count(await turn(`Your reply does not match what you did: ${check.problems.join('; ')}. ${fix} Then give a corrected reply that states only what actually happened.`))
          if (repaired.finishReason !== 'error') {
            result = repaired
            check = await verifyReply(result.finalResponse, actions(), options.judge)
          }
        }
        return {
          status: 'done', template: template.name, sessionId, response: result.finalResponse, pendingActionIds: pendingActionIds(),
          actions: actions(), verified: check.verified, problems: check.problems, usage,
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
