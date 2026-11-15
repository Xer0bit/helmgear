import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, expect, it } from 'vitest'
import { createCore, startGateway, type Connector, type GatewayCore, type GatewayServer } from '../src/index.ts'

const open: { close(): Promise<void> }[] = []
afterEach(async () => { for (const item of open.splice(0)) await item.close().catch(() => {}) })

const schema = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }
function connectors(calls: unknown[]): Connector[] {
  const tool = (name: string, tier: 'read' | 'send', untrusted = false) => ({
    name, description: `does ${name}`, inputSchema: schema, tier, untrusted,
    async run(input: Record<string, unknown>) {
      calls.push(input)
      if (input.q === 'boom') throw new Error('upstream exploded')
      return { echoed: input.q }
    },
  })
  return [
    { name: 'alpha', tools: [tool('alpha.read', 'read'), tool('alpha.web', 'read', true), tool('alpha.send', 'send')] },
    { name: 'beta', tools: [tool('beta.read', 'read')] },
  ]
}

async function gateway(): Promise<{ server: GatewayServer; core: GatewayCore; calls: unknown[] }> {
  const calls: unknown[] = []
  const list = connectors(calls)
  const core = createCore({ connectors: list, stateDir: mkdtempSync(join(tmpdir(), 'helmgear-gw-')) })
  const server = await startGateway({ executor: core.executor, connectors: list })
  open.push(server)
  return { server, core, calls }
}

async function client(server: GatewayServer, allowed = ['alpha'], token?: string): Promise<Client> {
  const granted = token ?? server.grant({ tenant: 't1', sessionId: 's1', template: 'social-post', connectors: allowed })
  const mcp = new Client({ name: 'test', version: '0.0.1' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } })
  await mcp.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${granted}` } } }))
  open.push(mcp)
  return mcp
}
const text = (result: { content?: unknown }): string => (result.content as { text: string }[])[0]!.text

it('rejects a request without a granted token with 401, and again once the grant is revoked', async () => {
  const { server } = await gateway()
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  const headers = { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' }
  const post = (token?: string) => fetch(server.url, { method: 'POST', body, headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) } })
  expect((await post()).status).toBe(401)
  expect((await post('wrong')).status).toBe(401)
  const token = server.grant({ tenant: 't1', sessionId: 's1', template: 'social-post', connectors: ['alpha'] })
  expect((await post(token)).status).not.toBe(401)
  server.revoke(token)
  expect((await post(token)).status).toBe(401)
})

it('takes tenant and connectors from the grant, ignoring headers the caller sends', async () => {
  const { server, core } = await gateway()
  const token = server.grant({ tenant: 't1', sessionId: 's1', template: 'social-post', connectors: ['alpha'] })
  const mcp = new Client({ name: 'test', version: '0.0.1' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } })
  await mcp.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: {
    'authorization': `Bearer ${token}`, 'x-helmgear-tenant': 'globex', 'x-helmgear-connectors': 'alpha,beta',
  } } }))
  open.push(mcp)
  expect((await mcp.listTools()).tools.map(t => t.name)).not.toContain('beta__read')
  expect((await mcp.callTool({ name: 'beta__read', arguments: { q: 'hi' } })).isError).toBe(true)
  await mcp.callTool({ name: 'alpha__read', arguments: { q: 'hi' } })
  expect(core.audit.read().every(e => e.tenant === 't1')).toBe(true)
})

it('lists only tools of the connectors in the grant', async () => {
  const { server } = await gateway()
  const { tools } = await (await client(server, ['alpha'])).listTools()
  expect(tools.map(t => t.name).sort()).toEqual(['alpha__read', 'alpha__send', 'alpha__web'])
  expect(tools.find(t => t.name === 'alpha__read')).toMatchObject({ description: 'does alpha.read', inputSchema: schema })
  const both = await (await client(server, ['alpha', 'beta'])).listTools()
  expect(both.tools).toHaveLength(4)
})

it('calls a read tool and returns its result as text content', async () => {
  const { server, core } = await gateway()
  const result = await (await client(server)).callTool({ name: 'alpha__read', arguments: { q: 'hi' } })
  expect(JSON.parse(text(result))).toEqual({ echoed: 'hi' })
  expect(result.isError ?? false).toBe(false)
  expect(core.audit.read()).toMatchObject([{ event: 'executed', tenant: 't1', sessionId: 's1', template: 'social-post', tool: 'alpha.read' }])
})

it('labels the result of an untrusted tool as third-party content', async () => {
  const { server } = await gateway()
  const result = await (await client(server)).callTool({ name: 'alpha__web', arguments: { q: 'hi' } })
  expect(text(result)).toMatch(/^Untrusted third-party content/)
  expect(text(result)).toContain('"echoed":"hi"')
})

it('returns the queued-for-approval text for a send tool and leaves one pending action', async () => {
  const { server, core, calls } = await gateway()
  const mcp = await client(server)
  const result = await mcp.callTool({ name: 'alpha__send', arguments: { q: 'go' } })
  const [pending] = core.approvals.list('t1')
  expect(text(result)).toBe(`Queued for approval as ${pending!.actionId}. Do not retry; continue with other work.`)
  expect(calls).toHaveLength(0)
  // The model retrying the identical call does not queue a second action.
  await mcp.callTool({ name: 'alpha__send', arguments: { q: 'go' } })
  expect(core.approvals.list()).toHaveLength(1)
})

it('refuses a tool outside the allowed connectors and reports tool failures as errors', async () => {
  const { server, calls } = await gateway()
  const mcp = await client(server, ['alpha'])
  const denied = await mcp.callTool({ name: 'beta__read', arguments: { q: 'hi' } })
  expect(denied.isError).toBe(true)
  expect(text(denied)).toContain('not available')
  expect(calls).toHaveLength(0)
  const failed = await mcp.callTool({ name: 'alpha__read', arguments: { q: 'boom' } })
  expect(failed.isError).toBe(true)
  expect(text(failed)).toContain('upstream exploded')
})

it('binds to 127.0.0.1', async () => {
  const { server } = await gateway()
  expect(new URL(server.url).hostname).toBe('127.0.0.1')
  expect(new URL(server.url).pathname).toBe('/mcp')
})
