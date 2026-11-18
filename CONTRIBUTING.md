# Contributing

Thanks for helping with Helmgear. It is experimental, so open an issue before starting a large change.

## Set up

You need Node 24.9 or later and pnpm.

```sh
git clone https://github.com/Xer0bit/helmgear.git
cd helmgear
pnpm install
pnpm typecheck
pnpm exec vitest run packages/control
```

`pnpm test` runs every package. A few tests inherited from upstream currently fail or flake in the shell, Windows path and HTTP proxy packages. CI reports that job without blocking on it.

## Making a change

- Keep each pull request to one change, and add a test for new behavior.
- Use commit messages like `feat(runner): add batch retries`.
- Live tests and evals call paid APIs. Copy `.env.example` to `.env` and add your own keys to run them.
- If you change routing, the runner, the gateway or a template, run `pnpm eval --gate`.

## Safety rules

Changes must keep these true unless the pull request argues for changing them:

- No template matches means no agent runs.
- Agents get no shell or file tools, only the tools the gateway lists.
- The gateway decides the tenant from the run token, never from the agent.
- `send` tools wait for a person, and unknown MCP tools are held by default.
- An approval runs the exact stored payload once.
- The audit log stores hashes, not payloads.
- Text an agent reads cannot become memory without approval.

## Adding a template

Create `templates/<name>/SKILL.md`, where `name` in the frontmatter equals the folder name. List only the connectors the agent needs, and add eval cases in `evals/`.

By contributing, you agree that your work is released under the [MIT License](LICENSE).
