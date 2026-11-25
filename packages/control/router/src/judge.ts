import { systemOne } from './systemone.ts'

/** Answers yes/no statements about some material with a probability each. It judges; it never decides. */
export interface Judge {
  /** Probability (0..1) that each statement is true of `state`. Keys of the result equal keys of `statements`. */
  judge(state: unknown, statements: Record<string, string>): Promise<Record<string, number>>
}

/** A judge backed by TypeSafe's Jev: one request, one probability question per statement. */
export function jevJudge(options: { apiKey: string; model?: string; fetch?: typeof fetch }): Judge {
  return {
    async judge(state, statements) {
      const json = await systemOne(options, state, Object.fromEntries(Object.entries(statements).map(([key, instructions]) => [key, { type: 'noul', instructions }])))
      return Object.fromEntries(Object.keys(statements).map((key) => {
        const value = json.answers?.[key]?.noul as unknown
        if (typeof value !== 'number') throw new Error(`Jev returned an unexpected answer shape for "${key}"`)
        return [key, value]
      }))
    },
  }
}
