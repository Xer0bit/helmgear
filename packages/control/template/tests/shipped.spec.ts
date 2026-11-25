import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { loadTemplates } from '../src/index.ts'

it('ships its templates with the connectors and data class each is meant to have', () => {
  const templates = loadTemplates(fileURLToPath(new URL('../../../../templates', import.meta.url)))
  expect(templates.map(t => [t.name, t.connectors, t.dataClass])).toEqual([
    ['bookkeeping-proposal', ['kb'], 'sensitive'],
    ['competitor-brief', ['firecrawl', 'kb'], 'public'],
    ['email-triage', ['outbox.draft', 'kb'], 'sensitive'],
    ['knowledge-answer', ['kb'], 'public'],
    ['lead-finder', ['firecrawl', 'kb'], 'public'],
    ['outreach-research', ['firecrawl', 'email', 'outbox', 'memory', 'kb'], 'public'],
    ['social-post', ['firecrawl', 'x', 'outbox', 'memory', 'kb'], 'public'],
  ])

  for (const template of templates) {
    expect(template.reasoningEffort, template.name).toBe('off')
    expect(template.persona, template.name).not.toMatch(/mcp__/)
    expect(template.description.length, template.name).toBeGreaterThan(20)
  }
})
