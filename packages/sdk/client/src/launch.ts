/**
 * Resolve the public SDK launch configuration to one helmgear subprocess.
 * @module @helmgear/sdk-client/launch
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HarnessClientOptions } from './types.ts'

/** Default bound for a profile to answer the SDK initialize handshake. */
export const DEFAULT_INITIALIZE_TIMEOUT_MS = 10_000

/** Internal generic process launch used by the transport and fake-runtime tests. */
export interface RuntimeProcessOptions {
  command: string
  args: string[]
  cwd?: string
  /** Materialize the complete child environment when the client starts its subprocess. */
  environment: () => NodeJS.ProcessEnv
  description: string
  initializeTimeoutMs: number
  requestTimeoutMs?: number
  shutdownTimeoutMs?: number
  disposeEofGraceMs?: number
  disposeGraceMs?: number
}

/** Node argv plus internal profile patches required by one resolved helmgear entry. */
export interface HelmgearNodeLaunch {
  /** Arguments before the profile selector. */
  nodeArgs: string[]
  /** Internal patches applied below caller-supplied patches. */
  patches: string[]
  /** Environment values required by the resolved entry mode. */
  environment: NodeJS.ProcessEnv
}

interface PackageManifest {
  version?: unknown
  bin?: unknown
}

/** Read a package manifest from one resolved package.json URL. */
function manifest(url: string): PackageManifest {
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as PackageManifest
}

/**
 * Resolve and version-check a helmgear executable from package manifests.
 * @param helmgearManifestUrl - resolved URL of the helmgear package manifest.
 * @param clientManifestUrl - resolved URL of the SDK client manifest.
 * @returns the absolute helmgear executable path.
 */
export function resolveHelmgearBinFromManifests(helmgearManifestUrl: string, clientManifestUrl: string): string {
  const helmgearManifest = manifest(helmgearManifestUrl)
  const clientManifest = manifest(clientManifestUrl)
  if (typeof helmgearManifest.version !== 'string' || helmgearManifest.version !== clientManifest.version) {
    throw new Error(`helmgear SDK client ${String(clientManifest.version)} requires the same helmgear version, got ${String(helmgearManifest.version)}`)
  }
  const bin = typeof helmgearManifest.bin === 'object' && helmgearManifest.bin !== null
    ? (helmgearManifest.bin as Record<string, unknown>).helmgear
    : helmgearManifest.bin
  if (typeof bin !== 'string' || bin === '') throw new Error('@helmgear/helmgear declares no helmgear executable')
  return resolve(dirname(fileURLToPath(helmgearManifestUrl)), bin)
}

/**
 * Resolve and version-check the built helmgear executable installed with this SDK.
 * @returns the absolute built executable path, whether or not it exists in a source checkout.
 */
export function installedHelmgearBin(): string {
  return resolveHelmgearBinFromManifests(
    import.meta.resolve('@helmgear/helmgear/package.json'),
    new URL('../package.json', import.meta.url).href,
  )
}

/**
 * Resolve the Node launch for one same-version helmgear package.
 * @param helmgearManifestUrl - resolved URL of the helmgear package manifest.
 * @param clientManifestUrl - resolved URL of the SDK client manifest.
 * @param sourceLoaderUrl - optional absolute tsx loader URL for deterministic tests.
 * @returns built output, or the source entry plus its compatibility patch and tsx environment.
 */
export function resolveHelmgearNodeLaunchFromManifests(
  helmgearManifestUrl: string,
  clientManifestUrl: string,
  sourceLoaderUrl?: string,
): HelmgearNodeLaunch {
  const bin = resolveHelmgearBinFromManifests(helmgearManifestUrl, clientManifestUrl)
  if (existsSync(bin)) return { nodeArgs: [bin], patches: [], environment: {} }

  const packageDir = dirname(fileURLToPath(helmgearManifestUrl))
  const sourceBin = resolve(packageDir, 'src/bin.ts')
  const sourcePatch = resolve(packageDir, 'src/sdk-source.cordis.patch.yml')
  const sourceTsconfig = resolve(packageDir, 'tsconfig.json')
  if (!existsSync(sourceBin) || !existsSync(sourcePatch) || !existsSync(sourceTsconfig)) {
    throw new Error(
      `@helmgear/helmgear is missing its built executable ${bin} and complete source launch files ${sourceBin}, ${sourcePatch}, ${sourceTsconfig}`,
    )
  }
  const loader = sourceLoaderUrl ?? import.meta.resolve('tsx/esm')
  return {
    nodeArgs: ['--import', loader, sourceBin],
    patches: [sourcePatch],
    environment: { TSX_TSCONFIG_PATH: sourceTsconfig },
  }
}

/**
 * Resolve the installed helmgear package to a built or source Node launch.
 * @returns the launch descriptor for the current checkout or installed package.
 */
function installedHelmgearNodeLaunch(): HelmgearNodeLaunch {
  return resolveHelmgearNodeLaunchFromManifests(
    import.meta.resolve('@helmgear/helmgear/package.json'),
    new URL('../package.json', import.meta.url).href,
  )
}

/**
 * Resolve caller-relative filesystem inputs and construct canonical helmgear argv.
 * @param options - public SDK launch options.
 * @param callerCwd - parent-process directory used for lexical resolution.
 * @returns one generic subprocess spec for the JSON-RPC transport.
 */
export function resolveHelmgearLaunch(
  options: HarnessClientOptions = {},
  callerCwd: string = process.cwd(),
): RuntimeProcessOptions {
  const profile = options.profile ?? 'sdk'
  const helmgearLaunch = options.helmgearBin === undefined
    ? installedHelmgearNodeLaunch()
    : { nodeArgs: [resolve(callerCwd, options.helmgearBin)], patches: [], environment: {} }
  const patches = [
    ...helmgearLaunch.patches,
    ...(options.patches ?? []).map(path => resolve(callerCwd, path)),
  ]
  const helmgearHome = options.helmgearHome === undefined ? undefined : resolve(callerCwd, options.helmgearHome)
  return {
    command: process.execPath,
    args: [...helmgearLaunch.nodeArgs, '--profile', profile, ...patches.flatMap(path => ['--patch', path])],
    ...options.processCwd === undefined ? {} : { cwd: resolve(callerCwd, options.processCwd) },
    environment: () => ({
      ...(options.env ?? process.env),
      ...helmgearLaunch.environment,
      ...helmgearHome === undefined ? {} : { HELMGEAR_HOME: helmgearHome },
    }),
    description: `helmgear profile ${JSON.stringify(profile)}`,
    initializeTimeoutMs: options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS,
    ...options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs },
    ...options.shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs: options.shutdownTimeoutMs },
    ...options.disposeEofGraceMs === undefined ? {} : { disposeEofGraceMs: options.disposeEofGraceMs },
    ...options.disposeGraceMs === undefined ? {} : { disposeGraceMs: options.disposeGraceMs },
  }
}
