import { lookup as dnsLookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import type { Connector } from '../registry.ts'

const MAX_MARKDOWN = 8_000
const MAX_RESEARCH_PAGE = 4_000
const TIMEOUT_MS = 30_000

export interface FirecrawlOptions {
  /** Default: `FIRECRAWL_URL`, else the self-hosted instance on `http://127.0.0.1:3002`. */
  baseUrl?: string
  /** Only for a hosted Firecrawl; the self-hosted one needs none. */
  apiKey?: string
  fetch?: typeof fetch
  /** Hosts never scraped, with their subdomains. Default: LinkedIn, whose terms prohibit scraping. */
  blockedHosts?: string[]
  /** Resolve a host name to its addresses. Default: the system resolver. */
  lookup?: (host: string) => Promise<string[]>
}

const PRIVATE = new BlockList()
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16]] as const) PRIVATE.addSubnet(net, bits, 'ipv4')
for (const [net, bits] of [['::', 127], ['fc00::', 7], ['fe80::', 10]] as const) PRIVATE.addSubnet(net, bits, 'ipv6')

function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  if (mapped) return PRIVATE.check(mapped[1]!, 'ipv4')
  return isIP(address) === 6 ? PRIVATE.check(address, 'ipv6') : PRIVATE.check(address, 'ipv4')
}

const hostOf = (url: URL): string => url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
const isBlocked = (host: string, blockedHosts: string[]): boolean => blockedHosts.some(blocked => host === blocked || host.endsWith(`.${blocked}`))

/**
 * Parse a URL the model chose and decide whether it may be scraped. The model
 * may be repeating text from a web page, so the URL must not reach services
 * on this machine or network through the scraper.
 * ponytail: the name is resolved here and again by Firecrawl, and redirects are
 * not followed here, so a host that changes its answer or redirects to a private
 * address still gets through. Close that in Firecrawl's own network policy.
 */
async function checked(raw: string, blockedHosts: string[], lookup: (host: string) => Promise<string[]>): Promise<URL> {
  const refuse = (reason: string): never => { throw new Error(`firecrawl.scrape: ${reason}`) }
  let url: URL
  try { url = new URL(raw) } catch { return refuse('invalid URL') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') refuse('URL scheme not allowed')
  const host = hostOf(url)
  if (isBlocked(host, blockedHosts)) refuse(`host not allowed: ${host}`)
  // Any IP literal, and names that only resolve inside a private network.
  if (isIP(host) || host === 'localhost' || !host.includes('.') || /\.(?:localhost|local|internal|lan|home|corp)$/.test(host)) {
    refuse(`host not allowed: ${host}`)
  }
  const addresses = await lookup(host).catch(() => refuse(`host not allowed: ${host} does not resolve`))
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) refuse(`host not allowed: ${host} resolves to a private address`)
  return url
}

/** Web search and page reading through Firecrawl. Both tools return third-party content. */
export function firecrawlConnector(options: FirecrawlOptions = {}): Connector {
  const baseUrl = (options.baseUrl ?? process.env.FIRECRAWL_URL ?? 'http://127.0.0.1:3002').replace(/\/+$/, '')
  const blockedHosts = (options.blockedHosts ?? ['linkedin.com', 'www.linkedin.com']).map(host => host.toLowerCase())
  const lookup = options.lookup ?? (async (host: string) => (await dnsLookup(host, { all: true })).map(entry => entry.address))

  async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const response = await (options.fetch ?? fetch)(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`firecrawl ${path} failed with HTTP ${response.status}`)
    const json = await response.json() as { success?: boolean; data?: Record<string, unknown>; error?: string }
    if (json.success === false || !json.data) throw new Error(`firecrawl ${path} failed: ${json.error ?? 'no data'}`)
    return json.data
  }

  return {
    name: 'firecrawl',
    tools: [
      {
        name: 'firecrawl.research',
        description: 'Research a question in one step: searches the web and returns the text of the top pages. Prefer this over separate search and read calls.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', minLength: 1 }, pages: { type: 'integer', minimum: 1, maximum: 5 } },
          required: ['query'],
          additionalProperties: false,
        },
        tier: 'read',
        untrusted: true,
        async run(input) {
          const wanted = typeof input.pages === 'number' ? input.pages : 3
          const data = await post('/v2/search', { query: input.query, limit: wanted + 3 })
          const web = Array.isArray(data.web) ? data.web as Record<string, unknown>[] : []
          const picked = web.filter((result) => {
            try { return !isBlocked(hostOf(new URL(String(result.url))), blockedHosts) } catch { return false }
          })
          // Read the candidates side by side and keep the first `wanted` that load; one model round trip instead of several.
          const read = await Promise.all(picked.map(async (result) => {
            try {
              const url = (await checked(String(result.url), blockedHosts, lookup)).href
              const page = await post('/v2/scrape', { url, formats: ['markdown'] })
              const markdown = typeof page.markdown === 'string' ? page.markdown : ''
              return { url, title: String(result.title ?? ''), text: markdown.slice(0, MAX_RESEARCH_PAGE), truncated: markdown.length > MAX_RESEARCH_PAGE }
            } catch { return { failed: String(result.url) } }
          }))
          const pages = read.filter((page): page is { url: string; title: string; text: string; truncated: boolean } => 'url' in page)
          return { pages: pages.slice(0, wanted), skipped: read.flatMap(page => 'failed' in page ? [page.failed] : []) }
        },
      },
      {
        name: 'firecrawl.search',
        description: 'Search the web. Returns a list of results with url, title and description.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: 10 } },
          required: ['query'],
          additionalProperties: false,
        },
        tier: 'read',
        untrusted: true,
        async run(input) {
          const data = await post('/v2/search', { query: input.query, limit: input.limit ?? 5 })
          const web = Array.isArray(data.web) ? data.web as Record<string, unknown>[] : []
          const allowed = web.filter((result) => {
            try { return !isBlocked(hostOf(new URL(String(result.url))), blockedHosts) } catch { return false }
          })
          return { results: allowed.map(({ url, title, description }) => ({ url, title, description })) }
        },
      },
      {
        name: 'firecrawl.scrape',
        description: 'Read one public web page and return its text as Markdown.',
        inputSchema: { type: 'object', properties: { url: { type: 'string', minLength: 1 } }, required: ['url'], additionalProperties: false },
        tier: 'read',
        untrusted: true,
        async run(input) {
          // The parsed form is what gets sent, so the scraper sees the same host that was checked.
          const url = (await checked(String(input.url), blockedHosts, lookup)).href
          const data = await post('/v2/scrape', { url, formats: ['markdown'] })
          const markdown = typeof data.markdown === 'string' ? data.markdown : ''
          return { url, markdown: markdown.slice(0, MAX_MARKDOWN), truncated: markdown.length > MAX_MARKDOWN }
        },
      },
    ],
  }
}
