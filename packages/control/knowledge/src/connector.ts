import type { Connector } from '@helmgear/gateway'
import type { KnowledgeBase } from './kb.ts'

/**
 * Lets an agent search and read its tenant's knowledge base. Both tools are
 * read-only and there is no tool that adds or changes a document: what goes
 * into the knowledge base is a person's decision, which is the defence
 * against planted documents. The tenant always comes from the caller's grant.
 */
export function knowledgeConnector(options: { kb: KnowledgeBase }): Connector {
  return {
    name: 'kb',
    tools: [
      {
        name: 'kb.search',
        description: 'Search the business\'s own knowledge base (its policies, products, prices, procedures). Returns the best passages with a citation for each. Use this before answering any question about the business.',
        inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 500 }, limit: { type: 'integer', minimum: 1, maximum: 8 } }, required: ['query'], additionalProperties: false },
        tier: 'read',
        untrusted: true, curated: true,
        async run(input, ctx) {
          const hits = await options.kb.search(ctx.tenant, String(input.query), typeof input.limit === 'number' ? input.limit : 5)
          return { passages: hits.map(hit => ({ cite: hit.section ? (hit.section.startsWith(hit.title) ? hit.section : `${hit.title} › ${hit.section}`) : hit.title, documentId: hit.documentId, source: hit.source, text: hit.text })) }
        },
      },
      {
        name: 'kb.read',
        description: 'Read one knowledge-base document in full, by the documentId a search returned. Use it when a passage is not enough.',
        inputSchema: { type: 'object', properties: { documentId: { type: 'string', pattern: '^[0-9a-f]{16}$' } }, required: ['documentId'], additionalProperties: false },
        tier: 'read',
        untrusted: true, curated: true,
        async run(input, ctx) { return options.kb.read(ctx.tenant, String(input.documentId)) },
      },
    ],
  }
}
