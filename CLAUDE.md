# Helmgear

Agent harness for business tasks: request -> router (Jev) -> template -> agent -> gateway. Read `README.md` for the API and `SAFETY.md` before running agents.

## Commands

Requires Node 24.9+ and pnpm.

| Purpose | Command | Cost |
|---|---|---|
| Typecheck | `pnpm typecheck` | local |
| Unit tests | `pnpm test` | local |
| One area | `pnpm exec vitest run packages/control` | local |
| Live tests | `pnpm test:e2e` | uses API keys |
| Evals | `pnpm eval --only agents --case <name>` | uses API keys |
| Regression gate | `pnpm eval --trials 5 --gate` | uses API keys |
| Terminal console | `pnpm agent` | uses API keys |
| Browser console | `pnpm console`, then http://127.0.0.1:4317 | uses API keys |

Finish code changes with `pnpm typecheck` and the tests for the touched area. Run anything that uses API keys only when asked.

## Layout

- `packages/control/`: the control plane (`template`, `gateway`, `router`, `runner`, `scheduler`, `knowledge`).
- `packages/bundle/agent/`: the `agent` profile, the model loop underneath.
- `templates/<name>/SKILL.md`: agent templates. `name` equals the folder name.
- `evals/`: routing and agent cases, graded by code. `evals/baseline.json` is the regression baseline.
- `console/`: `chat.ts` (terminal), `server.ts` and `index.html` (browser).
- Tests live at `packages/*/*/tests/**/*.spec.ts` and `apps/*/tests/**/*.spec.ts`.

## Harness invariants

Do not weaken these without an explicit request. Add or keep a test for each one a change touches.

- The router returns "no template" when nothing fits or the classifier fails. There is no default agent.
- The agent process has no shell or file tools and a scrubbed environment. Its tools come only from the gateway.
- The gateway derives tenant and connectors from the per-run token, never from anything the agent claims.
- `send` tools queue until a person approves. Unknown MCP tools default to held.
- An approval runs the exact stored payload once, and is refused if it no longer matches the audit log.
- The audit log stores payload hashes, not payloads.
- `sensitive` templates refuse the `deepseek-official` provider.
- Text read from the web cannot become memory without approval.
- Trust `result.actions`, not the agent's reply, for what happened.

## Evals

- Grading stays in code. No model grades another model.
- A behavior change to routing, the runner, the gateway or a template needs a case or a gate run.
- Update `evals/baseline.json` only when asked, and state why the numbers moved.

## Browser console UI

`console/index.html` is one dependency-free file, bound to 127.0.0.1. Keep it that way.

- Use the existing tokens in `:root` and keep light and dark themes working.
- Cover keyboard use, visible focus, and loading, empty and error states.
- Show approvals with the exact payload that will run.
- Check UI changes in a real browser before calling them done.

## Conventions

- Commits use `type(scope): summary`, for example `feat(runner): ...`.
- Never read or print `.env`. Variable names are in `.env.example`.
