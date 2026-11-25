import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chunk } from './chunk.ts'

export interface KbDocument {
  id: string
  title: string
  /** Where it came from: a file name or a URL. Adding the same source again replaces the document. */
  source: string
  /** ISO 8601 UTC. */
  addedAt: string
  sha256: string
  chars: number
  chunks: number
}

export interface KbHit {
  documentId: string
  title: string
  source: string
  section: string
  /** Position of the passage in its document. */
  chunk: number
  text: string
  score: number
}

/** Turns texts into vectors. Optional: without one, search is keyword-only. */
export interface Embedder {
  embed(texts: string[]): Promise<number[][]>
  /** Embed a question. Some models want a different instruction for questions than for passages. */
  embedQuery?(text: string): Promise<number[]>
}

/** Reads a question together with each candidate passage and scores how well the passage answers it. */
export interface Reranker {
  /** One score per text, in the order given; higher is better. */
  rerank(query: string, texts: string[]): Promise<number[]>
}

interface StoredDocument { document: KbDocument; text: string; passages: { section: string; text: string; vector?: number[] }[] }
interface Indexed { hit: Omit<KbHit, 'score'>; terms: Map<string, number>; length: number; vector?: number[] }
interface Index { passages: Indexed[]; documentFrequency: Map<string, number>; averageLength: number }

const TENANT = /^[a-z0-9][a-z0-9_-]{0,63}$/
const DOCUMENT_ID = /^[0-9a-f]{16}$/

// Words that say nothing about a topic. In a small knowledge base a stray "is" or "be" is rare enough to
// outrank the word that matters, so they are dropped from both passages and questions.
const STOP = new Set('a an and are as at be been but by can could did do does for from had has have how i if in into is it its me my no not of on or our so than that the their them then there these they this to up us was we were what when where which who why will with would you your'.split(' '))

/** Lowercase words without stop words, with the commonest English endings removed so refund, refunds and refunded match. */
export function terms(text: string): string[] {
  return (text.toLowerCase().normalize('NFKD').match(/[\p{L}\p{N}]+/gu) ?? []).filter(word => !STOP.has(word)).map((word) => {
    const stem = word.replace(/(?:ing|ed|es|s)$/, '')
    if (stem.length < 3 || stem === word) return word
    // shipping -> shipp -> ship
    return /([b-df-hj-np-tv-z])\1$/.test(stem) ? stem.slice(0, -1) : stem
  })
}

const cosine = (a: number[], b: number[]): number => {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i]! * (b[i] ?? 0); na += a[i]! * a[i]!; nb += (b[i] ?? 0) * (b[i] ?? 0) }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

/**
 * One knowledge base per tenant, kept as plain files. A person adds and
 * removes documents; an agent can only search and read. Search is BM25 over
 * each passage with its document title and heading path attached, fused with
 * embedding similarity when an embedder is configured.
 * ponytail: the index is rebuilt in memory when a tenant's documents change and
 * embedding search compares against every passage. That is fine into the tens
 * of thousands of passages; beyond that, move the vectors to Qdrant.
 */
export class KnowledgeBase {
  private readonly dir: string
  private readonly embedder: Embedder | undefined
  private readonly reranker: Reranker | undefined
  private readonly cache = new Map<string, { stamp: string; index: Index }>()

  constructor(options: { dir: string; embedder?: Embedder; reranker?: Reranker }) {
    this.dir = options.dir
    this.embedder = options.embedder
    this.reranker = options.reranker
  }

  private folder(tenant: string): string {
    if (!TENANT.test(tenant)) throw new Error('tenant must match [a-z0-9][a-z0-9_-]{0,63}')
    return join(this.dir, tenant)
  }

  private stored(tenant: string, id: string): StoredDocument {
    const file = DOCUMENT_ID.test(id) ? join(this.folder(tenant), `${id}.json`) : ''
    if (!file || !existsSync(file)) throw new Error(`no document ${id} in this knowledge base`)
    return JSON.parse(readFileSync(file, 'utf8')) as StoredDocument
  }

  private catalogue(tenant: string): KbDocument[] {
    const file = join(this.folder(tenant), 'documents.json')
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as KbDocument[] : []
  }

  private write(file: string, value: unknown): void {
    writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
  }

  /** Add a document, or replace the one that came from the same source. Identical text changes nothing. */
  async add(tenant: string, input: { title: string; source: string; text: string }): Promise<KbDocument> {
    const folder = this.folder(tenant)
    const text = input.text.replace(/\r\n/g, '\n').trim()
    if (!text) throw new Error('the document is empty')
    const title = input.title.replace(/\s+/g, ' ').trim().slice(0, 200) || input.source
    const id = createHash('sha256').update(input.source).digest('hex').slice(0, 16)
    const sha256 = createHash('sha256').update(text).digest('hex')
    const documents = this.catalogue(tenant)
    const existing = documents.find(d => d.id === id)
    if (existing?.sha256 === sha256 && existing.title === title) return existing

    const passages: StoredDocument['passages'] = chunk(text)
    if (this.embedder) {
      const vectors = await this.embedder.embed(passages.map(p => `${title}\n${p.section}\n${p.text}`))
      passages.forEach((passage, i) => { passage.vector = vectors[i]! })
    }
    const document: KbDocument = { id, title, source: input.source, addedAt: new Date().toISOString(), sha256, chars: text.length, chunks: passages.length }
    mkdirSync(folder, { recursive: true })
    this.write(join(folder, `${id}.json`), { document, text, passages } satisfies StoredDocument)
    this.write(join(folder, 'documents.json'), [...documents.filter(d => d.id !== id), document])
    return document
  }

  list(tenant: string): KbDocument[] { return this.catalogue(tenant) }

  remove(tenant: string, id: string): void {
    this.stored(tenant, id)
    const folder = this.folder(tenant)
    this.write(join(folder, 'documents.json'), this.catalogue(tenant).filter(d => d.id !== id))
    rmSync(join(folder, `${id}.json`), { force: true })
  }

  read(tenant: string, id: string, maxChars = 12_000): { id: string; title: string; source: string; text: string; truncated: boolean } {
    const { document, text } = this.stored(tenant, id)
    return { id: document.id, title: document.title, source: document.source, text: text.slice(0, maxChars), truncated: text.length > maxChars }
  }

  private index(tenant: string): Index {
    const documents = this.catalogue(tenant)
    const stamp = documents.map(d => `${d.id}:${d.sha256}`).join(',')
    const cached = this.cache.get(tenant)
    if (cached?.stamp === stamp) return cached.index
    const passages: Indexed[] = []
    const documentFrequency = new Map<string, number>()
    for (const { id } of documents) {
      const { document, passages: stored } = this.stored(tenant, id)
      stored.forEach((passage, position) => {
        // The title and heading path are indexed with the passage, so a passage is found by what it is about.
        const words = terms(`${document.title} ${passage.section} ${passage.text}`)
        const counts = new Map<string, number>()
        for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1)
        for (const word of counts.keys()) documentFrequency.set(word, (documentFrequency.get(word) ?? 0) + 1)
        passages.push({
          hit: { documentId: document.id, title: document.title, source: document.source, section: passage.section, chunk: position, text: passage.text },
          terms: counts, length: words.length, ...(passage.vector ? { vector: passage.vector } : {}),
        })
      })
    }
    const index = { passages, documentFrequency, averageLength: passages.reduce((sum, p) => sum + p.length, 0) / (passages.length || 1) }
    this.cache.set(tenant, { stamp, index })
    return index
  }

  /** The passages that best answer `query`, best first. Empty when nothing matches. */
  async search(tenant: string, query: string, limit = 5): Promise<KbHit[]> {
    const { passages, documentFrequency, averageLength } = this.index(tenant)
    const words = [...new Set(terms(query))]
    if (passages.length === 0 || words.length === 0) return []

    // BM25 with the usual constants.
    const k1 = 1.2, b = 0.75
    const keyword = passages.map((passage, i) => {
      let score = 0
      for (const word of words) {
        const frequency = passage.terms.get(word)
        if (!frequency) continue
        const containing = documentFrequency.get(word) ?? 0
        const idf = Math.log(1 + (passages.length - containing + 0.5) / (containing + 0.5))
        score += idf * (frequency * (k1 + 1)) / (frequency + k1 * (1 - b + b * passage.length / averageLength))
      }
      return { i, score }
    }).filter(entry => entry.score > 0).sort((x, y) => y.score - x.score).slice(0, 20)

    let dense: { i: number; score: number }[] = []
    if (this.embedder && passages.some(p => p.vector)) {
      try {
        const vector = this.embedder.embedQuery ? await this.embedder.embedQuery(query) : (await this.embedder.embed([query]))[0]
        if (vector) dense = passages.flatMap((p, i) => p.vector ? [{ i, score: cosine(vector, p.vector) }] : []).sort((x, y) => y.score - x.score).slice(0, 20)
      } catch { /* the embedding server is down: keyword search still answers */ }
    }
    let candidates = keyword
    if (dense.length > 0) {
      // Reciprocal rank fusion: a passage ranked high by either signal rises; one ranked by both rises most.
      const fused = new Map<number, number>()
      for (const list of [keyword, dense]) list.forEach(({ i }, rank) => fused.set(i, (fused.get(i) ?? 0) + 1 / (60 + rank + 1)))
      candidates = [...fused].map(([i, score]) => ({ i, score })).sort((x, y) => y.score - x.score).slice(0, 20)
    }
    if (this.reranker && candidates.length > 1) {
      // The first pass finds candidates cheaply; the reranker reads each one against the question and has the last word on order.
      try {
        const scores = await this.reranker.rerank(query, candidates.map(({ i }) => { const { title, section, text } = passages[i]!.hit; return `${title}\n${section}\n${text}` }))
        if (!Array.isArray(scores) || scores.length !== candidates.length || !scores.every(Number.isFinite)) throw new Error('unusable scores')
        candidates = candidates.map(({ i }, n) => ({ i, score: scores[n]! })).sort((x, y) => y.score - x.score)
      } catch { /* the reranking server is down or answered nonsense: the first-pass order still answers */ }
    }
    return candidates.slice(0, limit).map(({ i, score }) => ({ ...passages[i]!.hit, score }))
  }
}
