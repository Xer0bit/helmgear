import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AgentStore } from '../src/index.ts'

const TEMPLATES = ['social-post', 'lead-finder']
const store = (): AgentStore => new AgentStore(join(mkdtempSync(join(tmpdir(), 'helmgear-agents-')), 'state', 'agents.json'))

it('an agent is a name and one template, kept across restarts', () => {
  const agents = store()
  expect(agents.list()).toEqual([])
  const maya = agents.add('Maya', 'social-post', TEMPLATES)
  expect(maya).toMatchObject({ name: 'Maya', template: 'social-post' })
  agents.add('Leo', 'lead-finder', TEMPLATES)
  expect(agents.list().map(agent => agent.name)).toEqual(['Maya', 'Leo'])
  expect(agents.get('maya')).toEqual(maya)
  expect(agents.get('nobody')).toBeUndefined()
})

it('refuses a bad name, an unknown template and a name already taken in any capitals', () => {
  const agents = store()
  agents.add('Maya', 'social-post', TEMPLATES)
  expect(() => agents.add('MAYA', 'lead-finder', TEMPLATES)).toThrow(/already an agent called Maya/)
  expect(() => agents.add('Ma ya', 'social-post', TEMPLATES)).toThrow(/agent name/)
  expect(() => agents.add('9lives', 'social-post', TEMPLATES)).toThrow(/agent name/)
  expect(() => agents.add('Leo', 'nope', TEMPLATES)).toThrow(/unknown template: nope/)
  expect(agents.list()).toHaveLength(1)
})

it('remove deletes one agent', () => {
  const agents = store()
  agents.add('Maya', 'social-post', TEMPLATES)
  agents.add('Leo', 'lead-finder', TEMPLATES)
  agents.remove('maya')
  expect(agents.list().map(agent => agent.name)).toEqual(['Leo'])
  expect(() => agents.remove('maya')).toThrow(/no agent called maya/)
})
