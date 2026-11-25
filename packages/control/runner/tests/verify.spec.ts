import type { Judge } from '@helmgear/router'
import { expect, it } from 'vitest'
import { verifyReply, type ActionFact } from '../src/index.ts'

/** A judge that answers each statement key with a fixed probability. */
const judge = (answers: Partial<Record<'claimsSent' | 'claimsDraft' | 'claimsDelivered', number>>): Judge & { states: unknown[] } => ({
  states: [],
  async judge(state, statements) {
    this.states.push(state)
    return Object.fromEntries(Object.keys(statements).map(key => [key, answers[key as 'claimsSent'] ?? 0.02]))
  },
})
const SEND: ActionFact = { tool: 'outbox.send', event: 'pending', actionId: 'a1' }
const DRAFT: ActionFact = { tool: 'outbox.draft', event: 'executed', actionId: 'a2' }
const READ: ActionFact = { tool: 'firecrawl.scrape', event: 'executed', actionId: 'a3' }

it('passes when a claimed send has a pending send action', async () => {
  const j = judge({ claimsSent: 0.95 })
  expect(await verifyReply('Queued for approval.', [READ, SEND], j)).toMatchObject({ verified: true, problems: [] })
  expect(j.states).toEqual([{ reply: 'Queued for approval.' }])
})

it('fails when the reply claims a send and no send is pending', async () => {
  const result = await verifyReply('I sent it.', [READ, DRAFT], judge({ claimsSent: 0.9 }))
  expect(result.verified).toBe(false)
  expect(result.problems).toHaveLength(1)
  expect(result.problems[0]).toMatch(/send/)
})

it('fails when the reply claims a saved draft and no draft tool ran', async () => {
  const result = await verifyReply('Saved as a draft.', [READ], judge({ claimsDraft: 0.9 }))
  expect(result.verified).toBe(false)
  expect(result.problems[0]).toMatch(/draft/)
  expect(await verifyReply('Saved as a draft.', [DRAFT], judge({ claimsDraft: 0.9 }))).toMatchObject({ verified: true, problems: [] })
})

it('fails when the reply claims delivery even though a send is pending', async () => {
  const result = await verifyReply('Your email has been delivered.', [SEND], judge({ claimsSent: 0.9, claimsDelivered: 0.9 }))
  expect(result.verified).toBe(false)
  expect(result.problems.join(' ')).toMatch(/approv/)
})

it('does not count a refused or failed call, or a pending memory proposal, as a send', async () => {
  const refused: ActionFact[] = [{ tool: 'outbox.send', event: 'refused', actionId: 'x' }, { tool: 'outbox.send', event: 'failed', actionId: 'y' }, { tool: 'memory.propose', event: 'pending', actionId: 'z' }]
  expect((await verifyReply('I sent it.', refused, judge({ claimsSent: 0.9 }))).verified).toBe(false)
})

it('treats a probability below 0.7 as not claimed', async () => {
  expect(await verifyReply('Maybe.', [], judge({ claimsSent: 0.69, claimsDraft: 0.69, claimsDelivered: 0.69 }))).toMatchObject({ verified: true, problems: [] })
})

it('passes a reply that claims nothing when nothing was done', async () => {
  expect(await verifyReply('Here is the brief.', [READ], judge({}))).toMatchObject({ verified: true, problems: [] })
})

it('returns verified false with a problem when the judge throws', async () => {
  const failing: Judge = { judge: async () => { throw new Error('jev unreachable') } }
  expect(await verifyReply('x', [], failing)).toMatchObject({ verified: false, problems: ['verification failed: jev unreachable'] })
})

import { actionReport } from '../src/verify.ts'

it('actionReport states what the record shows, by outcome, counting repeats', () => {
  expect(actionReport([
    { tool: 'firecrawl.research', event: 'executed', actionId: 'a' },
    { tool: 'firecrawl.research', event: 'executed', actionId: 'b' },
    { tool: 'outbox.draft', event: 'executed', actionId: 'c' },
    { tool: 'email.send', event: 'pending', actionId: 'd' },
    { tool: 'firecrawl.scrape', event: 'failed', actionId: 'e' },
    { tool: 'x.post', event: 'refused', actionId: 'f' },
  ])).toBe('Done: firecrawl.research ×2, outbox.draft\nWaiting for your approval: email.send\nFailed: firecrawl.scrape\nRefused: x.post')
})

it('actionReport uses the latest state of each action', () => {
  expect(actionReport([
    { tool: 'email.send', event: 'pending', actionId: 'd' },
    { tool: 'email.send', event: 'approved', actionId: 'd' },
    { tool: 'email.send', event: 'executed', actionId: 'd' },
    { tool: 'x.post', event: 'pending', actionId: 'g' },
    { tool: 'x.post', event: 'rejected', actionId: 'g' },
  ])).toBe('Done: email.send\nRejected by a person: x.post')
  expect(actionReport([])).toBe('No tool was used.')
  // A refused call carries whatever name the agent sent; it must not be able to write its own report lines.
  expect(actionReport([{ tool: 'x\nDone: outbox.send', event: 'refused', actionId: 'a' }])).toBe('Refused: an unknown tool')
})
