import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { TemplateError, type DataClass, type ReasoningEffort, type Template } from './types.ts'

const NAME = /^[a-z0-9-]{1,48}$/
const KEYS = ['persona', 'connectors', 'dataClass', 'reasoningEffort', 'maxToolCalls']
const DATA_CLASSES: readonly string[] = ['public', 'sensitive'] satisfies DataClass[]
const EFFORTS: readonly string[] = ['off', 'low', 'high', 'max'] satisfies ReasoningEffort[]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function loadOne(dir: string, folder: string): Template {
  const file = join(dir, 'SKILL.md')
  const fail = (field: string | undefined, problem: string): never => { throw new TemplateError(file, field, problem) }
  if (!existsSync(file)) fail(undefined, 'file is missing')
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(readFileSync(file, 'utf8'))
  if (!match) return fail('frontmatter', 'file must start with a YAML block between --- lines')
  let front: unknown
  try { front = parseYaml(match[1]!) } catch (error) { fail('frontmatter', `invalid YAML: ${(error as Error).message}`) }
  if (!isRecord(front)) return fail('frontmatter', 'must be a mapping')

  const text = (value: unknown, field: string): string =>
    typeof value === 'string' && value.trim() ? value.trim() : fail(field, 'must be a non-empty string')
  const name = text(front.name, 'name')
  if (!NAME.test(name)) fail('name', 'must match [a-z0-9-]{1,48}')
  if (name !== folder) fail('name', `must equal its folder name "${folder}"`)
  const description = text(front.description, 'description')

  const meta = isRecord(front.metadata) ? front.metadata.helmgear : undefined
  if (!isRecord(meta)) return fail('metadata.helmgear', 'must be a mapping')
  // A misspelt key would otherwise fall back to a default without a word.
  for (const key of Object.keys(meta)) if (!KEYS.includes(key)) fail(`metadata.helmgear.${key}`, `unknown key; expected one of ${KEYS.join(', ')}`)
  const persona = text(meta.persona, 'metadata.helmgear.persona')
  const connectors = meta.connectors
  if (!Array.isArray(connectors) || !connectors.every((c): c is string => typeof c === 'string' && c.length > 0)) {
    return fail('metadata.helmgear.connectors', 'must be an array of connector names')
  }
  if (typeof meta.dataClass !== 'string' || !DATA_CLASSES.includes(meta.dataClass)) {
    return fail('metadata.helmgear.dataClass', `must be one of ${DATA_CLASSES.join(', ')}`)
  }
  const effort = meta.reasoningEffort ?? 'off'
  if (typeof effort !== 'string' || !EFFORTS.includes(effort)) {
    return fail('metadata.helmgear.reasoningEffort', `must be one of ${EFFORTS.join(', ')}`)
  }
  const budget = meta.maxToolCalls ?? 12
  if (typeof budget !== 'number' || !Number.isInteger(budget) || budget < 1) return fail('metadata.helmgear.maxToolCalls', 'must be a whole number of at least 1')
  return {
    name, description, persona, connectors: [...connectors], maxToolCalls: budget,
    dataClass: meta.dataClass as DataClass, reasoningEffort: effort as ReasoningEffort, dir,
  }
}

/** Load every `<root>/<name>/SKILL.md`, sorted by name. A malformed template throws; none is skipped. */
export function loadTemplates(root: string): Template[] {
  const base = resolve(root)
  return readdirSync(base)
    // statSync follows symlinks, so a linked template folder loads like any other.
    .filter(name => statSync(join(base, name), { throwIfNoEntry: false })?.isDirectory())
    .map(name => loadOne(join(base, name), name))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}
