// Which connectors the console starts with. Firecrawl, the local outbox and
// memory are always on; real ones switch on when their settings are present:
//   email  SMTP_HOST, SMTP_FROM (and SMTP_PORT, SMTP_USER, SMTP_PASS) in .env
//   x      X_ACCESS_TOKEN in .env
//   others any MCP server listed in connectors.json (see connectors.example.json)
import { existsSync, readFileSync } from 'node:fs'
import { firecrawlConnector, mcpConnector, memoryConnector, outboxConnector, smtpConnector, xConnector, type Connector, type McpConnectorOptions, type MemoryStore } from '@helmgear/gateway'

export interface Connected { connectors: Connector[]; lines: string[]; close(): Promise<void> }

export async function connect(stateDir: string, memory: MemoryStore): Promise<Connected> {
  const env = process.env
  const connectors: Connector[] = [firecrawlConnector(), outboxConnector({ dir: `${stateDir}/outbox` }), memoryConnector({ store: memory })]
  const lines: string[] = []
  const closers: (() => Promise<void>)[] = []

  if (env.SMTP_HOST && env.SMTP_FROM) {
    connectors.push(smtpConnector({
      host: env.SMTP_HOST, from: env.SMTP_FROM,
      ...(env.SMTP_PORT ? { port: Number(env.SMTP_PORT) } : {}), ...(env.SMTP_USER ? { user: env.SMTP_USER } : {}), ...(env.SMTP_PASS ? { pass: env.SMTP_PASS } : {}),
    }))
    // With real email on, the stand-in keeps only its draft tool, so an agent has one way to send.
    const outbox = connectors.find(connector => connector.name === 'outbox')!
    outbox.tools = outbox.tools.filter(tool => tool.name !== 'outbox.send')
    lines.push(`on   email: real email through ${env.SMTP_HOST} as ${env.SMTP_FROM}`)
  } else lines.push('off  email: add SMTP_HOST and SMTP_FROM (plus SMTP_PORT, SMTP_USER, SMTP_PASS) to .env; until then "send" writes a file')

  if (env.X_ACCESS_TOKEN) {
    connectors.push(xConnector({ accessToken: env.X_ACCESS_TOKEN }))
    lines.push('on   x: posts to X with your access token')
  } else lines.push('off  x: add X_ACCESS_TOKEN to .env to post on X')

  const file = env.HELMGEAR_CONNECTORS ?? 'connectors.json'
  if (existsSync(file)) {
    const servers = JSON.parse(readFileSync(file, 'utf8')) as McpConnectorOptions[]
    for (const server of servers) {
      try {
        // Header values may name an environment variable as ${NAME}, so no secret has to live in the file.
        const headers = Object.fromEntries(Object.entries(server.headers ?? {}).map(([key, value]) => [key, value.replace(/\$\{(\w+)\}/g, (_m, name: string) => env[name] ?? '')]))
        const connector = await mcpConnector({ ...server, headers })
        connectors.push(connector)
        closers.push(() => connector.close())
        const held = connector.tools.filter(tool => tool.tier === 'send').length
        lines.push(`on   ${server.name}: ${connector.tools.length} tools from its MCP server, ${held} held for approval`)
      } catch (error) {
        lines.push(`off  ${server.name}: could not connect to its MCP server (${error instanceof Error ? error.message.slice(0, 120) : 'error'})`)
      }
    }
  } else lines.push(`off  other services: list MCP servers in ${file} (copy connectors.example.json) for LinkedIn, Instagram, accounting and more`)

  return { connectors, lines, close: async () => { await Promise.all(closers.map(close => close().catch(() => {}))) } }
}
