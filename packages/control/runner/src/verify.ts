import type { Judge } from '@helmgear/router'

/** One thing the gateway recorded for this session: what the agent actually did. */
export interface ActionFact { tool: string; event: 'executed' | 'pending' | 'failed' | 'refused'; actionId: string }

/** `problems` are plain sentences, each naming one way the reply disagrees with the record. */
export interface Verification { verified: boolean; problems: string[]; needsAction: boolean }

const STATEMENTS = {
  claimsSent: 'Does `reply` say that a message or post was sent, published, or queued for sending?',
  claimsDraft: 'Does `reply` say that a draft was saved or stored somewhere, as opposed to the draft text simply being shown in the reply?',
  claimsDelivered: 'Does `reply` say that a message has already been delivered or published, rather than queued or waiting for approval?',
}
const CLAIMED = 0.7

/**
 * Compare what a reply says was done with what the audit log says was done.
 * The judge reads the reply; the decision is the comparison here. A judge
 * failure is a failed verification, never a pass.
 */
export async function verifyReply(reply: string, actions: ActionFact[], judge: Judge): Promise<Verification> {
  let answers: Record<string, number>
  try {
    answers = await judge.judge({ reply }, STATEMENTS)
  } catch (error) {
    return { verified: false, problems: [`verification failed: ${error instanceof Error ? error.message : String(error)}`], needsAction: false }
  }
  const claims = (key: keyof typeof STATEMENTS): boolean => (answers[key] ?? 0) >= CLAIMED
  // A pending action is a send waiting for approval; a memory proposal waits too but sends nothing.
  const sendQueued = actions.some(a => a.event === 'pending' && !a.tool.startsWith('memory.'))
  const draftSaved = actions.some(a => a.event === 'executed' && a.tool.endsWith('.draft'))
  const problems: string[] = []
  let needsAction = false
  if (claims('claimsSent') && !sendQueued) { problems.push('the reply says something was sent or queued, but no send tool call was made'); needsAction = true }
  if (claims('claimsDraft') && !draftSaved) { problems.push('the reply says a draft was saved, but no draft tool call was made'); needsAction = true }
  if (claims('claimsDelivered')) problems.push('the reply says a message was delivered or published, but nothing is delivered until a person approves it')
  return { verified: problems.length === 0, problems, needsAction }
}
