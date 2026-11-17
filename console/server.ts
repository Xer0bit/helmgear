// The Helmgear test console: a local page for trying agents by hand.
//
//   pnpm console            then open http://127.0.0.1:4317
//
// It binds 127.0.0.1 only and is for one person testing on their own machine.
// "Send" writes a file under tmp/console/outbox; nothing leaves the machine.
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createCore, MemoryStore, startGateway } from '@helmgear/gateway'
import { jevClassifier, jevJudge, route, type Classifier } from '@helmgear/router'
import { createRunner } from '@helmgear/runner'
import { loadTemplates, type ReasoningEffort } from '@helmgear/template'
import { connect } from './connectors.ts'

const PORT = Number(process.env.PORT ?? 4317)
const TENANT = 'console'
const stateDir = 'tmp/console'
const MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro']
const EFFORTS = ['off', 'low', 'high', 'max']
const firecrawlUrl = (process.env.FIRECRAWL_URL ?? 'http://127.0.0.1:3002').replace(/\/+$/, '')

const memory = new MemoryStore(`${stateDir}/memory`)
const connected = await connect(stateDir, memory)
const connectors = connected.connectors
const core = createCore({ connectors, stateDir, memory })
const gateway = await startGateway({ executor: core.executor, connectors })
const jevKey = process.env.TYPESAFE_API_KEY ?? ''
const classifier = jevClassifier({ apiKey: jevKey })
const judge = jevKey ? jevJudge({ apiKey: jevKey }) : undefined

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(body))
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = ''
  for await (const chunk of req) {
    text += chunk
    if (text.length > 200_000) throw new Error('request body too large')
  }
  const parsed: unknown = text ? JSON.parse(text) : {}
  if (typeof parsed !== 'object' || parsed === null) throw new Error('expected a JSON object')
  return parsed as Record<string, unknown>
}

async function state(): Promise<unknown> {
  const firecrawl = await fetch(firecrawlUrl, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false)
  return {
    templates: loadTemplates('templates').map(({ name, description, connectors: allowed, dataClass, reasoningEffort }) => ({ name, description, connectors: allowed, dataClass, reasoningEffort })),
    models: MODELS,
    efforts: EFFORTS,
    pending: core.approvals.list(TENANT).map(({ actionId, tool, input, ctx, createdAt }) => ({ actionId, tool, input, template: ctx.template, sessionId: ctx.sessionId, createdAt })),
    memory: memory.list(TENANT),
    audit: core.audit.read().slice(-150).reverse(),
    health: { modelKey: Boolean(process.env.DEEPSEEK_API_KEY), jevKey: Boolean(jevKey), firecrawl, firecrawlUrl },
  }
}

/** One run, streamed as server-sent events: routing, each tool call as it is recorded, then the result. */
async function run(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const input = await body(req)
  const request = String(input.request ?? '').trim()
  const model = MODELS.includes(String(input.model)) ? String(input.model) : MODELS[0]!
  const effort = EFFORTS.includes(String(input.reasoningEffort)) ? String(input.reasoningEffort) as ReasoningEffort : undefined
  let template = typeof input.template === 'string' && input.template !== 'auto' ? input.template : undefined
  if (!request) { send(res, 400, { error: 'Type a request first.' }); return }

  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' })
  const emit = (event: string, data: unknown): void => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
  const started = Date.now()
  let watch: NodeJS.Timeout | undefined
  try {
    const templates = loadTemplates('templates')
    if (!template) {
      // Ask Jev once, show every score, then let the router's thresholds decide from that same answer.
      const t = Date.now()
      let answer: Awaited<ReturnType<Classifier['classify']>> | undefined
      const once: Classifier = { classify: async (question) => { answer = await classifier.classify(question); return answer } }
      const routed = await route(request, templates, once)
      emit('routed', {
        ms: Date.now() - t,
        template: routed.kind === 'template' ? routed.template.name : null,
        reason: routed.kind === 'none' ? [routed.reason, routed.detail].filter(Boolean).join(': ') : null,
        scores: answer?.choices.sort((a, b) => b.probability - a.probability) ?? [],
        noneFits: answer?.noneFits ?? null,
      })
      if (routed.kind === 'none') { emit('result', { status: 'no-template', reason: routed.reason, seconds: (Date.now() - started) / 1000 }); return }
      template = routed.template.name
    } else {
      emit('routed', { ms: 0, template, reason: null, scores: [], noneFits: null, chosenByYou: true })
    }

    const runner = createRunner({
      templatesDir: 'templates', stateDir,
      gateway: { ...gateway, approvals: core.approvals, audit: core.audit },
      classifier, model: { provider: 'deepseek-official', model }, memory,
      ...(judge ? { judge } : {}),
    })
    let seen = 0
    const flush = (sessionId: string): void => {
      const mine = core.audit.read().filter(entry => entry.sessionId === sessionId)
      for (const entry of mine.slice(seen)) emit('action', { tool: entry.tool, event: entry.event, detail: entry.detail ?? null, at: entry.at })
      seen = mine.length
    }
    let session = ''
    const result = await runner.runTask({
      tenant: TENANT, request, template, ...(effort ? { reasoningEffort: effort } : {}),
      onStart: ({ sessionId }) => {
        session = sessionId
        emit('started', { sessionId, model, reasoningEffort: effort ?? templates.find(t => t.name === template)?.reasoningEffort })
        // The audit log is the record of what the agent does; new lines for this session are its live tool calls.
        watch = setInterval(() => flush(sessionId), 250)
      },
    })
    if (session) flush(session)
    emit('result', { ...result, seconds: (Date.now() - started) / 1000 })
  } catch (error) {
    emit('result', { status: 'error', reason: error instanceof Error ? error.message : String(error), seconds: (Date.now() - started) / 1000 })
  } finally {
    clearInterval(watch)
    res.end()
  }
}

const http = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  // A page on another site must not be able to drive this console through the browser.
  const origin = req.headers.origin
  if (origin && origin !== `http://127.0.0.1:${PORT}` && origin !== `http://localhost:${PORT}`) { send(res, 403, { error: 'wrong origin' }); return }
  const handle = async (): Promise<void> => {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(readFileSync(new URL('./index.html', import.meta.url)))
    } else if (req.method === 'GET' && url.pathname === '/api/state') {
      send(res, 200, await state())
    } else if (req.method === 'POST' && url.pathname === '/api/run') {
      await run(req, res)
    } else if (req.method === 'POST' && url.pathname === '/api/approve') {
      const { id } = await body(req)
      send(res, 200, await core.approvals.approve(String(id), 'console'))
    } else if (req.method === 'POST' && url.pathname === '/api/reject') {
      const { id, reason } = await body(req)
      const why = typeof reason === 'string' && reason.trim() ? reason : undefined
      core.approvals.reject(String(id), 'console', why)
      send(res, 200, { status: 'rejected', lesson: Boolean(why) })
    } else if (req.method === 'POST' && url.pathname === '/api/memory') {
      const { text, template } = await body(req)
      send(res, 200, memory.add(TENANT, { kind: 'fact', source: 'person', text: String(text ?? ''), ...(typeof template === 'string' && template ? { template } : {}) }))
    } else if (req.method === 'POST' && url.pathname === '/api/memory/remove') {
      const { id } = await body(req)
      memory.remove(TENANT, String(id))
      send(res, 200, { status: 'removed' })
    } else {
      send(res, 404, { error: 'not found' })
    }
  }
  handle().catch((error: unknown) => {
    if (!res.headersSent) send(res, 400, { error: error instanceof Error ? error.message : String(error) })
    else res.end()
  })
})

http.listen(PORT, '127.0.0.1', () => {
  console.log(`Helmgear console: http://127.0.0.1:${PORT}`)
  if (!process.env.DEEPSEEK_API_KEY) console.log('  DEEPSEEK_API_KEY is missing from .env: agents cannot run.')
  if (!jevKey) console.log('  TYPESAFE_API_KEY is missing from .env: pick an agent by hand; replies are not verified.')
  console.log('  Stop with Ctrl-C.')
})
