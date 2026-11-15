---
description: "Shared resolution of the Helmgear home, its config, data, state, cache, and backup category paths, and the shared agent configuration root, plus tilde expansion and stable watch paths."
kind: "package-library"
---

# @helmgear/home-paths

English | [中文](README.zh.md)

## Summary

`@helmgear/home-paths` lets package authors resolve the Helmgear data root and the shared agent configuration root their consumers read. An explicit path wins over the environment variable, which wins over the default under the operating-system home; blank environment values are ignored. Its public helpers can render a root without revealing an absolute machine path, expand only bare or current-user tilde forms, and canonicalize watch targets whose final components do not yet exist. Use it as a direct library dependency, not through `cordis.yml`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use these helpers wherever a package must agree with the rest of the harness about where user data lives: resolve the home once, then derive every child path from it.

### Resolving the home

```ts
import { resolveHelmgearHome, helmgearHomePath, helmgearCachePath } from '@helmgear/home-paths'

const home = resolveHelmgearHome()                // configured path, else $HELMGEAR_HOME, else ~/.helmgear
const settings = helmgearHomePath('settings')     // join one child onto the resolved home
const cache = helmgearCachePath('models')         // $HELMGEAR_HOME/cache/models, default ~/.helmgear/cache/models
```

An explicit configured path has the highest precedence, then `$HELMGEAR_HOME`, then the default `~/.helmgear`. An empty or whitespace-only `$HELMGEAR_HOME` is treated as unset, so a blank override never resolves the home to the current working directory.

`helmgearCachePath(...segments)` derives paths from the resolved home's `cache` directory. With no segments it returns the cache directory itself. Pass an initial options object, `helmgearCachePath({ helmgearHome: home }, ...segments)`, to use an explicit configured home with the same precedence and tilde expansion. It returns an absolute path without creating directories.

<a id="choosing-a-category"></a>
### Choosing a category for a new path

```ts
import { helmgearPath } from '@helmgear/home-paths'

const index = helmgearPath('state', 'my-plugin', 'index.json')             // $HELMGEAR_HOME/state/my-plugin/index.json
const models = helmgearPath({ category: 'cache', helmgearHome: '~/other-helmgear' }, 'my-plugin') // ~/other-helmgear/cache/my-plugin
```

A new file under the home uses `helmgearPath(category, ...segments)` and passes its owner's directory name, normally the package name without the `@helmgear/` prefix, as the first segment. Use `config` for files a person writes to configure the harness, `data` for records whose loss loses user work, sign-ins, or installed software, `state` for logs, indexes, ids, and other records the harness can lose without losing user work, `cache` for content it can rebuild or download again, and `backup` for backup archives, which users can delete at any time without affecting the harness. Loader `!!js` config expressions receive the same function, for example `root: !!js helmgearPath('data', 'my-plugin')`. `helmgearPath` returns an absolute path without creating directories.

Existing entries keep their current locations: conventional top-level entries such as `sessions/`, `profiles/`, `skills/`, `AGENTS.md`, `.env`, and `.credentials.yaml` stay at the top level, and the [home path categories proposal](../../../.agents/notes/proposed/architecture/2026-11-04-helmgear-home-path-categories.md) lists the category of every other existing path.

### Resolving the shared agents root

```ts
import { resolveAgentsHome, agentsHomeDisplay } from '@helmgear/home-paths'

const agents = resolveAgentsHome()   // configured path, else $HELMGEAR_AGENTS_HOME, else ~/.agents
agentsHomeDisplay(agents)            // ~/.agents, or $HELMGEAR_AGENTS_HOME for any configured root
```

`resolveAgentsHome` applies the same precedence, blank-value handling, and tilde expansion as `resolveHelmgearHome`. The root is deliberately outside `$HELMGEAR_HOME` because other agent tools share it; `helmgear-agent-instructions` reads its user-global `AGENTS.md`, and `helmgear-skill-filesystem` scans its `skills/` directory.

### Displaying a home

For user-facing paths, render a root symbolically rather than as a machine path: the default harness home displays as `~/.helmgear`, any configured harness home as `$HELMGEAR_HOME`, the default shared agents root as `~/.agents`, and any configured shared agents root as `$HELMGEAR_AGENTS_HOME`. Neither display form leaks an absolute machine path.

### Expanding user paths

`expandHomePath` expands a leading `~`, `~/`, or `~\` against the operating-system home and leaves everything else untouched — non-tilde paths and named-user forms such as `~alice/...` pass through unchanged.

### Canonicalizing watch paths

`canonicalizeWatchPath` gives a native filesystem watcher one canonical spelling of its target: the deepest existing ancestor is resolved through `realpath` and any missing suffix is restored, so a file or directory can be watched before it is created. This prevents Windows from treating a regular-file ancestor as ordinary absence, and prevents 8.3 short-name aliases from mixing with the long paths the native watcher backend emits.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package is built on one principle: harness user data lives under one root, and the shared agent configuration root stays separate because other agent tools read it too. `resolveRoot` and `rootDisplay` own the precedence and display rules for both roots, so neither can drift from the other.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Home resolution, path joining, display, tilde expansion, and watch-path canonicalization |

### Resolution rules

`resolveHelmgearHome` reads the explicit override, then `$HELMGEAR_HOME`, then falls back to the operating-system home joined with `.helmgear`. `resolveAgentsHome` reads the same three levels for `$HELMGEAR_AGENTS_HOME` and `~/.agents`. The chosen value is tilde-expanded and normalized to an absolute path; `helmgearHomePath` and `helmgearPath` join child segments with Node's platform path rules. `helmgearHomeDisplay` and `agentsHomeDisplay` compare the resolved path against the default root and return the symbolic label, so a configured root never leaks its absolute path.

### Canonicalization mechanics

`canonicalizeWatchPath` walks up from the target until it finds an existing ancestor, resolves it with `realpath`, proves it is an enumerable directory, and restores the missing suffix. Errors other than absence propagate, and a missing-suffix ancestor that is not a directory is rejected.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when you need the launcher or the consumers that depend on a single home root.

- [Boot package](../../boot/app-boot/README.md) — the launcher that resolves the home before any plugin mounts.
- [Shell environment](../../shell/shell-env/README.md) — how `HELMGEAR_HOME` reaches model shell calls.
- [Anonymous user id](../../identity/anonymous-user-id/README.md) — a stored identity file under the resolved home.

-----

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the helpers are not the right tool. They are current package constraints, not a task backlog.

- **Expansion is deliberately narrow** — only bare `~`, `~/...`, and `~\...` use the current operating-system home; named-user forms such as `~alice/...`, environment variables, and shell expressions remain unchanged.
- **Canonicalization reads but never mutates** — `canonicalizeWatchPath` performs `realpath` probes and propagates errors other than absence; callers still own directory creation, permissions, and trust policy for the resulting path.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
