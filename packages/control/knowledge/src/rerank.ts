import type { Reranker } from './kb.ts'

/** A reranker backed by a text-embeddings-inference server running a reranking model (`POST <url>/rerank`). */
export function teiReranker(options: { url: string; fetch?: typeof fetch }): Reranker {
  const url = `${options.url.replace(/\/+$/, '')}/rerank`
  return {
    async rerank(query, texts) {
      const response = await (options.fetch ?? fetch)(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, texts, truncate: true }),
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) throw new Error(`reranking server answered HTTP ${response.status}`)
      const scores = new Array<number>(texts.length).fill(Number.NaN)
      for (const { index, score } of await response.json() as { index: number; score: number }[]) scores[index] = score
      return scores
    },
  }
}
