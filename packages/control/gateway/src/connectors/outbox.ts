import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CallContext, Connector } from '../registry.ts'

const MESSAGE = {
  type: 'object',
  properties: { to: { type: 'string', minLength: 1 }, subject: { type: 'string' }, body: { type: 'string', minLength: 1 } },
  required: ['to', 'subject', 'body'],
  additionalProperties: false,
}

/**
 * A local stand-in for a mail or publishing connector: `draft` and `send`
 * write JSON files. Nothing leaves the machine, which lets the approval path
 * be exercised without a third-party account.
 */
export function outboxConnector(options: { dir: string }): Connector {
  for (const folder of ['drafts', 'sent']) mkdirSync(join(options.dir, folder), { recursive: true })
  const write = (folder: string) => async (input: Record<string, unknown>, ctx: CallContext) => {
    const id = randomUUID()
    const record = { id, ...input, tenant: ctx.tenant, sessionId: ctx.sessionId, template: ctx.template, at: new Date().toISOString() }
    writeFileSync(join(options.dir, folder, `${id}.json`), JSON.stringify(record, null, 2), { mode: 0o600 })
    return { id }
  }
  return {
    name: 'outbox',
    tools: [
      { name: 'outbox.draft', description: 'Save a message as a draft for a person to review. Does not send.', inputSchema: MESSAGE, tier: 'draft', run: write('drafts') },
      { name: 'outbox.send', description: 'Send a message. It is queued until a person approves it.', inputSchema: MESSAGE, tier: 'send', run: write('sent') },
    ],
  }
}
