const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

/** Answers yes/no statements about some material with a probability each. It judges; it never decides. */
export interface Judge {
  /** Probability (0..1) that each statement is true of `state`. Keys of the result equal keys of `statements`. */
  judge(state: unknown, statements: Record<string, string>): Promise<Record<string, number>>
}

/** A judge backed by TypeSafe's Jev: one request, one probability question per statement. */
export function jevJudge(options: { apiKey: string; model?: string; fetch?: typeof fetch }): Judge {
  return {
    async judge(state, statements) {
      const response = await (options.fetch ?? fetch)(ENDPOINT, {
        method: 'POST',
        headers: { 'authorization': `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: options.model ?? 'jev-latest',
          state,
          questions: Object.fromEntries(Object.entries(statements).map(([key, instructions]) => [key, { type: 'noul', instructions }])),
        }),
        signal: AbortSignal.timeout(10_000),
      })
      // The response body is not quoted in errors: it may echo the request or the key.
      if (!response.ok) throw new Error(`Jev request failed with HTTP ${response.status}`)
      const json = await response.json() as { answers?: Record<string, { noul?: number }> }
      return Object.fromEntries(Object.keys(statements).map((key) => {
        const value = json.answers?.[key]?.noul
        if (typeof value !== 'number') throw new Error(`Jev returned an unexpected answer shape for "${key}"`)
        return [key, value]
      }))
    },
  }
}
