// The Helmgear console in your terminal: type a task, watch the agent work.
//
//   pnpm agent
//
// Each message is one task. You see which agent was picked, every tool call as
// the gateway records it, the reply, and whether the reply matches that record.
// Anything that would leave the machine is held until you /approve it.
// "Send" writes a file under tmp/console/outbox; nothing really goes out.
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { createInterface } from 'node:readline'
import { createCore, MemoryStore, startGateway, type PendingAction } from '@helmgear/gateway'
import { jevClassifier, jevJudge, route, type Classifier } from '@helmgear/router'
import { createRunner, modelHostFromEnv, type RunnerOptions, type TaskResult } from '@helmgear/runner'
import { loadTemplates, type ReasoningEffort } from '@helmgear/template'
import { EXTRACTABLE, extractText, KnowledgeBase, teiEmbedder, teiReranker } from '@helmgear/knowledge'
import { connect } from './connectors.ts'

const TENANT = 'console'
const stateDir = 'tmp/console'
// A second model host (any OpenAI-compatible server) becomes one more choice under /model.
const secondHost = modelHostFromEnv()
const hostModel = secondHost?.model
const MODELS = ['deepseek-flash', 'deepseek-v4-pro', ...(hostModel ? [hostModel] : [])]
const modelFor = (name: string): RunnerOptions['model'] => secondHost && name === hostModel ? secondHost : { provider: 'deepseek-official', model: name }
const EFFORTS: ReasoningEffort[] = ['off', 'low', 'high', 'max']
const firecrawlUrl = (process.env.FIRECRAWL_URL ?? 'http://127.0.0.1:3002').replace(/\/+$/, '')

// ---- terminal output
const tty = process.stdout.isTTY === true && !process.env.NO_COLOR
const paint = (code: string) => (text: string): string => tty ? `\x1b[${code}m${text}\x1b[0m` : text
const bold = paint('1'), dim = paint('2'), green = paint('32'), yellow = paint('33'), red = paint('31'), cyan = paint('36'), blue = paint('34')
const say = (text = ''): void => { process.stdout.write(`${text}\n`) }

/** Model replies are Markdown; show the common parts as terminal styling. */
function render(markdown: string): string {
  return markdown.split('\n').map((line) => {
    const styled = line
      .replace(/\*\*([^*]+)\*\*/g, (_m, text: string) => bold(text))
      .replace(/`([^`]+)`/g, (_m, text: string) => cyan(text))
    if (/^#{1,6}\s/.test(line)) return bold(line.replace(/^#+\s*/, ''))
    if (/^>\s?/.test(line)) return `${dim('│')} ${styled.replace(/^>\s?/, '')}`
    return styled
  }).map(line => `  ${line}`).join('\n')
}

let spinner: NodeJS.Timeout | undefined
function working(label: string): void {
  stopWorking()
  if (!tty) return
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  const started = Date.now()
  let i = 0
  spinner = setInterval(() => { process.stdout.write(`\r\x1b[2K${blue(frames[i++ % frames.length]!)} ${dim(`${label} ${((Date.now() - started) / 1000).toFixed(0)}s`)}`) }, 90)
}
function stopWorking(): void {
  if (!spinner) return
  clearInterval(spinner)
  spinner = undefined
  process.stdout.write('\r\x1b[2K')
}
/** Print a line of the run's record without tearing the spinner. */
function step(mark: string, text: string): void {
  const label = spinner ? 'working' : undefined
  stopWorking()
  say(`${mark} ${text}`)
  if (label) working(label)
}

// ---- the system under test
const memory = new MemoryStore(`${stateDir}/memory`)
const kb = new KnowledgeBase({ dir: `${stateDir}/kb`, ...(process.env.HELMGEAR_EMBEDDINGS_URL ? { embedder: teiEmbedder({ url: process.env.HELMGEAR_EMBEDDINGS_URL, ...(process.env.HELMGEAR_EMBEDDINGS_QUERY_PREFIX ? { queryPrefix: process.env.HELMGEAR_EMBEDDINGS_QUERY_PREFIX } : {}) }) } : {}), ...(process.env.HELMGEAR_RERANKER_URL ? { reranker: teiReranker({ url: process.env.HELMGEAR_RERANKER_URL }) } : {}) })
const connected = await connect(stateDir, memory, kb)
const connectors = connected.connectors
const core = createCore({ connectors, stateDir, memory })
const gateway = await startGateway({ executor: core.executor, connectors })
const jevKey = process.env.TYPESAFE_API_KEY ?? ''
const classifier = jevClassifier({ apiKey: jevKey })
const judge = jevKey ? jevJudge({ apiKey: jevKey }) : undefined

const settings: { agent: string; model: string; thinking: ReasoningEffort | 'agent'; plan: boolean } = { agent: 'auto', model: MODELS[0]!, thinking: 'agent', plan: true }
/** The session the conversation is in. A follow-up resumes it, so the agent remembers what was said and done. */
let thread: { sessionId: string; template: string } | undefined
/** A plan the agent proposed and is waiting to hear about. */
let pendingPlan: { sessionId: string; template: string } | undefined

const TOOL_WORDS: Record<string, string> = {
  'firecrawl.search': 'Searched the web', 'firecrawl.scrape': 'Read a web page', 'outbox.draft': 'Saved a draft',
  'outbox.send': 'Asked to send', 'memory.propose': 'Proposed something to remember',
  'firecrawl.research': 'Researched the web', 'kb.search': 'Searched the knowledge base', 'kb.read': 'Read a knowledge-base document', 'email.send': 'Asked to send an email', 'x.post': 'Asked to post on X',
}
const waiting = (): PendingAction[] => core.approvals.list(TENANT)

function showWaiting(only?: string[]): void {
  const list = waiting()
  const shown = list.filter(action => !only || only.includes(action.actionId))
  if (shown.length === 0) { if (!only) say(dim('  Nothing is waiting for approval.')); return }
  for (const action of shown) {
    const n = list.indexOf(action) + 1
    say(`\n${yellow(`■ Held for you [${n}]`)} ${bold(action.tool)} ${dim(`from ${action.ctx.template}`)}`)
    // The agent had read outside content before asking: a page or document could have put the idea there.
    if (action.untrustedSources?.length) say(`    ${yellow('!')} ${yellow(`The agent read outside content first (${action.untrustedSources.join(', ')}).`)} ${dim('Check this is what you asked for, not what a page asked for.')}`)
    for (const [key, value] of Object.entries(action.input)) {
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      say(`    ${dim(`${key}:`.padEnd(9))}${text.split('\n').join(`\n    ${' '.repeat(9)}`)}`)
    }
  }
  say(dim(`\n  /approve <number|all>   /reject <number> <reason>   (a reason becomes a lesson for that agent)`))
}

/** Run one message. `approved` means: carry out the plan the agent proposed last. */
async function runTask(request: string, approved = false): Promise<void> {
  const templates = loadTemplates('templates')
  const started = Date.now()
  let template: string | undefined
  let continuing: string | undefined

  if (pendingPlan) {
    // Either the go-ahead for the plan, or changes to it: both continue the planning session.
    template = pendingPlan.template
    continuing = pendingPlan.sessionId
    say(`${green('●')} ${approved ? 'Carrying out the plan with' : 'Revising the plan with'} ${bold(template)}`)
  } else if (settings.agent !== 'auto') {
    template = settings.agent
    if (thread?.template === template) continuing = thread.sessionId
    say(`${green('●')} Using ${bold(template)} ${dim(continuing ? '(you chose it; same conversation)' : '(you chose it)')}`)
  } else {
    working('choosing an agent')
    const t = Date.now()
    let answer: Awaited<ReturnType<Classifier['classify']>> | undefined
    const once: Classifier = { classify: async (question) => { answer = await classifier.classify(question); return answer } }
    const routed = await route(request, templates, once)
    stopWorking()
    const scores = (answer?.choices ?? []).sort((x, y) => y.probability - x.probability).slice(0, 3).map(c => `${c.label} ${c.probability.toFixed(2)}`).join(', ')
    if (routed.kind === 'template') {
      template = routed.template.name
      if (thread?.template === template) continuing = thread.sessionId
      say(`${green('●')} Jev chose ${bold(template)} ${dim(`in ${Date.now() - t} ms (${scores})${continuing ? ', same conversation' : ''}`)}`)
    } else if (thread && routed.reason !== 'classifier-error') {
      // A follow-up such as "make it shorter" names no task of its own; it belongs to the agent already in the conversation.
      template = thread.template
      continuing = thread.sessionId
      say(`${green('●')} Continuing with ${bold(template)} ${dim('(the message reads as a follow-up)')}`)
    } else {
      say(`${red('●')} No agent fits this request ${dim(`(${routed.reason}${routed.detail ? `: ${routed.detail}` : ''}${scores ? `; ${scores}` : ''})`)}`)
      say(dim('  Pick one yourself with /agent <name> if you want to try anyway.'))
      return
    }
  }
  const planning = settings.plan && !approved

  const runner = createRunner({
    templatesDir: 'templates', stateDir,
    gateway: { ...gateway, approvals: core.approvals, audit: core.audit },
    classifier, model: modelFor(settings.model), memory,
    ...(judge ? { judge } : {}),
  })
  let seen = continuing ? core.audit.read().filter(entry => entry.sessionId === continuing).length : 0
  let watch: NodeJS.Timeout | undefined
  let session = ''
  const flush = (): void => {
    const mine = core.audit.read().filter(entry => entry.sessionId === session)
    for (const entry of mine.slice(seen)) {
      const name = TOOL_WORDS[entry.tool] ?? 'Used a tool'
      if (entry.event === 'executed') step(green('●'), `${name} ${dim(entry.tool)}`)
      else if (entry.event === 'pending') step(yellow('■'), `${name} ${dim(entry.tool)} ${yellow('held for your approval')}`)
      else if (['approved', 'rejected'].includes(entry.event)) continue
      else step(red('●'), `${name} ${dim(entry.tool)} ${red(entry.event)}${entry.detail ? dim(`: ${entry.detail}`) : ''}`)
    }
    seen = mine.length
  }
  let result: TaskResult | { status: 'error'; reason: string }
  try {
    result = await runner.runTask({
      tenant: TENANT, template,
      request: approved ? 'Approved. Carry out the plan now.' : request,
      mode: planning ? 'plan' : 'act',
      ...(continuing ? { continue: { sessionId: continuing } } : {}),
      ...(settings.thinking === 'agent' ? {} : { reasoningEffort: settings.thinking }),
      onStart: ({ sessionId }) => {
        session = sessionId
        const thinking = settings.thinking === 'agent' ? templates.find(t => t.name === template)?.reasoningEffort : settings.thinking
        say(`${green('●')} ${planning ? 'Planning' : 'Agent started'} ${dim(`on ${settings.model}, thinking ${thinking}`)}`)
        working(planning ? 'planning' : 'working')
        watch = setInterval(flush, 250)
      },
    })
  } catch (error) {
    result = { status: 'error', reason: error instanceof Error ? error.message : String(error) }
  }
  clearInterval(watch)
  if (session) flush()
  stopWorking()

  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  const count = (usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number }): string => (usage.inputTokens + usage.cachedInputTokens + usage.outputTokens).toLocaleString()
  if (result.status === 'plan') {
    pendingPlan = { sessionId: result.sessionId, template: result.template }
    say(`
${bold('  Plan')}
${render(result.plan || '(empty plan)')}
`)
    say(dim(`  ${result.template}, ${seconds} s, ${count(result.usage)} tokens`))
    say(`  ${yellow('Nothing has been done yet.')} ${dim('Press Enter (or type go) to carry it out, type changes to revise it, or /cancel.')}`)
  } else if (result.status === 'done') {
    pendingPlan = undefined
    thread = { sessionId: result.sessionId, template: result.template }
    say(`
${render(result.response || '(empty reply)')}
`)
    if (result.verified) say(`${green('✓ Checked')} ${dim('the reply claims nothing the record does not show.')}`)
    else if (result.problems.some(problem => problem.startsWith('not verified'))) say(`${yellow('? Not checked')} ${dim('no Jev key, so the reply was not compared with the record.')}`)
    else say(`${red('✗ The reply does not match what the agent did:')}\n${result.problems.map(problem => `    ${problem}`).join('\n')}`)
    // Written from the gateway's record, not from the reply.
    say(dim(result.report.split('\n').map(line => `  ${line}`).join('\n')))
    say(dim(`  ${result.template}, ${seconds} s, ${count(result.usage)} tokens${result.usage.cachedInputTokens ? ` (${Math.round(100 * result.usage.cachedInputTokens / (result.usage.inputTokens + result.usage.cachedInputTokens))}% of input from cache)` : ''}`))
    showWaiting(result.pendingActionIds)
  } else {
    pendingPlan = undefined
    if (result.status === 'refused') say(`${red('●')} Refused before starting: ${result.reason}`)
    else if (result.status === 'no-template') say(`${red('●')} No agent fits: ${result.reason}`)
    else say(`${red('●')} ${result.status === 'failed' ? 'The agent stopped with an error' : 'Something went wrong'}: ${result.reason} ${dim(`(${seconds} s)`)}`)
  }
}

// ---- commands
function pick(argument: string): PendingAction[] {
  const list = waiting()
  if (argument === 'all') return list
  const action = list[Number(argument) - 1]
  if (!action) throw new Error(`There is no held action "${argument}". /pending lists them.`)
  return [action]
}

const HELP = `
  Type a task and press Enter. Each message is one task for one agent.

  ${bold('/agent')} [name|auto]      choose who handles requests (no name: list them)
  ${bold('/model')} [name]           ${MODELS.join(' or ')}
  ${bold('/think')} [level]          off, low, high, max, or agent (each agent's own setting)
  ${bold('/plan')} [on|off]          on: the agent shows a plan and waits for your go-ahead before acting
  ${bold('/cancel')}                 drop the plan that is waiting
  ${bold('/pending')}                actions held for your approval
  ${bold('/approve')} <n|all>        let a held action go ahead
  ${bold('/reject')} <n> [reason]    stop it; the reason becomes a lesson for that agent
  ${bold('/memory')}                 what the agents know about the business; /memory edit <n> <new text> corrects one
  ${bold('/remember')} <fact>        add a fact (end with --days 30 to make it expire)      ${bold('/forget')} <n>   remove one
  ${bold('/kb')}                     the knowledge base: /kb add <file or URL> [title], /kb list, /kb remove <n>, /kb search <question>
  ${bold('/record')}                 the gateway's latest decisions
  ${bold('/status')}                 connections and current settings
  ${bold('/new')}                    start a fresh conversation
  ${bold('/quit')}
`

async function status(): Promise<void> {
  const firecrawl = await fetch(firecrawlUrl, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false)
  say(`  ${process.env.DEEPSEEK_API_KEY ? green('✓') : red('✗')} model key   ${jevKey ? green('✓') : red('✗')} Jev key   ${firecrawl ? green('✓') : red('✗')} Firecrawl`)
  if (!process.env.DEEPSEEK_API_KEY) say(red('  No DEEPSEEK_API_KEY in .env: agents cannot run.'))
  if (!jevKey) say(yellow('  No TYPESAFE_API_KEY in .env: choose an agent with /agent; replies are not checked.'))
  if (!firecrawl) say(yellow(`  Firecrawl is not answering at ${firecrawlUrl}: web tools will fail. Start it with: bash scripts/firecrawl-up.sh`))
  for (const line of connected.lines) say(`  ${line.startsWith('on') ? green('on ') : dim('off')} ${line.startsWith('on') ? line.slice(5) : dim(line.slice(5))}`)
  say(dim(`  agent: ${settings.agent}   model: ${settings.model}   thinking: ${settings.thinking}   plan first: ${settings.plan ? 'on' : 'off'}   waiting: ${waiting().length}`))
}

async function command(line: string): Promise<boolean> {
  const [name, ...rest] = line.slice(1).trim().split(/\s+/)
  const argument = rest.join(' ')
  const templates = loadTemplates('templates')
  switch (name) {
    case 'help': say(HELP); break
    case 'quit': case 'exit': case 'q': return false
    case 'status': await status(); break
    case 'new': thread = undefined; pendingPlan = undefined; say(dim('  Fresh conversation.')); break
    case 'cancel': say(dim(pendingPlan ? '  Plan dropped. Nothing was done.' : '  No plan is waiting.')); pendingPlan = undefined; break
    case 'plan':
      if (argument === 'on' || argument === 'off') { settings.plan = argument === 'on'; say(dim(`  Plan first: ${argument}`)) }
      else say(`  ${settings.plan ? `${bold('on')}   off` : `on   ${bold('off')}`}`)
      break
    case 'agent':
      if (!argument) {
        say(`  ${settings.agent === 'auto' ? green('●') : ' '} ${bold('auto')} ${dim('Jev picks, or says none fits')}`)
        for (const t of templates) say(`  ${settings.agent === t.name ? green('●') : ' '} ${bold(t.name)} ${dim(`${t.description} [${t.connectors.join(', ') || 'no tools'}]${t.dataClass === 'sensitive' ? (hostModel ? ` sensitive: runs only on ${hostModel}, pick it with /model` : ' sensitive: needs a second model host, see MODEL_HOST_URL in .env.example') : ''}`)}`)
      } else if (argument === 'auto' || templates.some(t => t.name === argument)) { settings.agent = argument; say(dim(`  Requests go to: ${argument}`)) }
      else say(red(`  No agent called "${argument}". /agent lists them.`))
      break
    case 'model':
      if (MODELS.includes(argument)) { settings.model = argument; say(dim(`  Model: ${argument}`)) }
      else say(`  ${MODELS.map(m => m === settings.model ? bold(m) : m).join('   ')}`)
      break
    case 'think':
      if (argument === 'agent' || (EFFORTS as string[]).includes(argument)) { settings.thinking = argument as ReasoningEffort | 'agent'; say(dim(`  Thinking: ${argument}`)) }
      else say(`  ${['agent', ...EFFORTS].map(e => e === settings.thinking ? bold(e) : e).join('   ')}`)
      break
    case 'pending': showWaiting(); break
    case 'approve':
      for (const action of pick(argument)) {
        const outcome = await core.approvals.approve(action.actionId, 'console')
        const what = action.tool === 'memory.propose' ? 'and remembered.' : action.tool.startsWith('outbox.') ? `and written to ${stateDir}/outbox/sent (test stand-in; nothing left this machine).` : `and carried out for real: ${JSON.stringify(outcome.status === 'executed' ? outcome.result : null).slice(0, 160)}`
        if (outcome.status === 'executed') say(`${green('✓')} Approved ${bold(action.tool)} ${dim(what)}`)
        else say(`${red('✗')} Not approved: ${outcome.reason}`)
      }
      break
    case 'reject': {
      const [which, ...why] = rest
      for (const action of pick(which ?? '')) {
        core.approvals.reject(action.actionId, 'console', why.join(' ') || undefined)
        say(`${red('✗')} Rejected ${bold(action.tool)}. ${dim(why.length ? `Lesson recorded for ${action.ctx.template}.` : 'Add a reason next time to teach the agent.')}`)
      }
      break
    }
    case 'memory': {
      if (rest[0] === 'edit') {
        const entry = memory.list(TENANT)[Number(rest[1]) - 1]
        if (!entry) throw new Error(`There is no memory entry "${rest[1] ?? ''}". /memory lists them.`)
        memory.update(TENANT, entry.id, rest.slice(2).join(' '))
        say(dim('  Corrected.'))
        break
      }
      const entries = memory.list(TENANT)
      if (entries.length === 0) say(dim('  Nothing yet. /remember <fact> adds one; rejecting with a reason adds a lesson.'))
      entries.forEach((entry, i) => { say(`  [${i + 1}] ${entry.text} ${dim(`(${entry.kind}${entry.template ? `, ${entry.template} only` : ''}${entry.expiresAt ? `, until ${entry.expiresAt.slice(0, 10)}` : ''})`)}`) })
      break
    }
    case 'remember': {
      const days = /\s--days\s+(\d+)$/.exec(argument)
      memory.add(TENANT, { kind: 'fact', source: 'person', text: days ? argument.slice(0, days.index) : argument, ...(days ? { expiresAt: new Date(Date.now() + Number(days[1]) * 86_400_000).toISOString() } : {}) })
      say(dim(`  Remembered${days ? ` for ${days[1]} days` : ''}. Every agent reads it before its next task.`))
      break
    }
    case 'forget': {
      const entry = memory.list(TENANT)[Number(argument) - 1]
      if (!entry) throw new Error(`There is no memory entry "${argument}". /memory lists them.`)
      memory.remove(TENANT, entry.id)
      say(dim('  Forgotten.'))
      break
    }
    case 'kb': {
      const [action, ...words] = rest
      if (action === 'add' && words[0]) {
        const [target, ...titleWords] = words as [string, ...string[]]
        let text: string
        if (/^https?:\/\//.test(target)) {
          // A web page is read through Firecrawl, which returns it as Markdown.
          const response = await fetch(`${firecrawlUrl}/v2/scrape`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: target, formats: ['markdown'] }), signal: AbortSignal.timeout(60_000) })
          const page = await response.json() as { data?: { markdown?: string } }
          if (!response.ok || !page.data?.markdown) throw new Error(`Could not read ${target} through Firecrawl (HTTP ${response.status}). Is it running? /status`)
          text = page.data.markdown
        } else {
          if (!existsSync(target)) throw new Error(`No file at ${target}`)
          text = await extractText(target)
          if (!text.trim()) throw new Error(`No text found in ${target}. A scanned PDF has no text to read. Supported: ${EXTRACTABLE.join(', ')}`)
        }
        const document = await kb.add(TENANT, { title: titleWords.join(' ') || basename(target).replace(/\.[^.]+$/, ''), source: target, text })
        say(`${green('✓')} Added ${bold(document.title)} ${dim(`${document.chars.toLocaleString()} characters in ${document.chunks} passages. Agents can search it now.`)}`)
      } else if (action === 'remove' && words[0]) {
        const document = kb.list(TENANT)[Number(words[0]) - 1]
        if (!document) throw new Error(`There is no document "${words[0]}". /kb list shows them.`)
        kb.remove(TENANT, document.id)
        say(dim(`  Removed ${document.title}.`))
      } else if (action === 'search' && words.length > 0) {
        const hits = await kb.search(TENANT, words.join(' '))
        if (hits.length === 0) say(dim('  Nothing in the knowledge base matches.'))
        for (const hit of hits) say(`  ${bold(hit.section ? (hit.section.startsWith(hit.title) ? hit.section : `${hit.title} › ${hit.section}`) : hit.title)} ${dim(`(${hit.score.toFixed(2)})`)}\n    ${hit.text.replace(/\s+/g, ' ').slice(0, 220)}`)
      } else {
        const documents = kb.list(TENANT)
        if (documents.length === 0) say(dim('  The knowledge base is empty. /kb add <file or URL> [title] adds a document.'))
        documents.forEach((document, i) => { say(`  [${i + 1}] ${bold(document.title)} ${dim(`${document.chars.toLocaleString()} characters, ${document.chunks} passages, from ${document.source}, added ${document.addedAt.slice(0, 10)}`)}`) })
      }
      break
    }
    case 'record':
      for (const entry of core.audit.read().slice(-15)) {
        const color = entry.event === 'pending' ? yellow : ['executed', 'approved'].includes(entry.event) ? green : red
        say(`  ${dim(entry.at.slice(11, 19))} ${color(entry.event.padEnd(8))} ${entry.tool} ${dim(`${entry.template}${entry.approver ? `, by ${entry.approver}` : ''}${entry.detail ? `: ${entry.detail}` : ''}`)}`)
      }
      break
    default: say(red(`  Unknown command /${name}. /help lists them.`))
  }
  return true
}

// ---- the loop
say(`\n${bold('Helmgear')} ${dim('console. Type a task, or /help.')}`)
await status()
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: tty })
const prompt = (): void => { if (tty) { rl.setPrompt(`\n${blue('❯')} `); rl.prompt() } }
prompt()
for await (const raw of rl) {
  const typed = raw.trim()
  // With a plan waiting, an empty line or a plain yes is the go-ahead.
  const goAhead = pendingPlan !== undefined && /^(|go|yes|y|ok|okay|approve|run|do it)$/i.test(typed)
  const line = goAhead ? 'go' : typed
  if (line) {
    if (!tty) say(`\n${blue('❯')} ${line}`)
    rl.pause()
    try {
      if (line.startsWith('/')) { if (!await command(line)) break } else await runTask(line, goAhead)
    } catch (error) {
      stopWorking()
      say(red(`  ${error instanceof Error ? error.message : String(error)}`))
    }
    rl.resume()
  }
  prompt()
}
rl.close()
await gateway.close()
await connected.close()
say(dim('Bye.'))
process.exit(0)
