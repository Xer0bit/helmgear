import type { Template } from '@helmgear/template'
import { expect, it } from 'vitest'
import { jevClassifier, route, type Classifier } from '../src/index.ts'

const template = (name: string): Template => ({
  name, description: `Does ${name}.`, persona: 'p', connectors: [], dataClass: 'public', reasoningEffort: 'off', maxToolCalls: 12, dir: `/t/${name}`,
})
const TEMPLATES = [template('social-post'), template('email-triage'), template('bookkeeping-proposal')]

function scores(byLabel: Record<string, number>, noneFits = 0.1): Classifier & { calls: number } {
  return {
    calls: 0,
    async classify(input) {
      this.calls++
      return { choices: input.options.map(o => ({ label: o.label, probability: byLabel[o.label] ?? 0 })), noneFits }
    },
  }
}

it('returns the template whose probability is highest and at least 0.6', async () => {
  const result = await route('draft a tweet', TEMPLATES, scores({ 'social-post': 0.6, 'email-triage': 0.3 }))
  expect(result).toEqual({ kind: 'template', template: TEMPLATES[0], probability: 0.6 })
})

it('passes the request and each template name and description to the classifier', async () => {
  let seen: unknown
  await route('draft a tweet', TEMPLATES, { async classify(input) { seen = input; return { choices: [], noneFits: 0 } } })
  expect(seen).toEqual({ text: 'draft a tweet', options: [
    { label: 'bookkeeping-proposal', description: 'Does bookkeeping-proposal.' },
    { label: 'email-triage', description: 'Does email-triage.' },
    { label: 'social-post', description: 'Does social-post.' },
  ] })
})

it('returns none/low-confidence when the best probability is 0.59', async () => {
  expect(await route('x', TEMPLATES, scores({ 'social-post': 0.59 }))).toMatchObject({ kind: 'none', reason: 'low-confidence' })
})

it('returns none/no-fit when noneFits exceeds 0.5 even if a label scores 0.9', async () => {
  expect(await route('x', TEMPLATES, scores({ 'social-post': 0.9 }, 0.51))).toMatchObject({ kind: 'none', reason: 'no-fit' })
  expect(await route('x', TEMPLATES, scores({ 'social-post': 0.9 }, 0.5))).toMatchObject({ kind: 'template' })
})

it('returns none/classifier-error with the message when classify rejects', async () => {
  const failing: Classifier = { classify: async () => { throw new Error('jev unreachable') } }
  expect(await route('x', TEMPLATES, failing)).toEqual({ kind: 'none', reason: 'classifier-error', detail: 'jev unreachable' })
})

it('returns none/classifier-error when the classifier returns a probability that is not a number between 0 and 1', async () => {
  expect(await route('x', TEMPLATES, scores({ 'social-post': Number.NaN }))).toMatchObject({ kind: 'none', reason: 'classifier-error' })
  expect(await route('x', TEMPLATES, scores({ 'social-post': 0.9 }, Number.NaN))).toMatchObject({ kind: 'none', reason: 'classifier-error' })
})

it('ignores a label the classifier invents', async () => {
  const inventing: Classifier = { classify: async () => ({ choices: [{ label: 'root-shell', probability: 0.99 }, { label: 'email-triage', probability: 0.7 }], noneFits: 0 }) }
  expect(await route('x', TEMPLATES, inventing)).toMatchObject({ kind: 'template', template: { name: 'email-triage' } })
})

it('returns none/no-fit for an empty template list or an empty request without calling the classifier', async () => {
  const classifier = scores({ 'social-post': 0.9 })
  expect(await route('x', [], classifier)).toMatchObject({ kind: 'none', reason: 'no-fit' })
  expect(await route('   ', TEMPLATES, classifier)).toMatchObject({ kind: 'none', reason: 'no-fit' })
  expect(classifier.calls).toBe(0)
})

it('the result does not depend on the order templates are passed in', async () => {
  const classifier = scores({ 'social-post': 0.7, 'email-triage': 0.7 })
  const forward = await route('x', TEMPLATES, classifier)
  const backward = await route('x', [...TEMPLATES].reverse(), classifier)
  expect(backward).toEqual(forward)
  expect(forward).toMatchObject({ kind: 'template', template: { name: 'email-triage' } })
})

it('honours custom thresholds', async () => {
  expect(await route('x', TEMPLATES, scores({ 'social-post': 0.4 }, 0.8), { minProbability: 0.3, maxNoneFits: 0.9 })).toMatchObject({ kind: 'template' })
})

const JEV_OK = { model: 'jev-1.14.0', answers: {
  template: { type: 'choice', choice: 'social-post', confidence: 1, probabilities: { 'social-post': 0.9, 'email-triage': 0.1 } },
  fits: { type: 'noul', noul: 0.8 },
} }
function fakeFetch(body: unknown, status = 200) {
  const requests: { url: string; init: RequestInit }[] = []
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify(body), { status })
  }) as typeof globalThis.fetch
  return { fetch, requests }
}
const OPTIONS = [{ label: 'social-post', description: 'Drafts posts.' }, { label: 'email-triage', description: 'Sorts email.' }]

it('jevClassifier asks one choice and one fit question and maps the answers', async () => {
  const { fetch, requests } = fakeFetch(JEV_OK)
  const result = await jevClassifier({ apiKey: 'key-abc', fetch }).classify({ text: 'draft a tweet', options: OPTIONS })
  expect(result.noneFits).toBeCloseTo(0.2)
  expect(result.choices).toEqual([{ label: 'social-post', probability: 0.9 }, { label: 'email-triage', probability: 0.1 }])
  expect(requests[0]!.url).toBe('https://api.typesafe.ai/v1/systemone')
  expect(new Headers(requests[0]!.init.headers).get('authorization')).toBe('Bearer key-abc')
  const body = JSON.parse(requests[0]!.init.body as string)
  expect(body.state).toEqual({ request: 'draft a tweet', agents: { 'social-post': 'Drafts posts.', 'email-triage': 'Sorts email.' } })
  expect(body.questions.template).toMatchObject({ type: 'choice', criteria: { 'social-post': 'Drafts posts.', 'email-triage': 'Sorts email.' } })
  expect(body.questions.fits.type).toBe('noul')
})

it('jevClassifier throws on an HTTP error or a malformed answer, without the key in the message', async () => {
  const denied = jevClassifier({ apiKey: 'key-abc', fetch: fakeFetch({ error: 'bad key key-abc' }, 401).fetch })
  const error = await denied.classify({ text: 'x', options: OPTIONS }).catch((e: Error) => e)
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toContain('401')
  expect((error as Error).message).not.toContain('key-abc')
  const malformed = jevClassifier({ apiKey: 'k', fetch: fakeFetch({ answers: {} }).fetch })
  await expect(malformed.classify({ text: 'x', options: OPTIONS })).rejects.toThrow(/unexpected/)
})
