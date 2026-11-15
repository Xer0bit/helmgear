import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENTS_HOME_DIR_NAME,
  DEFAULT_AGENTS_HOME_DISPLAY,
  DEFAULT_DSH_HOME_DISPLAY,
  HELMGEAR_HOME_DIR_NAME,
  agentsHomeDisplay,
  canonicalizeWatchPath,
  defaultAgentsHome,
  defaultHelmgearHome,
  helmgearCachePath,
  helmgearHomeDisplay,
  helmgearHomePath,
  helmgearPath,
  expandHomePath,
  resolveAgentsHome,
  resolveHelmgearHome,
} from '@helmgear/home-paths'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('helmgear path helpers', () => {
  it('owns the shared default Helmgear home directory name', () => {
    expect(HELMGEAR_HOME_DIR_NAME).toBe('.helmgear')
    expect(DEFAULT_DSH_HOME_DISPLAY).toBe('~/.helmgear')
    expect(defaultHelmgearHome()).toBe(join(homedir(), '.helmgear'))
  })

  it('expands tilde paths without changing non-tilde paths', () => {
    expect(expandHomePath('~')).toBe(homedir())
    expect(expandHomePath('~/.helmgear')).toBe(join(homedir(), '.helmgear'))
    expect(expandHomePath('~\\.helmgear')).toBe(join(homedir(), '.helmgear'))
    expect(expandHomePath('/tmp/.helmgear')).toBe('/tmp/.helmgear')
    expect(expandHomePath('~other/.helmgear')).toBe('~other/.helmgear')
  })

  it('resolves explicit path before HELMGEAR_HOME and the default', () => {
    const envHome = join(homedir(), 'env-helmgear')

    expect(resolveHelmgearHome('/tmp/explicit-helmgear', { HELMGEAR_HOME: '~/env-helmgear' })).toBe(resolve('/tmp/explicit-helmgear'))
    expect(resolveHelmgearHome(undefined, { HELMGEAR_HOME: '~/env-helmgear' })).toBe(envHome)
    expect(resolveHelmgearHome(undefined, {})).toBe(defaultHelmgearHome())
  })

  it('treats an empty or whitespace-only HELMGEAR_HOME as unset', () => {
    expect(resolveHelmgearHome(undefined, { HELMGEAR_HOME: '' })).toBe(defaultHelmgearHome())
    expect(resolveHelmgearHome(undefined, { HELMGEAR_HOME: '   ' })).toBe(defaultHelmgearHome())
  })

  it('joins child segments onto the resolved HELMGEAR_HOME', () => {
    vi.stubEnv('HELMGEAR_HOME', '~/env-helmgear')
    expect(helmgearHomePath()).toBe(join(homedir(), 'env-helmgear'))
    expect(helmgearHomePath('storages', 'cache')).toBe(join(homedir(), 'env-helmgear', 'storages', 'cache'))
  })

  it('labels a resolved home by whether it is the default root', () => {
    expect(helmgearHomeDisplay(resolve(defaultHelmgearHome()))).toBe('~/.helmgear')
    expect(helmgearHomeDisplay('/some/other/root')).toBe('$HELMGEAR_HOME')
  })

  it('owns the shared default agents home directory name', () => {
    expect(AGENTS_HOME_DIR_NAME).toBe('.agents')
    expect(DEFAULT_AGENTS_HOME_DISPLAY).toBe('~/.agents')
    expect(defaultAgentsHome()).toBe(join(homedir(), '.agents'))
  })

  it('resolves an explicit agents home before HELMGEAR_AGENTS_HOME and the default', () => {
    const envHome = join(homedir(), 'env-agents')

    expect(resolveAgentsHome('/tmp/explicit-agents', { HELMGEAR_AGENTS_HOME: '~/env-agents' })).toBe(resolve('/tmp/explicit-agents'))
    expect(resolveAgentsHome(undefined, { HELMGEAR_AGENTS_HOME: '~/env-agents' })).toBe(envHome)
    expect(resolveAgentsHome(undefined, {})).toBe(defaultAgentsHome())
  })

  it('treats an empty or whitespace-only HELMGEAR_AGENTS_HOME as unset', () => {
    expect(resolveAgentsHome(undefined, { HELMGEAR_AGENTS_HOME: '' })).toBe(defaultAgentsHome())
    expect(resolveAgentsHome(undefined, { HELMGEAR_AGENTS_HOME: '   ' })).toBe(defaultAgentsHome())
  })

  it('labels a resolved agents home by whether it is the default root', () => {
    expect(agentsHomeDisplay(resolve(defaultAgentsHome()))).toBe('~/.agents')
    expect(agentsHomeDisplay('/some/other/root')).toBe('$HELMGEAR_AGENTS_HOME')
  })

  it.each([
    [undefined, join(homedir(), '.helmgear')],
    ['', join(homedir(), '.helmgear')],
    ['   ', join(homedir(), '.helmgear')],
    ['~/env-helmgear', join(homedir(), 'env-helmgear')],
    ['./relative-helmgear', resolve('./relative-helmgear')],
  ] as const)('resolves cache paths with HELMGEAR_HOME=%j', (home, expectedHome) => {
    vi.stubEnv('HELMGEAR_HOME', home)
    try {
      expect(helmgearCachePath()).toBe(join(expectedHome, 'cache'))
      expect(helmgearCachePath('models', 'index.json')).toBe(join(expectedHome, 'cache', 'models', 'index.json'))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('resolves configured cache homes before the environment', () => {
    vi.stubEnv('HELMGEAR_HOME', '~/env-helmgear')
    try {
      expect(helmgearCachePath({ helmgearHome: '~/explicit-helmgear' })).toBe(join(homedir(), 'explicit-helmgear', 'cache'))
      expect(helmgearCachePath({ helmgearHome: './explicit-helmgear' }, 'attachments', 'request-images'))
        .toBe(resolve('./explicit-helmgear/cache/attachments/request-images'))
      expect(helmgearCachePath({}, 'attachments')).toBe(join(homedir(), 'env-helmgear', 'cache', 'attachments'))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it.each([
    [undefined, join(homedir(), '.helmgear')],
    ['', join(homedir(), '.helmgear')],
    ['~/env-helmgear', join(homedir(), 'env-helmgear')],
    ['./relative-helmgear', resolve('./relative-helmgear')],
  ] as const)('resolves category paths with HELMGEAR_HOME=%j', (home, expectedHome) => {
    vi.stubEnv('HELMGEAR_HOME', home)
    for (const category of ['config', 'data', 'state', 'cache', 'backup'] as const) {
      expect(helmgearPath(category)).toBe(join(expectedHome, category))
      expect(helmgearPath(category, 'owner', 'file.json')).toBe(join(expectedHome, category, 'owner', 'file.json'))
    }
  })

  it('resolves a configured category home before the environment', () => {
    vi.stubEnv('HELMGEAR_HOME', '~/env-helmgear')
    expect(helmgearPath({ category: 'state', helmgearHome: '~/explicit-helmgear' }, 'logs')).toBe(join(homedir(), 'explicit-helmgear', 'state', 'logs'))
    expect(helmgearPath({ category: 'data', helmgearHome: undefined })).toBe(join(homedir(), 'env-helmgear', 'data'))
  })

  it('canonicalizes a watcher ancestor while preserving a missing suffix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'helmgear-watch-path-'))
    const target = join(root, 'target')
    const alias = join(root, 'alias')
    try {
      await mkdir(target)
      await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(canonicalizeWatchPath(alias)).resolves.toBe(await realpath(target))
      await expect(canonicalizeWatchPath(join(alias, 'later', 'config.yml'))).resolves.toBe(
        join(await realpath(target), 'later', 'config.yml'),
      )
      const file = join(root, 'file')
      await writeFile(file, 'not a directory')
      await expect(canonicalizeWatchPath(join(file, 'child'))).rejects.toMatchObject({ code: 'ENOTDIR' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
