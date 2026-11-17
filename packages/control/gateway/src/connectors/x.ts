import type { Connector } from '../registry.ts'

/**
 * Posting to X with a user access token (OAuth 2.0 user context, scope
 * `tweet.write`). The 280-character limit is in the input schema, so the
 * gateway refuses a post that is too long before anyone is asked to approve it.
 */
export function xConnector(options: { accessToken: string; fetch?: typeof fetch }): Connector {
  return {
    name: 'x',
    tools: [{
      name: 'x.post',
      description: 'Publish one post on X. At most 280 characters. It is held until a person approves it.',
      inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 280 } }, required: ['text'], additionalProperties: false },
      tier: 'send',
      async run(input) {
        const response = await (options.fetch ?? fetch)('https://api.x.com/2/tweets', {
          method: 'POST',
          headers: { 'authorization': `Bearer ${options.accessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ text: input.text }),
          signal: AbortSignal.timeout(30_000),
        })
        // The response body is not quoted: an error page can echo the request, token included.
        if (!response.ok) throw new Error(`X refused the post with HTTP ${response.status}`)
        const json = await response.json() as { data?: { id?: string } }
        const id = json.data?.id
        if (!id) throw new Error('X accepted the request but returned no post id')
        return { id, url: `https://x.com/i/web/status/${id}` }
      },
    }],
  }
}
