import type { Classifier } from './route.ts'

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

/**
 * A classifier backed by TypeSafe's Jev. One request asks two questions over
 * the same state: which agent does the job, and whether any agent does it at
 * all (a choice always picks something, so the second question is what
 * detects a request no template covers).
 */
export function jevClassifier(options: { apiKey: string; model?: string; fetch?: typeof fetch }): Classifier {
  return {
    async classify({ text, options: labels }) {
      const agents = Object.fromEntries(labels.map(option => [option.label, option.description]))
      const response = await (options.fetch ?? fetch)(ENDPOINT, {
        method: 'POST',
        headers: { 'authorization': `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: options.model ?? 'jev-latest',
          state: { request: text, agents },
          questions: {
            template: { type: 'choice', instructions: 'Which agent does the job that `request` asks for?', criteria: agents },
            fits: { type: 'noul', instructions: 'Does `request` ask for a job that one of the agents in `agents` does?' },
          },
        }),
        signal: AbortSignal.timeout(10_000),
      })
      // The response body is not quoted in errors: it may echo the request or the key.
      if (!response.ok) throw new Error(`Jev request failed with HTTP ${response.status}`)
      const json = await response.json() as { answers?: { template?: { probabilities?: Record<string, number> }; fits?: { noul?: number } } }
      const probabilities = json.answers?.template?.probabilities
      const fits = json.answers?.fits?.noul
      if (!probabilities || typeof fits !== 'number') throw new Error('Jev returned an unexpected answer shape')
      return {
        choices: labels.map(option => ({ label: option.label, probability: probabilities[option.label] ?? 0 })),
        noneFits: 1 - fits,
      }
    },
  }
}
