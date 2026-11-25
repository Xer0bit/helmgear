import { expect, it } from 'vitest'
import { jevConnector } from '../src/index.ts'

function fake(answers: Record<string, unknown>, status = 200) {
  const sent: any[] = []
  const fetch = (async (_url: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ answers }), { status }) }) as unknown as typeof globalThis.fetch
  const tools = Object.fromEntries(jevConnector({ apiKey: 'k', fetch }).tools.map(tool => [tool.name, tool]))
  return { sent, tools }
}

it('jev.judge asks one probability question per question over the text and reads each as yes, no or not settled', async () => {
  const { sent, tools } = fake({ q0: { noul: 0.92 }, q1: { noul: 0.1 }, q2: { noul: 0.5 } })
  const result = await tools['jev.judge']!.run({ text: 'Can we get a quote for 40 seats?', questions: ['Is this a sales lead?', 'Is the writer angry?', 'Is the writer a manager?'] })
  expect(result).toEqual({ answers: [
    { question: 'Is this a sales lead?', probability: 0.92, reading: 'yes' },
    { question: 'Is the writer angry?', probability: 0.1, reading: 'no' },
    { question: 'Is the writer a manager?', probability: 0.5, reading: 'not settled by the text' },
  ] })
  expect(sent[0].state).toEqual({ text: 'Can we get a quote for 40 seats?' })
  expect(sent[0].questions.q1).toEqual({ type: 'noul', instructions: 'About `text`: Is the writer angry?' })
})

it('jev.pick ranks the options and returns no best option when nothing fits', async () => {
  const options = [{ name: 'billing', description: 'About an invoice or a charge' }, { name: 'bug', description: 'Something in the product is broken' }]
  const fits = fake({ pick: { probabilities: { billing: 0.2, bug: 0.8 } }, fits: { noul: 0.9 } })
  expect(await fits.tools['jev.pick']!.run({ text: 'The export button crashes', question: 'Which kind of request is this?', options }))
    .toEqual({ best: 'bug', anyOptionFits: 0.9, options: [{ name: 'bug', probability: 0.8 }, { name: 'billing', probability: 0.2 }] })
  expect(fits.sent[0].questions.pick.criteria).toEqual({ billing: 'About an invoice or a charge', bug: 'Something in the product is broken' })
  const none = fake({ pick: { probabilities: { billing: 0.6, bug: 0.4 } }, fits: { noul: 0.05 } })
  expect(await none.tools['jev.pick']!.run({ text: 'Happy birthday!', question: 'Which kind of request is this?', options })).toMatchObject({ best: null })
})

it('a failed or malformed Jev answer is an error, never an answer', async () => {
  await expect(fake({}, 500).tools['jev.judge']!.run({ text: 't', questions: ['Is this a lead?'] })).rejects.toThrow(/HTTP 500/)
  await expect(fake({ q0: {} }).tools['jev.judge']!.run({ text: 't', questions: ['Is this a lead?'] })).rejects.toThrow(/unexpected/)
  await expect(fake({ pick: {} }).tools['jev.pick']!.run({ text: 't', question: 'Which one?', options: [{ name: 'a', description: 'x' }, { name: 'b', description: 'y' }] })).rejects.toThrow(/unexpected/)
  await expect(fake({}).tools['jev.pick']!.run({ text: 't', question: 'Which one?', options: [{ name: 'a', description: 'x' }, { name: 'a', description: 'y' }] })).rejects.toThrow(/different/)
})

it('both tools run at once and their names fit the gateway', () => {
  const { tools } = jevConnector({ apiKey: 'k' })
  expect(tools.map(tool => [tool.name, tool.tier])).toEqual([['jev.judge', 'read'], ['jev.pick', 'read']])
})
