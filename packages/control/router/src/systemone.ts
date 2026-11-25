const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

/**
 * One call to TypeSafe's System One endpoint. A connection failure or a brief
 * outage (429, 5xx) is tried once more; anything else is an error at once.
 * The response body is never quoted in an error: it may echo the request or the key.
 */
export async function systemOne(options: { apiKey: string; model?: string | undefined; fetch?: typeof fetch | undefined }, state: unknown, questions: Record<string, unknown>): Promise<{ answers?: Record<string, Record<string, unknown>> }> {
  const send = (): Promise<Response> => (options.fetch ?? fetch)(ENDPOINT, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: options.model ?? 'jev-latest', state, questions }),
    signal: AbortSignal.timeout(10_000),
  })
  let response: Response
  try {
    response = await send()
    if (response.status === 429 || response.status >= 500) response = await send()
  } catch {
    response = await send()
  }
  if (!response.ok) throw new Error(`Jev request failed with HTTP ${response.status}`)
  return await response.json() as { answers?: Record<string, Record<string, unknown>> }
}
