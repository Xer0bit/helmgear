import type { Template } from '@helmgear/template'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { templatePatch } from '../src/index.ts'

const TEMPLATE: Template = {
  name: 'social-post', description: 'Drafts posts.', connectors: ['firecrawl', 'outbox'], dataClass: 'public', reasoningEffort: 'off',
  persona: 'You are "Sam": a social media manager.\nNever send without approval. #1 rule: {be: careful}',
  dir: '/srv/templates/social-post',
}
const TOKEN = 'gateway-token-value-123'

function parsed() {
  const text = templatePatch(TEMPLATE, { url: 'http://127.0.0.1:4555/mcp' }, { tenant: 'acme', sessionId: 'session-1' })
  // `!!js` marks an expression the harness evaluates at boot; here it is read back as its source text.
  const rows = parse(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (source: string) => ({ js: source }) }] }) as Record<string, any>[]
  return { text, rows }
}

it('sets the persona, keeping the fields the agent profile already sets', () => {
  const row = parsed().rows.find(r => r.id === 'system-prompt')!
  expect(row.config).toEqual({ includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: TEMPLATE.persona })
})

it('limits skills to the templates folder', () => {
  const row = parsed().rows.find(r => r.id === 'skill-filesystem')!
  expect(row.config).toEqual({ includeDefaultRoots: false, customSkillDirs: ['/srv/templates'] })
})

it('adds the gateway as the only MCP server, with the context headers', () => {
  const inserted = parsed().rows.find(r => r.insert)!.insert as Record<string, any>[]
  expect(inserted).toHaveLength(1)
  expect(inserted[0]).toMatchObject({
    id: 'mcp-gateway', name: '@helmgear/mcp-client',
    config: { serverName: 'gateway', transport: 'streamable-http', url: 'http://127.0.0.1:4555/mcp', failOnStartupError: true, toolCallTimeoutMs: 60000 },
  })
  expect(inserted[0]!.config.headers).toEqual({
    'Authorization': { js: '`Bearer ${process.env.HELMGEAR_GATEWAY_TOKEN}`' },
    'x-helmgear-tenant': 'acme', 'x-helmgear-session': 'session-1',
    'x-helmgear-template': 'social-post', 'x-helmgear-connectors': 'firecrawl,outbox',
  })
})

it('never contains the token value', () => {
  process.env.HELMGEAR_GATEWAY_TOKEN = TOKEN
  try { expect(parsed().text).not.toContain(TOKEN) } finally { delete process.env.HELMGEAR_GATEWAY_TOKEN }
})
