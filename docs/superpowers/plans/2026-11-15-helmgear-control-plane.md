# Helmgear Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the stripped Helmgear runtime into a business agent harness: an application hands it a request, it picks an agent template, runs it with only that template's tools, and holds every side-effecting action for approval with a full audit record.

**Architecture:** The existing `agent` profile stays an untrusted worker driven over the JSON-RPC SDK. Four new packages form the control plane around it: `template` (what an agent is), `gateway` (an MCP server that owns every side-effecting tool, with risk tiers, approvals, idempotency and audit), `router` (Jev picks the template) and `runner` (the one function the application calls). The harness approval request carries no tool arguments, so payload-level approval lives in the gateway, not in the harness.

**Tech Stack:** TypeScript (ESM, strict), Node >= 24.9, pnpm 11.28.5 workspaces, vitest, the Model Context Protocol TypeScript SDK (same package and version `packages/mcp/mcp-client/package.json` declares), TypeSafe/Jev for routing, DeepSeek for the model, Firecrawl for web.

**Spec:** `../reports/Multipurpose agent harness build options.md` (architecture and risks) and `../reports/dsh-sdk-map.md` (how the runtime is driven). Paths are relative to the `helmgear/` repo root; both files sit in the parent `REA/` folder.

**This is plan 1 of 3.** It delivers the control plane with two connectors that need no third-party account approval (Firecrawl, and a local outbox that stands in for "send"). Plan 2 adds real connectors per domain (Gmail/Microsoft Graph, X, QuickBooks/Xero). Plan 3 adds multi-tenant hosting, a scheduler and a production build. Each plan ships working software on its own.

## Global Constraints

- Node >= 24.9.0; run every command with `~/.nvm/versions/node/v24.21.0/bin` first on `PATH` and `corepack pnpm`. System Node is 22 and will not work.
- New packages live at `packages/control/<name>/`, are named `@helmgear/<name>`, are `"type": "module"`, keep tests in `tests/`, extend `../../../tsconfig.base.json`, and are registered in `tsconfig.base.json` `paths` and `tsconfig.host.json` `references` (copy the `packages/bundle/agent` entries as the pattern).
- Workspace dependencies use `workspace:*`.
- `pnpm typecheck` must report 0 errors and `pnpm test` must not gain failures after every task. Seven terminal tests in `packages/subprocess/subprocess-local` fail today; leave them.
- `LICENSE` and `THIRD_PARTY_NOTICES.md` are never edited or removed.
- Commit messages carry no AI attribution or co-author trailer.
- Secrets come only from the environment (`DEEPSEEK_API_KEY`, `TYPESAFE_API_KEY`, `HELMGEAR_GATEWAY_TOKEN`, and `FIRECRAWL_API_KEY` only when a hosted Firecrawl is used). No secret is written to a file, a log line or an audit record.
- The model never receives a shell or file-editing tool. Tools reach it only through the gateway.
- Risk tiers are exactly `'read' | 'draft' | 'send'`. A `'send'` action never executes without a recorded approval.
- A template whose `dataClass` is `'sensitive'` never runs on provider `deepseek-official` (that API stores data in mainland China).
- Default `reasoningEffort` is `'off'`; a template may raise it.

## Review Focus

1. The model retries a tool call after a timeout: the same idempotency key must execute the action once and return the first result.
2. An approval arrives for an action whose stored payload was altered on disk: the gateway must refuse it, not execute the altered payload.
3. A request matches no template, or Jev is unreachable: the runner must return "no template" without starting a harness process, never fall back to a default agent.
4. A template file has missing or malformed metadata: loading must fail naming the file and the field, never skip it silently.
5. The harness process dies mid-run: the runner must reject with a typed error, and actions already pending approval must stay pending and approvable.

Each line has its test in the task that owns the code (Tasks 4, 5, 8, 2 and 9).

---

### Task 1: Baseline commit, client rename and live smoke test

**Files:**
- Modify: `packages/sdk/client/src/api.ts`, `packages/sdk/client/src/types.ts`, `packages/sdk/client/src/index.ts`, and their tests (rename only)
- Create: `apps/cli/tests/agent-live.e2e.ts`
- Create: `vitest.e2e.config.ts`
- Modify: `package.json` (add script `"test:e2e": "vitest run --config vitest.e2e.config.ts"`)

**Interfaces:**
- Produces: `class Helmgear` and `type HelmgearOptions` exported from `@helmgear/sdk-client` (formerly `DeepSeekHarness`, `DeepSeekHarnessOptions`), with default `profile: 'agent'`. Everything else in that package keeps its name.

- [ ] **Step 1: Create the baseline commit.** The working tree is a renamed, stripped upstream checkout with no commit of its own. Remove `.git`, run `git init -b main`, add everything, commit as `chore: Helmgear baseline (stripped fork of DeepSeek Harness 39163dd)`. Do not add a remote; the repository owner supplies the URL.

- [ ] **Step 2: Rename the client class.** Replace the identifiers `DeepSeekHarnessOptions` then `DeepSeekHarness` with `HelmgearOptions` and `Helmgear` across `packages/` and `apps/`; change the default profile in `packages/sdk/client/src/launch.ts` from `'sdk'` to `'agent'` and update the tests that assert `'sdk'`.

- [ ] **Step 3: Run** `corepack pnpm typecheck && corepack pnpm exec vitest run packages/sdk`. Expected: 0 type errors, all SDK tests pass.

- [ ] **Step 4: Write the live smoke test** in `apps/cli/tests/agent-live.e2e.ts`. It self-skips when `DEEPSEEK_API_KEY` is unset.

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Helmgear } from '@helmgear/sdk-client'

it.skipIf(!process.env.DEEPSEEK_API_KEY)('answers one prompt on the agent profile with thinking off', async () => {
  await using harness = new Helmgear({
    helmgearHome: mkdtempSync(join(tmpdir(), 'helmgear-live-')),
    model: 'deepseek-v4-flash',
    reasoningEffort: 'off' as never,
  })
  const result = await harness.run('Reply with exactly the word: ready')
  expect(result.finishReason).not.toBe('error')
  expect(result.finalResponse.toLowerCase()).toContain('ready')
}, 60_000)
```

`vitest.e2e.config.ts` is `vitest.config.ts` with `include: ['apps/*/tests/**/*.e2e.ts', 'packages/*/*/tests/**/*.e2e.ts']`.

- [ ] **Step 5: Run** `corepack pnpm test:e2e`. Expected with a key in `.env`: 1 passed. Without: 1 skipped. If the option is named differently from `helmgearHome`, use the name `packages/sdk/client/src/types.ts` declares.

- [ ] **Step 6: Commit** `feat(sdk): Helmgear client class and live agent smoke test`.

---

### Task 2: `@helmgear/template` — what an agent is

**Files:**
- Create: `packages/control/template/package.json`, `tsconfig.json`, `src/index.ts`, `src/types.ts`, `src/load.ts`
- Test: `packages/control/template/tests/load.spec.ts`

**Interfaces:**
- Produces:

```ts
export type RiskTier = 'read' | 'draft' | 'send'
export type DataClass = 'public' | 'sensitive'
export interface Template {
  name: string            // [a-z0-9-]{1,48}, equals the folder name
  description: string     // one sentence; this is what the router shows Jev
  persona: string         // replaces system-prompt.personaPrefix
  connectors: string[]    // connector names the gateway may expose, e.g. ['firecrawl', 'outbox']
  dataClass: DataClass
  reasoningEffort: 'off' | 'low' | 'high' | 'max'   // default 'off'
  dir: string             // absolute folder path
}
export class TemplateError extends Error { readonly file: string; readonly field: string | undefined }
export function loadTemplates(root: string): Template[]   // sorted by name; throws TemplateError
```

A template is a folder `<root>/<name>/SKILL.md`. Its YAML frontmatter has `name`, `description`, and a `metadata.helmgear` object holding `persona`, `connectors`, `dataClass` and optional `reasoningEffort`. The Markdown body is the skill body the model loads; this package does not interpret it.

- [ ] **Step 1: Write the failing tests** in `tests/load.spec.ts`, each building its fixture in a temp directory:
  - `loads a valid template` asserts every field of the returned `Template`, including `reasoningEffort: 'off'` when omitted.
  - `rejects a missing persona naming file and field` expects `TemplateError` with `field === 'metadata.helmgear.persona'` and `file` ending in `SKILL.md`.
  - `rejects a name that differs from its folder`, `rejects an unknown dataClass`, `rejects connectors that is not a string array` — each asserts the `field`.
  - `returns templates sorted by name and ignores files that are not folders`.

- [ ] **Step 2: Run** `corepack pnpm exec vitest run packages/control/template`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `loadTemplates` in `src/load.ts`. Parse frontmatter with the YAML library already in the workspace (`packages/skill/skill-filesystem` shows which); validate by hand, no schema library.

- [ ] **Step 4: Run the tests.** Expected: PASS.

- [ ] **Step 5: Commit** `feat(template): template format and loader`.

---

### Task 3: `@helmgear/gateway` — audit log

**Files:**
- Create: `packages/control/gateway/package.json`, `tsconfig.json`, `src/index.ts`, `src/audit.ts`
- Test: `packages/control/gateway/tests/audit.spec.ts`

**Interfaces:**
- Produces:

```ts
export interface AuditEntry {
  at: string              // ISO 8601 UTC
  tenant: string
  sessionId: string
  template: string
  tool: string            // '<connector>.<action>'
  tier: RiskTier
  event: 'executed' | 'pending' | 'approved' | 'rejected' | 'failed' | 'refused'
  actionId: string        // idempotency key
  payloadSha256: string
  approver?: string
  detail?: string         // error message or external object id
}
export class AuditLog {
  constructor(file: string)                      // append-only JSON Lines
  append(entry: Omit<AuditEntry, 'at'>): void    // synchronous append + fsync
  read(): AuditEntry[]
}
```

- [ ] **Step 1: Write the failing tests:** `appends one JSON line per entry and stamps a UTC time`; `read returns entries in write order`; `never rewrites earlier lines` (append twice, assert the first line's bytes are unchanged); `stores the payload hash, not the payload` (assert the file text does not contain a marker string passed only as payload).
- [ ] **Step 2: Run** `corepack pnpm exec vitest run packages/control/gateway`. Expected: FAIL.
- [ ] **Step 3: Implement** `AuditLog` with `fs.appendFileSync` on a file opened with flag `'a'`.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(gateway): append-only audit log`.

---

### Task 4: `@helmgear/gateway` — connector registry, tiers and idempotency

**Files:**
- Create: `packages/control/gateway/src/registry.ts`, `src/execute.ts`
- Test: `packages/control/gateway/tests/execute.spec.ts`

**Interfaces:**
- Consumes: `AuditLog` (Task 3), `RiskTier` (Task 2).
- Produces:

```ts
export interface ToolDef {
  name: string                               // '<connector>.<action>', e.g. 'outbox.send'
  description: string
  inputSchema: Record<string, unknown>       // JSON Schema object
  tier: RiskTier
  untrusted?: boolean                        // true when the result contains third-party content
  run(input: Record<string, unknown>, ctx: CallContext): Promise<unknown>
}
export interface Connector { name: string; tools: ToolDef[] }
export interface CallContext { tenant: string; sessionId: string; template: string }
export type CallResult =
  | { status: 'ok'; result: unknown }
  | { status: 'pending'; actionId: string }
  | { status: 'refused'; reason: string }
export class Executor {
  constructor(options: { connectors: Connector[]; audit: AuditLog; stateDir: string })
  call(tool: string, input: Record<string, unknown>, ctx: CallContext, idempotencyKey: string): Promise<CallResult>
}
export function payloadSha256(tool: string, input: Record<string, unknown>): string   // over canonical JSON with sorted keys
```

Rules: `read` and `draft` tools run at once and audit `executed`. `send` tools do not run; they are handed to the approval queue (Task 5) and audit `pending`. An unknown tool, or input that fails `inputSchema`, returns `refused` and audits `refused`. Results are cached by `idempotencyKey` in `<stateDir>/results/<key>.json`.

- [ ] **Step 1: Write the failing tests:**
  - `runs a read tool and audits executed`.
  - `returns the first result for a repeated idempotency key without running the tool again` (the fake tool counts calls; assert the count is 1 and both results are equal). This pins Review Focus 1.
  - `refuses input that violates the schema and never calls run`.
  - `refuses an unknown tool`.
  - `does not run a send tool; returns pending` (uses a stub queue until Task 5).
  - `audits failed with the error message when run throws, and does not cache the failure`.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement** `Executor`. Validate input with the JSON Schema validator already in the workspace lockfile (search `pnpm-lock.yaml` for `ajv`); if none is present, add `ajv`.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(gateway): tiered tool execution with idempotency`.

---

### Task 5: `@helmgear/gateway` — approval queue

**Files:**
- Create: `packages/control/gateway/src/approvals.ts`
- Modify: `packages/control/gateway/src/execute.ts` (use the real queue)
- Test: `packages/control/gateway/tests/approvals.spec.ts`

**Interfaces:**
- Consumes: `Executor`, `payloadSha256`, `AuditLog`.
- Produces:

```ts
export interface PendingAction {
  actionId: string; tool: string; input: Record<string, unknown>
  payloadSha256: string; ctx: CallContext; createdAt: string
}
export class ApprovalQueue {
  constructor(options: { dir: string; audit: AuditLog; run: (action: PendingAction) => Promise<unknown> })
  enqueue(action: Omit<PendingAction, 'createdAt'>): void            // writes <dir>/<actionId>.json atomically
  list(tenant?: string): PendingAction[]
  approve(actionId: string, approver: string): Promise<{ status: 'executed'; result: unknown } | { status: 'refused'; reason: string }>
  reject(actionId: string, approver: string, reason?: string): void
}
```

`approve` re-reads the stored file, recomputes the hash, and executes the stored payload exactly once; the file is removed only after the result is recorded.

- [ ] **Step 1: Write the failing tests:**
  - `enqueue then list returns the action with its exact input`.
  - `approve runs the stored payload once and audits approved then executed`.
  - `approve refuses when the stored file's input no longer matches its recorded hash` (edit the JSON file between enqueue and approve; assert `refused`, the tool was never run, and an audit `refused` entry exists). This pins Review Focus 2.
  - `a second approve of the same action is refused`.
  - `reject removes the action and audits rejected with the approver`.
  - `pending actions survive constructing a new ApprovalQueue on the same dir`. This half-pins Review Focus 5.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement** `ApprovalQueue`; write files with `@helmgear/atomic-write`.
- [ ] **Step 4: Run** `corepack pnpm exec vitest run packages/control/gateway`. Expected: PASS, including Task 4's `send` test now using the real queue.
- [ ] **Step 5: Commit** `feat(gateway): payload-level approval queue`.

---

### Task 6: `@helmgear/gateway` — MCP server

**Files:**
- Create: `packages/control/gateway/src/server.ts`
- Test: `packages/control/gateway/tests/server.spec.ts`

**Interfaces:**
- Consumes: `Executor`, `ApprovalQueue`, `Connector`.
- Produces:

```ts
export interface GatewayServer { url: string; close(): Promise<void> }
export function startGateway(options: {
  executor: Executor
  connectors: Connector[]
  token: string            // required bearer token
  port?: number            // default 0 (ephemeral); binds 127.0.0.1 only
}): Promise<GatewayServer>
```

The server speaks MCP over Streamable HTTP at `/mcp`. The request headers `x-helmgear-tenant`, `x-helmgear-session`, `x-helmgear-template` and `x-helmgear-connectors` (comma-separated) form the `CallContext` and limit `tools/list` to the named connectors. MCP tool names replace the dot with a double underscore (`outbox__send`), because the harness prefixes them again as `mcp__gateway__outbox__send`. The idempotency key is the MCP `tools/call` request's `_meta.progressToken` when present, otherwise the SHA-256 of session id plus tool plus canonical input. A `pending` result is returned to the model as text: `Queued for approval as <actionId>. Do not retry; continue with other work.`

- [ ] **Step 1: Write the failing tests** using the MCP SDK's client over HTTP against `startGateway`:
  - `rejects a request without the bearer token with 401`.
  - `lists only tools of connectors named in x-helmgear-connectors`.
  - `calls a read tool and returns its result as text content`.
  - `returns the queued-for-approval text for a send tool and leaves one pending action`.
  - `binds to 127.0.0.1`.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement** `startGateway` with the MCP SDK's server and Streamable HTTP transport on `node:http`.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(gateway): MCP server over streamable HTTP`.

---

### Task 7: Two connectors — Firecrawl and outbox

**Files:**
- Create: `packages/control/gateway/src/connectors/firecrawl.ts`, `src/connectors/outbox.ts`
- Test: `packages/control/gateway/tests/connectors.spec.ts`

**Interfaces:**
- Produces:

```ts
export function firecrawlConnector(options: { baseUrl?: string; apiKey?: string; fetch?: typeof fetch; blockedHosts?: string[] }): Connector
// tools: 'firecrawl.search' { query: string; limit?: number (1-10, default 5) }  tier 'read', untrusted
//        'firecrawl.scrape' { url: string }                                       tier 'read', untrusted
export function outboxConnector(options: { dir: string }): Connector
// tools: 'outbox.draft' { to: string; subject: string; body: string }  tier 'draft' -> writes <dir>/drafts/<id>.json, returns { id }
//        'outbox.send'  { to: string; subject: string; body: string }  tier 'send'  -> writes <dir>/sent/<id>.json, returns { id }
```

`baseUrl` defaults to `process.env.FIRECRAWL_URL ?? http://127.0.0.1:3002`, the self-hosted open-source Firecrawl already running in Docker on this machine; it needs no key, so the `Authorization` header is sent only when `apiKey` is set. `blockedHosts` defaults to `['linkedin.com', 'www.linkedin.com']`; LinkedIn's API terms prohibit scraping. `firecrawl.scrape` refuses a URL whose host is blocked or a subdomain of a blocked host. The outbox connector stands in for a real mail connector so the approval path can be exercised without a third-party account.

- [ ] **Step 1: Write the failing tests:**
  - `firecrawl.search posts the query to the base URL and returns the results` (inject a fake `fetch`; assert URL, method and body; assert no `Authorization` header without `apiKey` and `Authorization: Bearer <key>` with one).
  - `firecrawl.scrape refuses linkedin.com and its subdomains without calling fetch`.
  - `firecrawl tools surface an HTTP error status as a thrown error with the status code`.
  - `outbox.draft writes a draft file and returns its id`.
  - `outbox.send writes to sent/ only when run is invoked` (it is invoked by the approval queue, never directly by the executor).
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement both connectors.** Endpoints, verified against the local instance on 2026-11-16: `POST {baseUrl}/v2/search` with `{ query, limit }` returns `{ success, data: { web: [{ url, title, description }] } }`; `POST {baseUrl}/v2/scrape` with `{ url, formats: [markdown] }` returns `{ success, data: { markdown } }`.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(gateway): firecrawl and outbox connectors`.

---

### Task 8: `@helmgear/router` — Jev picks the template

**Files:**
- Create: `packages/control/router/package.json`, `tsconfig.json`, `src/index.ts`, `src/route.ts`, `src/jev.ts`
- Test: `packages/control/router/tests/route.spec.ts`

**Interfaces:**
- Consumes: `Template` (Task 2).
- Produces:

```ts
export interface Choice { label: string; probability: number }
export interface Classifier {
  /** Probability per label, plus the probability that no label fits. */
  classify(input: { text: string; options: { label: string; description: string }[] }): Promise<{ choices: Choice[]; noneFits: number }>
}
export type RouteResult =
  | { kind: 'template'; template: Template; probability: number }
  | { kind: 'none'; reason: 'no-fit' | 'low-confidence' | 'classifier-error'; detail?: string }
export function route(request: string, templates: Template[], classifier: Classifier, options?: { minProbability?: number; maxNoneFits?: number }): Promise<RouteResult>
export function jevClassifier(options: { apiKey: string }): Classifier
```

Defaults: `minProbability` 0.6, `maxNoneFits` 0.5. `route` never throws on a classifier failure; it returns `classifier-error`.

- [ ] **Step 1: Write the failing tests** with a fake `Classifier`:
  - `returns the template whose probability is highest and at least 0.6`.
  - `returns none/low-confidence when the best probability is 0.59`.
  - `returns none/no-fit when noneFits exceeds 0.5 even if a label scores 0.9`.
  - `returns none/classifier-error with the message when classify rejects`. This pins Review Focus 3 at the router.
  - `returns none/no-fit for an empty template list without calling the classifier`.
  - `the result does not depend on the order templates are passed in` (run both orders against a fake that scores by label).
- [ ] **Step 2: Run** `corepack pnpm exec vitest run packages/control/router`. Expected: FAIL.
- [ ] **Step 3: Implement** `route`.
- [ ] **Step 4: Implement** `jevClassifier` against TypeSafe. Read `~/.claude/skills/typesafe-ai/SKILL.md` and `https://docs.typesafe.ai/patterns/intent-routing.md` first and use the request format they document: one Choice question over the template names with their descriptions, and one yes/no question for "does any option fit". Add `tests/jev.e2e.ts`, which self-skips without `TYPESAFE_API_KEY` and asserts that "draft a tweet about our launch" scores a `social-post` option above an `email-triage` option.
- [ ] **Step 5: Run the unit tests.** Expected: PASS.
- [ ] **Step 6: Commit** `feat(router): template routing with Jev`.

---

### Task 9: `@helmgear/runner` — the function the application calls

**Files:**
- Create: `packages/control/runner/package.json`, `tsconfig.json`, `src/index.ts`, `src/patch.ts`, `src/run.ts`
- Test: `packages/control/runner/tests/patch.spec.ts`, `tests/run.spec.ts`

**Interfaces:**
- Consumes: `Template`, `route`, `Classifier`, `GatewayServer`, `Helmgear` (Task 1).
- Produces:

```ts
export interface RunnerOptions {
  templatesDir: string
  stateDir: string                 // <stateDir>/tenants/<tenant> is that tenant's HELMGEAR_HOME
  gateway: { url: string; token: string }
  classifier: Classifier
  model: { provider: string; model: string }
  env?: NodeJS.ProcessEnv          // complete child environment; defaults to a scrubbed copy carrying only the model key
}
export type TaskResult =
  | { status: 'done'; template: string; sessionId: string; response: string; pendingActionIds: string[] }
  | { status: 'no-template'; reason: string }
  | { status: 'refused'; reason: string }
export class RunnerError extends Error { readonly code: 'HARNESS_EXITED' | 'HARNESS_TIMEOUT' }
export function createRunner(options: RunnerOptions): { runTask(input: { tenant: string; request: string; template?: string }): Promise<TaskResult> }
export function templatePatch(template: Template, gateway: { url: string }, ctx: { tenant: string; sessionId: string }): string   // YAML text
```

`templatePatch` returns a profile patch that: sets `system-prompt.config.personaPrefix` to the template persona; sets `skill-filesystem.config` to `includeDefaultRoots: false` and `customSkillDirs: [<templatesDir>]`; and inserts one `@helmgear/mcp-client` row (`id: mcp-gateway`, `serverName: gateway`, `transport: streamable-http`, `url`, `failOnStartupError: true`, `toolCallTimeoutMs: 60000`) whose `headers` carry `Authorization: !!js` reading `process.env.HELMGEAR_GATEWAY_TOKEN` and the four `x-helmgear-*` headers. The token is never written into the patch text.

`runTask`: route (skipped when `template` is given) -> refuse a `sensitive` template on provider `deepseek-official` -> write the patch to a temp file -> start `Helmgear` with `profile: 'agent'`, that patch, the tenant home and the template's `reasoningEffort` -> `run(request)` -> collect pending action ids for that session from the gateway -> close the harness.

- [ ] **Step 1: Write the failing tests for `templatePatch`:** the YAML parses; the persona, `customSkillDirs`, `serverName`, URL and the four context headers are present; the text does not contain the token value; `includeDefaultRoots` is `false`.
- [ ] **Step 2: Write the failing tests for `runTask`** with a fake harness factory injected through an internal option:
  - `returns no-template and starts no harness when routing returns none`. This pins Review Focus 3.
  - `refuses a sensitive template on deepseek-official without starting a harness`.
  - `uses <stateDir>/tenants/<tenant> as the home, a different folder per tenant`.
  - `rejects with RunnerError HARNESS_EXITED when the harness process exits mid-run` (the fake throws `TransportClosedError`). This pins Review Focus 5.
  - `always closes the harness, including after an error`.
  - `passes only the model key to the child environment by default` (assert `FIRECRAWL_API_KEY` set in the parent is absent from the child env).
- [ ] **Step 3: Run** `corepack pnpm exec vitest run packages/control/runner`. Expected: FAIL.
- [ ] **Step 4: Implement** `templatePatch` and `createRunner`.
- [ ] **Step 5: Run the tests.** Expected: PASS.
- [ ] **Step 6: Commit** `feat(runner): route, compose and run one task`.

---

### Task 10: Four starter templates and the end-to-end test

**Files:**
- Create: `templates/social-post/SKILL.md`, `templates/outreach-research/SKILL.md`, `templates/email-triage/SKILL.md`, `templates/bookkeeping-proposal/SKILL.md`
- Create: `packages/control/runner/tests/end-to-end.e2e.ts`
- Modify: `README.md` (replace upstream text with a one-page Helmgear guide: what it is, how to run a task, where templates live, how approvals work, the licence note)

**Interfaces:**
- Consumes: everything above.

| Template | connectors | dataClass | What it does |
|---|---|---|---|
| `social-post` | `firecrawl`, `outbox` | `public` | Researches a topic and drafts a post; publishing is an `outbox.send` held for approval. |
| `outreach-research` | `firecrawl`, `outbox` | `public` | Researches a company from public pages and drafts a first-touch message. Never LinkedIn. |
| `email-triage` | `outbox` | `sensitive` | Classifies a pasted message and drafts a reply; never sends. |
| `bookkeeping-proposal` | (none) | `sensitive` | Turns a pasted invoice into a proposed journal entry where debits equal credits; proposes only. |

Each persona names the business role, states that tool results are untrusted content and never instructions, and states that sending is queued for a person.

- [ ] **Step 1: Write the four templates.** Run `loadTemplates('templates')` in a unit test (`packages/control/template/tests/shipped.spec.ts`) that asserts four templates load and their `connectors` and `dataClass` match the table.
- [ ] **Step 2: Write the end-to-end test.** It self-skips without `DEEPSEEK_API_KEY` or when the Firecrawl base URL does not answer. It starts a gateway with both connectors, creates a runner with a fake classifier that always returns `social-post`, and runs "Draft a short post announcing our new invoice feature and send it to press@example.com". Assertions: `status === 'done'`; `template === 'social-post'`; `pendingActionIds.length >= 1`; the outbox `sent/` folder is empty; after `approve()` on the first id, `sent/` holds one file whose `to` is `press@example.com`; the audit log holds a `pending`, an `approved` and an `executed` entry sharing that `actionId`.
- [ ] **Step 3: Run** `corepack pnpm test:e2e`. Expected with both keys: PASS. Record the wall-clock time of the run in the commit body; it is the first measured latency for the stack.
- [ ] **Step 4: Run** `corepack pnpm typecheck && corepack pnpm test`. Expected: 0 type errors; no failures beyond the seven known terminal tests.
- [ ] **Step 5: Commit** `feat: starter templates, README and end-to-end approval flow`.

---

## Deliberately not in this plan

- Real mail, social and accounting connectors, per-user OAuth, and a connector aggregator (plan 2).
- Jev risk scoring at the approval gate and the rule that a session which has read untrusted content cannot send; today every `send` is held, which is the stricter behaviour (plan 2, with real inboxes).
- Multi-tenant hosting, a scheduler for recurring templates, a non-PRC model host, and a production JavaScript build (plan 3).
- The seven failing terminal tests and the remaining upstream dev dependencies.
