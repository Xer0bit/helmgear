import { isIP } from 'node:net'
import type { Connector } from '../registry.ts'

const MAX_MARKDOWN = 20_000
const TIMEOUT_MS = 30_000

export interface FirecrawlOptions {
  /** Default: `FIRECRAWL_URL`, else the self-hosted instance on `http://127.0.0.1:3002`. */
  baseUrl?: string
  /** Only for a hosted Firecrawl; the self-hosted one needs none. */
  apiKey?: string
  fetch?: typeof fetch
  /** Hosts never scraped, with their subdomains. Default: LinkedIn, whose terms prohibit scraping. */
  blockedHosts?: string[]
}

/**
 * Why a URL may not be scraped, or undefined when it may. The URL comes from
 * the model, which may be repeating text from a web page, so it must not reach
 * services on this machine or network through the scraper.
 * ponytail: checks the name, not what it resolves to; a public name that points
 * at a private address still gets through. Resolve and re-check if that matters.
 */
function refusal(raw: string, blockedHosts: string[]): string | undefined {
  let url: URL
  try { url = new URL(raw) } catch { return 'invalid URL' }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'URL scheme not allowed'
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (blockedHosts.some(blocked => host === blocked || host.endsWith(`.${blocked}`))) return `host not allowed: ${host}`
  // Any IP literal, and names that only resolve inside a private network.
  if (isIP(host) || host === 'localhost' || !host.includes('.') || /\.(?:localhost|local|internal|lan|home|corp)$/.test(host)) {
    return `host not allowed: ${host}`
  }
  return undefined
}

/** Web search and page reading through Firecrawl. Both tools return third-party content. */
export function firecrawlConnector(options: FirecrawlOptions = {}): Connector {
  const baseUrl = (options.baseUrl ?? process.env.FIRECRAWL_URL ?? 'http://127.0.0.1:3002').replace(/\/+$/, '')
  const blockedHosts = (options.blockedHosts ?? ['linkedin.com', 'www.linkedin.com']).map(host => host.toLowerCase())

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
          return { results: web.map(({ url, title, description }) => ({ url, title, description })) }
        },
      },
      {
        name: 'firecrawl.scrape',
        description: 'Read one public web page and return its text as Markdown.',
        inputSchema: { type: 'object', properties: { url: { type: 'string', minLength: 1 } }, required: ['url'], additionalProperties: false },
        tier: 'read',
        untrusted: true,
        async run(input) {
          const url = String(input.url)
          const reason = refusal(url, blockedHosts)
          if (reason) throw new Error(`firecrawl.scrape: ${reason}`)
          const data = await post('/v2/scrape', { url, formats: ['markdown'] })
          const markdown = typeof data.markdown === 'string' ? data.markdown : ''
          return { url, markdown: markdown.slice(0, MAX_MARKDOWN), truncated: markdown.length > MAX_MARKDOWN }
        },
      },
    ],
  }
}
