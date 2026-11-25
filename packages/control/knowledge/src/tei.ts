import type { Embedder } from './kb.ts'

/** An embedder backed by a Hugging Face text-embeddings-inference server (`POST <url>/embed`). */
export function teiEmbedder(options: {
  url: string
  fetch?: typeof fetch
  batchSize?: number
  /** Text the model expects in front of a question, for example the BGE retrieval instruction. */
  queryPrefix?: string
}): Embedder {
  const url = `${options.url.replace(/\/+$/, '')}/embed`
  const embedder: Embedder = {
    async embedQuery(text) { return (await embedder.embed([`${options.queryPrefix ?? ''}${text}`]))[0]! },
    async embed(texts) {
      const vectors: number[][] = []
      // The server limits how many texts one request may carry.
      for (let i = 0; i < texts.length; i += options.batchSize ?? 16) {
        const response = await (options.fetch ?? fetch)(url, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ inputs: texts.slice(i, i + (options.batchSize ?? 16)), truncate: true }),
          signal: AbortSignal.timeout(60_000),
        })
        if (!response.ok) throw new Error(`embedding server answered HTTP ${response.status}`)
        vectors.push(...await response.json() as number[][])
      }
      return vectors
    },
  }
  return embedder
}
