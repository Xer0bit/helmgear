import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Ajv, type ValidateFunction } from 'ajv'
import { type AuditLog, payloadSha256 } from './audit.ts'
import type { CallContext, CallResult, Connector, PendingRequest, ToolDef } from './registry.ts'

const SAFE_KEY = /^[A-Za-z0-9_-]{1,128}$/

export interface ExecutorOptions {
  connectors: Connector[]
  audit: AuditLog
  stateDir: string
  /** Where `send` actions wait for approval. */
  queue: { enqueue(action: PendingRequest): void }
}

/** Runs tool calls by risk tier: `read` and `draft` at once, `send` only through the approval queue. */
export class Executor {
  private readonly tools = new Map<string, { def: ToolDef; validate: ValidateFunction }>()
  private readonly inFlight = new Map<string, Promise<CallResult>>()
  private readonly resultsDir: string

  constructor(private readonly options: ExecutorOptions) {
    const ajv = new Ajv({ allErrors: true, strict: false })
    for (const connector of options.connectors) {
      for (const def of connector.tools) {
        if (!def.name.startsWith(`${connector.name}.`)) throw new Error(`tool ${def.name} must be named ${connector.name}.<action>`)
        if (this.tools.has(def.name)) throw new Error(`duplicate tool: ${def.name}`)
        this.tools.set(def.name, { def, validate: ajv.compile(def.inputSchema) })
      }
    }
    this.resultsDir = join(options.stateDir, 'results')
    mkdirSync(this.resultsDir, { recursive: true })
  }

  /** The tool definition, for the approval queue to run an approved action. */
  tool(name: string): ToolDef | undefined { return this.tools.get(name)?.def }

  /**
   * One tool call. The same `idempotencyKey` returns the first result without
   * running the tool again; a failed run is not cached, so it can be retried.
   */
  call(tool: string, input: Record<string, unknown>, ctx: CallContext, idempotencyKey: string): Promise<CallResult> {
    if (!SAFE_KEY.test(idempotencyKey)) return Promise.reject(new Error('idempotency key must match [A-Za-z0-9_-]{1,128}'))
    const running = this.inFlight.get(idempotencyKey)
    if (running) return running
    const promise = this.callOnce(tool, input, ctx, idempotencyKey).finally(() => this.inFlight.delete(idempotencyKey))
    this.inFlight.set(idempotencyKey, promise)
    return promise
  }

  private async callOnce(tool: string, input: Record<string, unknown>, ctx: CallContext, key: string): Promise<CallResult> {
    const cacheFile = join(this.resultsDir, `${key}.json`)
    if (existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, 'utf8')) as CallResult

    const entry = this.tools.get(tool)
    const hash = payloadSha256(tool, input)
    const record = { ...ctx, tool, tier: entry?.def.tier ?? 'read', actionId: key, payloadSha256: hash } as const
    const refuse = (reason: string): CallResult => {
      this.options.audit.append({ ...record, event: 'refused', detail: reason })
      return { status: 'refused', reason }
    }
    if (!entry) return refuse(`unknown tool: ${tool}`)
    if (ctx.connectors && !ctx.connectors.includes(tool.split('.')[0]!)) return refuse(`tool not available to this template: ${tool}`)
    if (!entry.validate(input)) {
      return refuse(`invalid input: ${(entry.validate.errors ?? []).map(e => `${e.instancePath || '/'} ${e.message}`).join('; ')}`)
    }

    let result: CallResult
    if (entry.def.tier === 'send') {
      this.options.queue.enqueue({ actionId: key, tool, input, payloadSha256: hash, ctx })
      this.options.audit.append({ ...record, event: 'pending' })
      result = { status: 'pending', actionId: key }
    } else {
      try {
        result = { status: 'ok', result: await entry.def.run(input, ctx) }
      } catch (error) {
        this.options.audit.append({ ...record, event: 'failed', detail: error instanceof Error ? error.message : String(error) })
        throw error
      }
      this.options.audit.append({ ...record, event: 'executed' })
    }
    writeFileSync(`${cacheFile}.tmp`, JSON.stringify(result), { mode: 0o600 })
    renameSync(`${cacheFile}.tmp`, cacheFile)
    return result
  }
}
