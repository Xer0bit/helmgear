import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { loadTemplates, TemplateError } from '../src/index.ts'

const VALID = { persona: 'You are a social media manager.', connectors: ['firecrawl', 'outbox'], dataClass: 'public' }

function root(): string { return mkdtempSync(join(tmpdir(), 'helmgear-tpl-')) }

/** Write <dir>/<folder>/SKILL.md; `meta` is the metadata.helmgear object, `name` the frontmatter name. */
function write(dir: string, folder: string, meta: Record<string, unknown>, name = folder): string {
  mkdirSync(join(dir, folder), { recursive: true })
  const file = join(dir, folder, 'SKILL.md')
  const front = JSON.stringify({ name, description: `Does ${folder}.`, metadata: { helmgear: meta } })
  writeFileSync(file, `---\n${front}\n---\n\nBody of ${folder}.\n`)
  return file
}

function failure(dir: string): TemplateError {
  try { loadTemplates(dir) } catch (error) { if (error instanceof TemplateError) return error; throw error }
  throw new Error('expected loadTemplates to throw')
}

it('loads a valid template', () => {
  const dir = root()
  write(dir, 'social-post', VALID)
  expect(loadTemplates(dir)).toEqual([{
    name: 'social-post', description: 'Does social-post.', persona: VALID.persona,
    connectors: ['firecrawl', 'outbox'], dataClass: 'public', reasoningEffort: 'off', maxToolCalls: 12, dir: join(dir, 'social-post'),
  }])
})

it('rejects a missing persona naming file and field', () => {
  const dir = root()
  write(dir, 'a', { ...VALID, persona: undefined })
  const error = failure(dir)
  expect(error.field).toBe('metadata.helmgear.persona')
  expect(error.file.endsWith('SKILL.md')).toBe(true)
  expect(error.message).toContain(error.file)
})

it('rejects a name that differs from its folder', () => {
  const dir = root()
  write(dir, 'a', VALID, 'b')
  expect(failure(dir).field).toBe('name')
})

it('rejects an unknown dataClass', () => {
  const dir = root()
  write(dir, 'a', { ...VALID, dataClass: 'secret' })
  expect(failure(dir).field).toBe('metadata.helmgear.dataClass')
})

it('rejects connectors that is not a string array', () => {
  const dir = root()
  write(dir, 'a', { ...VALID, connectors: ['ok', 3] })
  expect(failure(dir).field).toBe('metadata.helmgear.connectors')
})

it('rejects an unknown reasoningEffort', () => {
  const dir = root()
  write(dir, 'a', { ...VALID, reasoningEffort: 'turbo' })
  expect(failure(dir).field).toBe('metadata.helmgear.reasoningEffort')
})

it('rejects a folder without SKILL.md and a file without frontmatter', () => {
  const empty = root()
  mkdirSync(join(empty, 'a'))
  expect(failure(empty).file).toBe(join(empty, 'a', 'SKILL.md'))
  const bare = root()
  mkdirSync(join(bare, 'a'))
  writeFileSync(join(bare, 'a', 'SKILL.md'), 'no frontmatter here\n')
  expect(failure(bare).field).toBe('frontmatter')
})

it('returns templates sorted by name and ignores files that are not folders', () => {
  const dir = root()
  write(dir, 'zeta', VALID)
  write(dir, 'alpha', VALID)
  writeFileSync(join(dir, 'README.md'), 'not a template')
  expect(loadTemplates(dir).map(t => t.name)).toEqual(['alpha', 'zeta'])
})

it('rejects an unknown key under metadata.helmgear', () => {
  const dir = root()
  write(dir, 'a', { ...VALID, reasoningEfort: 'low' })
  expect(failure(dir).field).toBe('metadata.helmgear.reasoningEfort')
})

it('loads a template whose folder is a symlink', () => {
  const real = root()
  write(real, 'alpha', VALID)
  const dir = root()
  symlinkSync(join(real, 'alpha'), join(dir, 'alpha'))
  expect(loadTemplates(dir).map(t => t.name)).toEqual(['alpha'])
})

it('reads an optional tool budget and rejects one that is not a positive whole number', () => {
  const dir = root()
  write(dir, 'a', { ...VALID, maxToolCalls: 6 })
  write(dir, 'b', VALID)
  expect(loadTemplates(dir).map(t => t.maxToolCalls)).toEqual([6, 12])
  const bad = root()
  write(bad, 'a', { ...VALID, maxToolCalls: 0 })
  expect(failure(bad).field).toBe('metadata.helmgear.maxToolCalls')
})
