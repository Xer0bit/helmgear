import { expect, it } from 'vitest'
import { jevClassifier } from '../src/index.ts'

it.skipIf(!process.env.TYPESAFE_API_KEY)('Jev scores a social-post option above an email-triage option for a tweet request', async () => {
  const classifier = jevClassifier({ apiKey: process.env.TYPESAFE_API_KEY! })
  const options = [
    { label: 'social-post', description: 'Researches a topic and drafts a social media post.' },
    { label: 'email-triage', description: 'Classifies an incoming email and drafts a reply.' },
  ]
  const result = await classifier.classify({ text: 'draft a tweet about our launch', options })
  const score = (label: string): number => result.choices.find(c => c.label === label)!.probability
  expect(score('social-post')).toBeGreaterThan(score('email-triage'))
  expect(result.noneFits).toBeLessThan(0.5)
  const offTopic = await classifier.classify({ text: 'What is the boiling point of water on Everest?', options })
  expect(offTopic.noneFits).toBeGreaterThan(0.5)
}, 30_000)
