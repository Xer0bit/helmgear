import type { MemoryStore } from '../memory.ts'
import type { Connector } from '../registry.ts'

/**
 * Lets an agent propose a lasting fact about the business. The tool is tier
 * `send` on purpose: a proposal waits in the approval queue like any outgoing
 * action, so text an agent picked up from a web page or an email cannot
 * become memory unless a person approves that exact text.
 */
export function memoryConnector(options: { store: MemoryStore }): Connector {
  return {
    name: 'memory',
    tools: [{
      name: 'memory.propose',
      description: 'Propose one lasting fact about the business to remember for future tasks. A person must approve it before it is kept.',
      inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 10, maxLength: 300 } }, required: ['text'], additionalProperties: false },
      tier: 'send',
      async run(input, ctx) {
        const { id } = options.store.add(ctx.tenant, { kind: 'fact', text: String(input.text), source: 'approved-proposal' })
        return { id }
      },
    }],
  }
}
