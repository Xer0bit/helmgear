import type { Classifier } from './route.ts'

import { systemOne } from './systemone.ts'

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
      const json = await systemOne(options, { request: text, agents }, {
        template: { type: 'choice', instructions: 'Which agent does the job that `request` asks for?', criteria: agents },
        fits: { type: 'noul', instructions: 'Does `request` ask for a job that one of the agents in `agents` does?' },
      })
      const probabilities = json.answers?.template?.probabilities as Record<string, number> | undefined
      const fits = json.answers?.fits?.noul as unknown
      if (!probabilities || typeof fits !== 'number') throw new Error('Jev returned an unexpected answer shape')
      return {
        choices: labels.map(option => ({ label: option.label, probability: probabilities[option.label] ?? 0 })),
        noneFits: 1 - fits,
      }
    },
  }
}
