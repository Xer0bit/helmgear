import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { RiskTier } from '@helmgear/template'
import type { Connector, ToolDef } from '../registry.ts'

export interface McpConnectorOptions {
  /** The connector name agents' templates list, in lowercase letters, digits and dashes. */
  name: string
  /** A Streamable HTTP MCP endpoint. */
  url: string
  headers?: Record<string, string>
  /** Risk tier per remote tool, by the remote tool's own name. */
  tiers?: Record<string, RiskTier>
  /** Tier of every tool not named in `tiers`. Default `send`: held for approval. */
  defaultTier?: RiskTier
}

/**
 * Bring any MCP server's tools behind the gateway. A tool is held for
 * approval unless you mark it `read` or `draft`, because the gateway cannot
 * know what a third-party tool does. Results are treated as third-party
 * content.
 */
export async function mcpConnector(options: McpConnectorOptions): Promise<Connector & { close(): Promise<void> }> {
  if (!/^[a-z0-9-]+$/.test(options.name)) throw new Error('connector name must be lowercase letters, digits and dashes')
  const client = new Client({ name: 'helmgear-gateway', version: '0.0.1' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } })
  await client.connect(new StreamableHTTPClientTransport(new URL(options.url), options.headers ? { requestInit: { headers: options.headers } } : {}))
  const { tools: remote } = await client.listTools()

  const taken = new Set<string>()
  const tools: ToolDef[] = remote.map((item) => {
    // Remote names can hold anything; ours are one lowercase word after the connector name.
    let id = item.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'tool'
    while (taken.has(id)) id += '_'
    taken.add(id)
    return {
      name: `${options.name}.${id}`,
      // A remote description is third-party text that ends up in the agent's instructions: one line, bounded.
      description: (item.description ?? item.name).replace(/\s+/g, ' ').trim().slice(0, 200),
      inputSchema: (item.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
      tier: options.tiers?.[item.name] ?? options.defaultTier ?? 'send',
      untrusted: true,
      async run(input) {
        const result = await client.callTool({ name: item.name, arguments: input })
        const text = (Array.isArray(result.content) ? result.content : [])
          .flatMap((part: { type?: string; text?: string }) => part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n')
        if (result.isError) throw new Error(text.slice(0, 500) || `${options.name}: the remote tool reported an error`)
        return { text }
      },
    }
  })
  return { name: options.name, tools, close: () => client.close() }
}
