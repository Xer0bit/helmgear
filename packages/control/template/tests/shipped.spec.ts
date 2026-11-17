import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { loadTemplates } from '../src/index.ts'

it('ships its templates with the connectors and data class each is meant to have', () => {
  const templates = loadTemplates(fileURLToPath(new URL('../../../../templates', import.meta.url)))
  expect(templates.map(t => [t.name, t.connectors, t.dataClass])).toEqual([
    ['bookkeeping-proposal', [], 'sensitive'],
    ['competitor-brief', ['firecrawl'], 'public'],
    ['email-triage', ['outbox.draft'], 'sensitive'],
    ['lead-finder', ['firecrawl'], 'public'],
    ['outreach-research', ['firecrawl', 'email', 'outbox', 'memory'], 'public'],
    ['social-post', ['firecrawl', 'x', 'outbox', 'memory'], 'public'],
  ])

  for (const template of templates) {
    expect(template.reasoningEffort, template.name).toBe('off')
    expect(template.persona, template.name).not.toMatch(/mcp__/)
    expect(template.description.length, template.name).toBeGreaterThan(20)
  }
})
