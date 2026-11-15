/**
 * Shared filesystem path helpers for Helmgear user data.
 *
 * @module @helmgear/home-paths
 */

import { opendir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/** Directory name for the default Helmgear home under the OS home. */
export const HELMGEAR_HOME_DIR_NAME = '.helmgear'

/** Stable user-facing display form for the default Helmgear home. */
export const DEFAULT_DSH_HOME_DISPLAY = `~/${HELMGEAR_HOME_DIR_NAME}`

/** Environment variable that overrides the default Helmgear home. */
export const HELMGEAR_HOME_ENV = 'HELMGEAR_HOME'

/** Directory name for the default shared agent configuration root under the OS home. */
export const AGENTS_HOME_DIR_NAME = '.agents'

/** Stable user-facing display form for the default shared agent configuration root. */
export const DEFAULT_AGENTS_HOME_DISPLAY = `~/${AGENTS_HOME_DIR_NAME}`

/** Environment variable that overrides the default shared agent configuration root. */
export const AGENTS_HOME_ENV = 'HELMGEAR_AGENTS_HOME'

/**
 * Give a native filesystem watcher one canonical spelling of a path, even
 * when its final components do not exist yet. The deepest existing ancestor
 * is resolved through {@link realpath}; when a suffix is missing, that
 * ancestor is also proved to be an enumerable directory before the suffix is
 * restored. This prevents Windows from treating a regular-file ancestor as
 * ordinary absence, and prevents short-name aliases from being mixed with
 * long paths emitted by the native watcher backend.
 * @param path - Watch target or root, resolved against the current directory.
 * @returns the target with its existing ancestor canonicalized.
 * @throws when ancestor traversal encounters an error other than absence, or
 * the existing ancestor of a missing suffix is not an enumerable directory.
 */
export async function canonicalizeWatchPath(path: string): Promise<string> {
  let current = resolve(path)
  const missing: string[] = []
  while (true) {
    try {
      const canonical = await realpath(current)
      if (missing.length > 0) {
        // A Windows file-as-parent probe reports ENOENT. Opening the resolved
        // ancestor preserves the cross-platform directory requirement.
        const directory = await opendir(canonical)
        await directory.close()
      }
      return join(canonical, ...missing.reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(current)
      /* v8 ignore next -- a filesystem root exists, so traversal resolves before this guard */
      if (parent === current) throw error
      missing.push(basename(current))
      current = parent
    }
  }
}

/**
 * Resolve the default Helmgear home using Node's platform path rules.
 * @returns the absolute default harness home path.
 */
export function defaultHelmgearHome(): string {
  return join(homedir(), HELMGEAR_HOME_DIR_NAME)
}

/**
 * Resolve the default shared agent configuration root using Node's platform path rules.
 * @returns the absolute default shared agent configuration root.
 */
export function defaultAgentsHome(): string {
  return join(homedir(), AGENTS_HOME_DIR_NAME)
}

/**
 * Expand supported tilde prefixes against the operating-system home.
 * @param path - configured path that may begin with `~`, `~/`, or `~\`.
 * @returns the expanded path, or the original value when no supported prefix is present.
 */
export function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve one user-data root from an explicit path, an environment override, and a default.
 * @param configured - explicit path, which has highest precedence.
 * @param env - environment mapping to read.
 * @param envName - environment variable that overrides the default.
 * @param fallback - default root, used when neither the explicit path nor the environment provides one.
 * @returns the normalized absolute root.
 */
function resolveRoot(
  configured: string | undefined,
  env: Record<string, string | undefined>,
  envName: string,
  fallback: () => string,
): string {
  const fromEnv = env[envName]
  const selected = configured ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : fallback())
  return resolve(expandHomePath(selected))
}

/**
 * Label one resolved user-data root symbolically for user-facing display.
 * @param resolvedRoot - absolute path returned by the matching resolver.
 * @param defaultRoot - absolute default root whose symbolic label applies to a match.
 * @param defaultLabel - symbolic label for the default root.
 * @param envName - environment variable name that labels any other root.
 * @returns the symbolic label.
 */
function rootDisplay(resolvedRoot: string, defaultRoot: string, defaultLabel: string, envName: string): string {
  return resolvedRoot === resolve(defaultRoot) ? defaultLabel : `$${envName}`
}

/**
 * Resolve the single-root Helmgear home.
 *
 * Precedence, highest first: an explicit configured path, `$HELMGEAR_HOME`, then
 * `~/.helmgear`. The harness keeps all user data under one root. An empty or
 * whitespace-only `$HELMGEAR_HOME` is treated as unset, so a blank override never
 * resolves the home to the current working directory.
 * @param configured - explicit harness-home override, which has highest precedence.
 * @param env - environment mapping used to read `HELMGEAR_HOME`.
 * @returns the normalized absolute harness home path.
 */
export function resolveHelmgearHome(configured?: string, env: Record<string, string | undefined> = process.env): string {
  return resolveRoot(configured, env, HELMGEAR_HOME_ENV, defaultHelmgearHome)
}

/**
 * Resolve the shared agent configuration root.
 *
 * Precedence, highest first: an explicit configured path, `$HELMGEAR_AGENTS_HOME`,
 * then `~/.agents`. The root holds configuration shared with other agent tools,
 * so it stays independent of the Helmgear home. An empty or
 * whitespace-only `$HELMGEAR_AGENTS_HOME` is treated as unset, so a blank override
 * never resolves the root to the current working directory.
 * @param configured - explicit shared-root override, which has highest precedence.
 * @param env - environment mapping used to read `HELMGEAR_AGENTS_HOME`.
 * @returns the normalized absolute shared agent configuration root.
 */
export function resolveAgentsHome(configured?: string, env: Record<string, string | undefined> = process.env): string {
  return resolveRoot(configured, env, AGENTS_HOME_ENV, defaultAgentsHome)
}

/**
 * Join path segments onto the resolved Helmgear home. It addresses the
 * existing top-level entries; a new path uses {@link helmgearPath} with its category.
 * @param segments - path segments appended to the Harness home; an empty list returns the home itself.
 * @returns the normalized absolute joined path.
 */
export function helmgearHomePath(...segments: string[]): string {
  return join(resolveHelmgearHome(), ...segments)
}

/**
 * Join path segments onto the resolved Harness home's `cache` directory without creating it; no arguments returns the directory itself.
 * @param optionsOrSegment - explicit home override, or the first path segment; omission uses the default home resolution.
 * @param segments - additional path segments after the first child, if any.
 * @returns the normalized absolute cache path.
 */
export function helmgearCachePath(optionsOrSegment: { helmgearHome?: string } | string = {}, ...segments: string[]): string {
  if (typeof optionsOrSegment === 'string') return helmgearPath('cache', optionsOrSegment, ...segments)
  return helmgearPath({ category: 'cache', helmgearHome: optionsOrSegment.helmgearHome }, ...segments)
}

/**
 * Category directory under the Harness home, named after the XDG Base Directory
 * kinds. A new file kept under `$HELMGEAR_HOME` belongs to exactly one category, and
 * the category directory name equals the category. Existing top-level entries,
 * such as `sessions/`, `profiles/`, and `.credentials.yaml`, keep their current
 * locations; the [home path categories proposal](../../../../.agents/notes/proposed/architecture/2026-11-04-helmgear-home-path-categories.md)
 * lists every path and its category:
 *
 * - `config`: files a person writes or edits to configure the harness.
 * - `data`: durable records whose loss loses user work, sign-ins, or installed
 *   software, such as Sessions, profiles, attachments, credentials, and runtimes.
 * - `state`: records that persist across runs but whose loss only resets
 *   history or derived indexes, such as logs, upload indexes, and ids.
 * - `cache`: content that can be rebuilt or downloaded again.
 * - `backup`: backup archives the harness writes; deleting them never affects
 *   a running harness or the records they copy.
 */
export type HelmgearHomeCategory = 'config' | 'data' | 'state' | 'cache' | 'backup'

/** A category directory under an explicitly configured Harness home. */
export interface HelmgearPathLocation {
  /** Category directory to join under. */
  category: HelmgearHomeCategory
  /** Explicit harness-home override, resolved by {@link resolveHelmgearHome}; omission uses `$HELMGEAR_HOME`, then `~/.helmgear`. */
  helmgearHome?: string | undefined
}

/**
 * Join path segments onto one category directory of the Harness home without
 * creating it. An owner passes its own directory name, normally its package
 * name without the `@helmgear/` prefix, as the first segment.
 * @param location - category under the resolved home, or a category with an explicit home override.
 * @param segments - path segments appended to the category directory; an empty list returns the directory itself.
 * @returns the normalized absolute path.
 */
export function helmgearPath(location: HelmgearHomeCategory | HelmgearPathLocation, ...segments: string[]): string {
  const { category, helmgearHome } = typeof location === 'string' ? { category: location, helmgearHome: undefined } : location
  return join(resolveHelmgearHome(helmgearHome), category, ...segments)
}

/**
 * Describe a resolved harness home symbolically for user-facing display.
 *
 * It never returns an absolute machine path: the default home is labelled
 * `~/.helmgear`, and any configured home is labelled `$HELMGEAR_HOME`.
 * @param resolvedHome - the absolute path returned by {@link resolveHelmgearHome}.
 * @returns `~/.helmgear` for the default home, otherwise `$HELMGEAR_HOME`.
 */
export function helmgearHomeDisplay(resolvedHome: string): string {
  return rootDisplay(resolvedHome, defaultHelmgearHome(), DEFAULT_DSH_HOME_DISPLAY, HELMGEAR_HOME_ENV)
}

/**
 * Describe a resolved shared agent configuration root symbolically for user-facing display.
 *
 * It never returns an absolute machine path: the default root is labelled
 * `~/.agents`, and any configured root is labelled `$HELMGEAR_AGENTS_HOME`.
 * @param resolvedHome - the absolute path returned by {@link resolveAgentsHome}.
 * @returns `~/.agents` for the default root, otherwise `$HELMGEAR_AGENTS_HOME`.
 */
export function agentsHomeDisplay(resolvedHome: string): string {
  return rootDisplay(resolvedHome, defaultAgentsHome(), DEFAULT_AGENTS_HOME_DISPLAY, AGENTS_HOME_ENV)
}
