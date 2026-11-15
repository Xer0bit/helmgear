import type { Template } from '@helmgear/template'

export interface Choice { label: string; probability: number }

export interface Classifier {
  /** Probability per label, plus the probability that no label fits. */
  classify(input: { text: string; options: { label: string; description: string }[] }): Promise<{ choices: Choice[]; noneFits: number }>
}

export type RouteResult =
  | { kind: 'template'; template: Template; probability: number }
  | { kind: 'none'; reason: 'no-fit' | 'low-confidence' | 'classifier-error'; detail?: string }

const isProbability = (value: unknown): value is number => typeof value === 'number' && value >= 0 && value <= 1

/**
 * Pick the template for a request. The classifier supplies judgments; the
 * decision is the two thresholds here. Every failure is "no template": the
 * caller must never fall back to a default agent.
 */
export async function route(
  request: string,
  templates: Template[],
  classifier: Classifier,
  options: { minProbability?: number; maxNoneFits?: number } = {},
): Promise<RouteResult> {
  const minProbability = options.minProbability ?? 0.6
  const maxNoneFits = options.maxNoneFits ?? 0.5
  if (templates.length === 0 || !request.trim()) return { kind: 'none', reason: 'no-fit' }
  // Sorted, so neither the classifier's input nor a tie depends on the caller's order.
  const sorted = [...templates].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

  let answer: Awaited<ReturnType<Classifier['classify']>>
  try {
    answer = await classifier.classify({ text: request, options: sorted.map(t => ({ label: t.name, description: t.description })) })
  } catch (error) {
    return { kind: 'none', reason: 'classifier-error', detail: error instanceof Error ? error.message : String(error) }
  }
  if (!isProbability(answer.noneFits) || !answer.choices.every(choice => isProbability(choice.probability))) {
    return { kind: 'none', reason: 'classifier-error', detail: 'classifier returned a value that is not a probability' }
  }
  if (answer.noneFits > maxNoneFits) return { kind: 'none', reason: 'no-fit' }

  let best: { template: Template; probability: number } | undefined
  for (const template of sorted) {
    const probability = answer.choices.find(choice => choice.label === template.name)?.probability ?? 0
    if (!best || probability > best.probability) best = { template, probability }
  }
  if (!best || best.probability < minProbability) return { kind: 'none', reason: 'low-confidence' }
  return { kind: 'template', ...best }
}
