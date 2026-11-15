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
- **Agent.** The model loop runs as a separate process with a scrubbed environment. It has no shell and no file tools; its only tools are the ones the gateway lists for its template.
- **Gateway.** A local MCP server that owns every connector. Each tool has a risk tier: `read` and `draft` run at once, `send` is written to a queue and runs only after approval. Every decision is appended to an audit log that stores payload hashes, not payloads.

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
const token = crypto.randomUUID()
const gateway = await startGateway({ executor: core.executor, connectors, token })

const runner = createRunner({
  templatesDir: './templates',
  stateDir,
  gateway: { url: gateway.url, token, approvals: core.approvals },
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

An approval is refused if the stored payload no longer matches the hash recorded when the agent asked for it.

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

Four templates ship: `social-post`, `outreach-research`, `email-triage` and `bookkeeping-proposal`.

## Connectors

| Connector | Tools | Notes |
|---|---|---|
| `firecrawl` | `search`, `scrape` (read) | Uses a self-hosted Firecrawl at `FIRECRAWL_URL` (default `http://127.0.0.1:3002`). Refuses LinkedIn and local or private addresses. |
| `outbox` | `draft` (draft), `send` (send) | Writes JSON files. A stand-in for a real mail or publishing connector; nothing leaves the machine. |

A connector is an object with a name and a list of tools (`name`, `description`, `inputSchema`, `tier`, `run`). Pass your own to `createCore` and `startGateway`.

## Develop

```sh
pnpm typecheck     # tsc -b
pnpm test          # unit tests
pnpm test:e2e      # live tests; each skips itself when its key is missing
```

The control plane lives in `packages/control/` (`template`, `gateway`, `router`, `runner`). The model loop underneath is the `agent` profile in `packages/bundle/agent/`.

## Licence

[MIT](LICENSE). Helmgear is a fork of DeepSeek Harness; the original copyright notice is kept in `LICENSE`. Third-party dependencies and their licences are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
