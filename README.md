# Helmgear

Helmgear is an agent harness for business tasks. Your application hands it a request; it picks an agent template, runs that agent with only the tools the template allows, and holds every action that leaves the system until a person approves it.

It is experimental software. Read [SAFETY.md](SAFETY.md) before you run it.

## How a task runs

```
request ──> router (Jev) ──> template ──> agent (model loop, no shell, no file tools)
                                             │ tool calls over MCP
                                             ▼
                                          gateway ──> read / draft: runs now, audited
                                             └──────> send: queued until a person approves
```

- **Router.** A classifier scores the request against each template's description. If none fits, or the classifier fails, the answer is "no template". There is no default agent.
- **Agent.** The model loop runs as a separate process with a scrubbed environment. It has no shell and no file tools; its only tools are the ones the gateway lists for its template. Each run gets its own gateway token, and the gateway decides from that token which tenant and connectors the process is, so the process cannot claim otherwise.
- **Gateway.** A local MCP server that owns every connector. Each tool has a risk tier: `read` and `draft` run at once, `send` is written to a queue and runs only after approval. Every decision is appended to an audit log that stores payload hashes, not payloads. Tool results are cached under `results/` in the state folder so a retried call is not run twice; clear that folder on your own retention schedule.

## Run a task

Requires Node 24.9 or later and pnpm.

```sh
pnpm install
printf 'DEEPSEEK_API_KEY=...\nTYPESAFE_API_KEY=...\n' > .env   # git-ignored
```

```ts
import { createCore, firecrawlConnector, outboxConnector, startGateway } from '@helmgear/gateway'
import { jevClassifier } from '@helmgear/router'
import { createRunner } from '@helmgear/runner'

const stateDir = './state'
const connectors = [firecrawlConnector(), outboxConnector({ dir: `${stateDir}/outbox` })]
const core = createCore({ connectors, stateDir })
const gateway = await startGateway({ executor: core.executor, connectors })

const runner = createRunner({
  templatesDir: './templates',
  stateDir,
  gateway: { ...gateway, approvals: core.approvals },
  classifier: jevClassifier({ apiKey: process.env.TYPESAFE_API_KEY! }),
  model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
})

const result = await runner.runTask({ tenant: 'acme', request: 'Draft a post about our new invoice feature and send it to press@example.com' })
// { status: 'done', template: 'social-post', response: '...', pendingActionIds: ['...'] }
```

`runTask` returns one of: `done`, `failed` (the model turn ended in an error), `no-template`, or `refused`. It throws `RunnerError` if the agent process dies or stops answering.

## Approvals

```ts
core.approvals.list('acme')                       // actions waiting, with their exact payload
await core.approvals.approve(actionId, 'sam')     // runs the stored payload once
core.approvals.reject(actionId, 'sam', 'wrong recipient')
core.audit.read()                                 // pending -> approved -> executed
```

An approval is refused if the stored payload, tool, tenant or session no longer matches what the audit log recorded when the agent asked for it, or if the audit log has no such request. `runTask` gives up after `timeoutMs` (default five minutes); actions already queued stay queued.

## Templates

A template is a folder in `templates/` holding one `SKILL.md`. Its frontmatter declares what the agent is:

```yaml
---
name: social-post                 # equals the folder name
description: Researches a topic and drafts a social media post.   # what the router sees
metadata:
  helmgear:
    persona: You are a social media manager ...   # the agent's system prompt
    connectors: [firecrawl, outbox]               # the only connectors it may use
    dataClass: public                             # or: sensitive
    reasoningEffort: off                          # off (default), low, high, max
---
```

A `sensitive` template refuses to run on the provider `deepseek-official`, because that API stores request data in mainland China. Run those templates against another host of the model.

Six templates ship: `social-post`, `outreach-research`, `lead-finder`, `competitor-brief`, `email-triage` and `bookkeeping-proposal`.

## Connectors

| Connector | Tools | Notes |
|---|---|---|
| `firecrawl` | `search`, `scrape` (read) | Uses a self-hosted Firecrawl at `FIRECRAWL_URL` (default `http://127.0.0.1:3002`). Refuses LinkedIn, and any host that is or resolves to a local or private address. It does not follow redirects, so restrict the Firecrawl container's own network access as well. |
| `outbox` | `draft` (draft), `send` (send) | Writes JSON files. A stand-in for a real mail or publishing connector; nothing leaves the machine. |

A connector is an object with a name and a list of tools (`name`, `description`, `inputSchema`, `tier`, `run`). Pass your own to `createCore` and `startGateway`.

## The console

```sh
pnpm agent          # a terminal console: type a task, watch the agent work
pnpm firecrawl:up   # start the self-hosted Firecrawl containers if web tools fail
```

The console shows which agent was picked, each tool call as the gateway records it, the reply, and whether the reply matches that record. `/help` lists its commands; `/status` shows which connectors are on.

## Plan first

```ts
const planned = await runner.runTask({ tenant, request, mode: 'plan' })
// { status: 'plan', plan: '...', sessionId, template }   nothing was done: the agent held no tools
const result = await runner.runTask({ tenant, template: planned.template, request: 'Approved. Carry out the plan now.', continue: { sessionId: planned.sessionId } })
```

`continue` resumes a session, so a follow-up message or an approved plan runs with everything said so far. The console does this for you when `/plan` is on.

## Real connectors

| Connector | Turn it on | Tools |
|---|---|---|
| `email` | `SMTP_HOST`, `SMTP_FROM` (and `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`) in `.env` | `email.send`: one plain-text email to one recipient |
| `x` | `X_ACCESS_TOKEN` in `.env` | `x.post`: one post, at most 280 characters |
| any MCP server | an entry in `connectors.json` (copy `connectors.example.json`) | every tool that server offers |

Every tool of these is held for approval, except MCP tools you mark `read` or `draft` in `connectors.json`. `mcpConnector` holds a tool by default because the gateway cannot know what a third-party tool does. A template uses a connector by naming it in `connectors`; a name with no connector behind it simply adds no tools. See `.env.example` for every setting.

Each template also has a tool budget (`maxToolCalls`, default 12). The gateway counts the calls and refuses the rest, so a research task cannot run away.

## Checked replies

An agent can say it did something it did not do. Give the runner a judge and it compares each reply with the audit log:

```ts
import { jevJudge } from '@helmgear/router'
const runner = createRunner({ /* ... */, judge: jevJudge({ apiKey: process.env.TYPESAFE_API_KEY! }) })
const result = await runner.runTask({ tenant: 'acme', request: '...' })
// result.actions   what the gateway recorded for this run: trust this
// result.verified  true only when the reply claims nothing the record does not support
// result.problems  what did not match
```

When they disagree, the agent gets one turn to fix the reply or make the missing tool call. Without a judge, `verified` is `false`.

## Memory and lessons

```ts
import { memoryConnector, MemoryStore } from '@helmgear/gateway'
const memory = new MemoryStore(`${stateDir}/memory`)
const connectors = [/* ... */, memoryConnector({ store: memory })]
const core = createCore({ connectors, stateDir, memory })
const runner = createRunner({ /* ... */, memory })

memory.add('acme', { kind: 'fact', text: 'Our product is called Tidewater.', source: 'person' })
```

- **Facts.** A template that lists `memory` in its connectors can propose a fact with `memory.propose`. The proposal waits in the approval queue like a send, so text an agent read on a web page cannot become memory unless you approve it.
- **Lessons.** When you reject an action with a reason, the reason is stored for that tenant and template, and later runs see it.
- Both are added to the agent's instructions, newest first, up to 2,000 characters.

## Many tasks, and scheduled tasks

```ts
import { runBatch } from '@helmgear/runner'
const results = await runBatch(runner, items, { concurrency: 4 })   // input order; a failure does not stop the rest

import { Scheduler } from '@helmgear/scheduler'
const scheduler = new Scheduler({ file: `${stateDir}/jobs.json`, run: job => runner.runTask(job) })
scheduler.add({ tenant: 'acme', template: 'competitor-brief', request: '...', when: { dailyAt: '08:00' } })
setInterval(() => scheduler.tick(), 30_000)
```

A job runs at most once per slot: each `everyMinutes` period, or each UTC day after `dailyAt`. The slot is recorded before the job starts, so a restart does not run it twice. Your application owns the timer; run one scheduler per file. A send from a scheduled run still waits for approval.

## Evaluate

```sh
pnpm eval                  # routing accuracy and agent cases against a fictional company
pnpm eval --trials 5 --gate   # fail if results are worse than evals/baseline.json
```

See `evals/README.md` for the cases and the latest numbers.

## Develop

```sh
pnpm typecheck     # tsc -b
pnpm test          # unit tests
pnpm test:e2e      # live tests; each skips itself when its key is missing
```

The control plane lives in `packages/control/` (`template`, `gateway`, `router`, `runner`). The model loop underneath is the `agent` profile in `packages/bundle/agent/`.

## Licence

[MIT](LICENSE). Helmgear is a fork of DeepSeek Harness; the original copyright notice is kept in `LICENSE`. Third-party dependencies and their licences are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
