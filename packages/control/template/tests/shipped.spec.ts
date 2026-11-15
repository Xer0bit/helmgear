import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { loadTemplates } from '../src/index.ts'

it('ships four templates with the connectors and data class each is meant to have', () => {
  const templates = loadTemplates(fileURLToPath(new URL('../../../../templates', import.meta.url)))
  expect(templates.map(t => [t.name, t.connectors, t.dataClass])).toEqual([
    ['bookkeeping-proposal', [], 'sensitive'],
    ['email-triage', ['outbox'], 'sensitive'],
    ['outreach-research', ['firecrawl', 'outbox'], 'public'],
    ['social-post', ['firecrawl', 'outbox'], 'public'],
  ])
  for (const template of templates) {
    expect(template.persona, template.name).toMatch(/untrusted/i)
    expect(template.persona, template.name).toMatch(/never (as )?instructions|not instructions/i)
    expect(template.description.length, template.name).toBeGreaterThan(20)
  }
})
