import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createCore, firecrawlConnector, outboxConnector, type Connector, type ToolDef } from '../src/index.ts'

const CTX = { tenant: 't1', sessionId: 's1', template: 'social-post' }
const tool = (connector: Connector, name: string): ToolDef => connector.tools.find(t => t.name === name)!

function fakeFetch(body: unknown, status = 200) {
  const requests: { url: string; init: RequestInit }[] = []
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
  return { fetch, requests }
}
const PUBLIC = async (): Promise<string[]> => ['93.184.216.34']
const SEARCH = { success: true, data: { web: [{ url: 'https://a.example/x', title: 'A', description: 'about a', extra: 'dropped' }] } }

it('firecrawl.search posts the query to the base URL and returns the results', async () => {
  const { fetch, requests } = fakeFetch(SEARCH)
  const search = tool(firecrawlConnector({ baseUrl: 'http://fc.test:3002/', fetch }), 'firecrawl.search')
  expect(await search.run({ query: 'mcp spec' }, CTX)).toEqual({ results: [{ url: 'https://a.example/x', title: 'A', description: 'about a' }] })
  expect(requests).toHaveLength(1)
  expect(requests[0]!.url).toBe('http://fc.test:3002/v2/search')
  expect(requests[0]!.init.method).toBe('POST')
  expect(JSON.parse(requests[0]!.init.body as string)).toEqual({ query: 'mcp spec', limit: 5 })
  expect(new Headers(requests[0]!.init.headers).has('authorization')).toBe(false)

  const keyed = fakeFetch(SEARCH)
  await tool(firecrawlConnector({ baseUrl: 'http://fc.test:3002', apiKey: 'k-123', fetch: keyed.fetch }), 'firecrawl.search').run({ query: 'q', limit: 2 }, CTX)
  expect(new Headers(keyed.requests[0]!.init.headers).get('authorization')).toBe('Bearer k-123')
  expect(JSON.parse(keyed.requests[0]!.init.body as string)).toEqual({ query: 'q', limit: 2 })
})

it('firecrawl tools are read tier, untrusted, and default to the local instance', () => {
  const connector = firecrawlConnector({})
  expect(connector.tools.map(t => [t.name, t.tier, t.untrusted])).toEqual([['firecrawl.search', 'read', true], ['firecrawl.scrape', 'read', true]])
})

it('firecrawl.scrape returns the page markdown', async () => {
  const { fetch, requests } = fakeFetch({ success: true, data: { markdown: '# Hello', metadata: { title: 'T' } } })
  const scrape = tool(firecrawlConnector({ baseUrl: 'http://fc.test:3002', fetch, lookup: PUBLIC }), 'firecrawl.scrape')
  expect(await scrape.run({ url: 'https://example.com/page' }, CTX)).toEqual({ url: 'https://example.com/page', markdown: '# Hello', truncated: false })
  expect(requests[0]!.url).toBe('http://fc.test:3002/v2/scrape')
  expect(JSON.parse(requests[0]!.init.body as string)).toEqual({ url: 'https://example.com/page', formats: ['markdown'] })
})

it('firecrawl.scrape refuses linkedin.com and its subdomains without calling fetch', async () => {
  const { fetch, requests } = fakeFetch({})
  const scrape = tool(firecrawlConnector({ fetch, lookup: PUBLIC }), 'firecrawl.scrape')
  for (const url of ['https://linkedin.com/in/x', 'https://www.linkedin.com/in/x', 'https://uk.linkedin.com/in/x', 'https://LinkedIn.com./x']) {
    await expect(scrape.run({ url }, CTX)).rejects.toThrow(/not allowed/)
  }
  expect(requests).toHaveLength(0)
  // A host that merely ends with the same letters is not a subdomain.
  await scrape.run({ url: 'https://notlinkedin.com/x' }, CTX).catch(() => {})
  expect(requests).toHaveLength(1)
})

it('firecrawl.scrape refuses local and private addresses and non-web schemes without calling fetch', async () => {
  const { fetch, requests } = fakeFetch({})
  const scrape = tool(firecrawlConnector({ fetch, lookup: PUBLIC }), 'firecrawl.scrape')
  for (const url of ['http://localhost:5432/', 'http://127.0.0.1:3002/', 'http://10.0.0.5/', 'http://192.168.1.1/', 'http://169.254.169.254/latest', 'http://[::1]/', 'http://db.internal/', 'http://localhost../', 'file:///etc/passwd', 'not a url']) {
    await expect(scrape.run({ url }, CTX), url).rejects.toThrow(/not allowed|invalid/i)
  }
  expect(requests).toHaveLength(0)
})

it('firecrawl tools surface an HTTP error status as a thrown error with the status code', async () => {
  const { fetch } = fakeFetch({ success: false, error: 'rate limited' }, 429)
  const connector = firecrawlConnector({ fetch, lookup: PUBLIC })
  await expect(tool(connector, 'firecrawl.search').run({ query: 'q' }, CTX)).rejects.toThrow(/429/)
  await expect(tool(connector, 'firecrawl.scrape').run({ url: 'https://example.com' }, CTX)).rejects.toThrow(/429/)
})

it('firecrawl.scrape truncates a very long page and says so', async () => {
  const { fetch } = fakeFetch({ success: true, data: { markdown: 'x'.repeat(50_000) } })
  const result = await tool(firecrawlConnector({ fetch, lookup: PUBLIC }), 'firecrawl.scrape').run({ url: 'https://example.com' }, CTX) as { markdown: string; truncated: boolean }
  expect(result.markdown).toHaveLength(20_000)
  expect(result.truncated).toBe(true)
})

it('outbox.draft writes a draft file and returns its id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helmgear-outbox-'))
  const draft = tool(outboxConnector({ dir }), 'outbox.draft')
  expect(draft.tier).toBe('draft')
  const message = { to: 'a@example.com', subject: 'Hi', body: 'Hello' }
  const { id } = await draft.run(message, CTX) as { id: string }
  expect(JSON.parse(readFileSync(join(dir, 'drafts', `${id}.json`), 'utf8'))).toMatchObject({ ...message, tenant: 't1', sessionId: 's1' })
})

it('outbox.send writes to sent/ only when run is invoked', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'helmgear-outbox-'))
  const dir = join(stateDir, 'outbox')
  const core = createCore({ connectors: [outboxConnector({ dir })], stateDir })
  const message = { to: 'press@example.com', subject: 'News', body: 'Launch' }
  expect(await core.executor.call('outbox.send', message, CTX, 'k1')).toEqual({ status: 'pending', actionId: 'k1' })
  expect(readdirSync(join(dir, 'sent'))).toEqual([])
  const approved = await core.approvals.approve('k1', 'sam')
  expect(approved.status).toBe('executed')
  const [file] = readdirSync(join(dir, 'sent'))
  expect(JSON.parse(readFileSync(join(dir, 'sent', file!), 'utf8'))).toMatchObject(message)
})

it('outbox tools refuse a message without a recipient', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'helmgear-outbox-'))
  const core = createCore({ connectors: [outboxConnector({ dir: join(stateDir, 'outbox') })], stateDir })
  expect(await core.executor.call('outbox.draft', { subject: 's', body: 'b' }, CTX, 'k1')).toMatchObject({ status: 'refused' })
})

it('firecrawl.scrape refuses a public-looking name that resolves to a private address', async () => {
  const { fetch, requests } = fakeFetch({})
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '::1', 'fd00::1', '::ffff:192.168.0.1']) {
    const scrape = tool(firecrawlConnector({ fetch, lookup: async () => ['93.184.216.34', address] }), 'firecrawl.scrape')
    await expect(scrape.run({ url: 'http://127.0.0.1.nip.io:3002/' }, CTX), address).rejects.toThrow(/not allowed/)
  }
  const unresolvable = tool(firecrawlConnector({ fetch, lookup: async () => { throw new Error('ENOTFOUND') } }), 'firecrawl.scrape')
  await expect(unresolvable.run({ url: 'https://nope.example/' }, CTX)).rejects.toThrow(/not allowed|resolve/)
  expect(requests).toHaveLength(0)
})

it('firecrawl.scrape sends the parsed URL, so a blocked host cannot hide behind parser differences', async () => {
  const { fetch, requests } = fakeFetch({ success: true, data: { markdown: 'x' } })
  const scrape = tool(firecrawlConnector({ fetch, lookup: PUBLIC }), 'firecrawl.scrape')
  await scrape.run({ url: 'https://EXAMPLE.com:443/a b' }, CTX)
  expect(JSON.parse(requests[0]!.init.body as string).url).toBe('https://example.com/a%20b')
})

it('firecrawl.search leaves out results on blocked hosts', async () => {
  const { fetch } = fakeFetch({ success: true, data: { web: [
    { url: 'https://www.linkedin.com/in/x', title: 'L', description: 'd' }, { url: 'https://a.example/x', title: 'A', description: 'd' }, { url: 'not a url', title: 'B', description: 'd' },
  ] } })
  const result = await tool(firecrawlConnector({ fetch }), 'firecrawl.search').run({ query: 'q' }, CTX) as { results: { url: string }[] }
  expect(result.results.map(r => r.url)).toEqual(['https://a.example/x'])
})
