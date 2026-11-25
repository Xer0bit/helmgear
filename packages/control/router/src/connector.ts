import type { RiskTier } from '@helmgear/template'
import { systemOne } from './systemone.ts'

// Starting thresholds for a yes/no probability: above is yes, below is no, between is not settled.
const YES = 0.7
const NO = 0.3
const TEXT = { type: 'string', minLength: 1, maxLength: 8000 }

/** The shape of a gateway connector, restated so this package does not depend on the gateway. */
interface JevConnector {
  name: 'jev'
  tools: { name: string; description: string; inputSchema: Record<string, unknown>; tier: RiskTier; run(input: Record<string, unknown>): Promise<unknown> }[]
}

/**
 * Jev as a tool the agent calls while it works: fast, calibrated judgements
 * about a piece of text. Jev judges and returns probabilities; the agent
 * decides what to do with them. The text is sent to TypeSafe, so leave this
 * connector out of templates that handle sensitive data.
 */
export function jevConnector(options: { apiKey: string; model?: string; fetch?: typeof fetch }): JevConnector {
  return {
    name: 'jev',
    tools: [{
      name: 'jev.judge',
      description: 'Ask up to 8 yes/no questions about one text and get a probability for each, in under a second. Use it for a judgement call you would otherwise guess (is this a sales lead, is the tone angry, does this mention pricing). Ask one concrete thing per question.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['text', 'questions'],
        properties: { text: TEXT, questions: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', minLength: 5, maxLength: 300 } } },
      },
      tier: 'read',
      async run(input) {
        const questions = input.questions as string[]
        const json = await systemOne(options, { text: input.text }, Object.fromEntries(questions.map((question, i) => [`q${i}`, { type: 'noul', instructions: `About \`text\`: ${question}` }])))
        return {
          answers: questions.map((question, i) => {
            const probability = json.answers?.[`q${i}`]?.noul as unknown
            if (typeof probability !== 'number') throw new Error('Jev returned an unexpected answer shape')
            return { question, probability, reading: probability >= YES ? 'yes' : probability <= NO ? 'no' : 'not settled by the text' }
          }),
        }
      },
    }, {
      name: 'jev.pick',
      description: 'Pick which one of 2 to 12 named options a text belongs to, with a probability for each, in under a second. Use it to sort or categorise (which product is this about, which kind of request is this). Also says whether any option fits at all.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['text', 'question', 'options'],
        properties: {
          text: TEXT,
          question: { type: 'string', minLength: 5, maxLength: 300 },
          options: {
            type: 'array', minItems: 2, maxItems: 12,
            items: { type: 'object', additionalProperties: false, required: ['name', 'description'], properties: { name: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,40}$' }, description: { type: 'string', minLength: 1, maxLength: 300 } } },
          },
        },
      },
      tier: 'read',
      async run(input) {
        const list = input.options as { name: string; description: string }[]
        const criteria = Object.fromEntries(list.map(option => [option.name, option.description]))
        if (Object.keys(criteria).length !== list.length) throw new Error('option names must be different from each other')
        // A choice always picks something, so a second question asks whether anything fits.
        const json = await systemOne(options, { text: input.text, options: criteria }, {
          pick: { type: 'choice', instructions: `About \`text\`: ${String(input.question)}`, criteria },
          fits: { type: 'noul', instructions: 'Does one of the entries in `options` describe `text`?' },
        })
        const probabilities = json.answers?.pick?.probabilities as Record<string, number> | undefined
        const fits = json.answers?.fits?.noul as unknown
        if (!probabilities || typeof fits !== 'number') throw new Error('Jev returned an unexpected answer shape')
        const ranked = list.map(option => ({ name: option.name, probability: probabilities[option.name] ?? 0 })).sort((x, y) => y.probability - x.probability)
        return { best: fits <= NO ? null : ranked[0]!.name, anyOptionFits: fits, options: ranked }
      },
    }],
  }
}
