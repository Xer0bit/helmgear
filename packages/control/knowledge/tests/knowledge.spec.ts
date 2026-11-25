import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore } from '@helmgear/gateway'
import { expect, it } from 'vitest'
import { chunk, KnowledgeBase, knowledgeConnector, teiEmbedder, type Embedder } from '../src/index.ts'

const kb = (embedder?: Embedder): KnowledgeBase => new KnowledgeBase({ dir: join(mkdtempSync(join(tmpdir(), 'helmgear-kb-')), 'kb'), ...(embedder ? { embedder } : {}) })
const REFUNDS = `# Refund policy\n\nWe refund any order within 30 days of delivery.\n\n## Exceptions\n\nGift cards and custom engravings cannot be refunded.\n\n## How long it takes\n\nRefunds reach your card in 5 to 7 working days.`
const SHIPPING = `# Shipping\n\nOrders ship from Rotterdam within two working days.\n\n## Costs\n\nShipping is free above 50 euros; below that it costs 4.95 euros.`

it('chunk groups paragraphs under their heading path and never mixes sections', () => {
  const chunks = chunk(REFUNDS)
  expect(chunks.map(c => c.section)).toEqual(['Refund policy', 'Refund policy › Exceptions', 'Refund policy › How long it takes'])
  expect(chunks[1]!.text).toBe('Gift cards and custom engravings cannot be refunded.')
})

it('chunk groups short paragraphs up to the target size and splits an oversized one', () => {
  const many = `# Notes\n\n${Array.from({ length: 30 }, (_unused, i) => `Paragraph ${i} has a few words in it to take up some room on the page.`).join('\n\n')}`
  const chunks = chunk(many)
  expect(chunks.length).toBeGreaterThan(1)
  expect(chunks.length).toBeLessThan(10)
  expect(chunks.every(c => c.text.length <= 1700)).toBe(true)
  const long = chunk(`# Long\n\n${'One sentence here. '.repeat(400)}`)
  expect(long.length).toBeGreaterThan(3)
  expect(long.every(c => c.text.length <= 1700)).toBe(true)
  expect(chunk('Plain text without any heading.')).toEqual([{ section: '', text: 'Plain text without any heading.' }])
  expect(chunk('   \n\n ')).toEqual([])
})

it('add stores a document and list shows it; the same text again changes nothing', async () => {
  const base = kb()
  const added = await base.add('acme', { title: 'Refund policy', source: 'refunds.md', text: REFUNDS })
  expect(added).toMatchObject({ title: 'Refund policy', source: 'refunds.md', chunks: 3 })
  expect(added.sha256).toMatch(/^[0-9a-f]{64}$/)
  expect(base.list('acme')).toEqual([added])
  expect(await base.add('acme', { title: 'Refund policy', source: 'refunds.md', text: REFUNDS })).toEqual(added)
  expect(base.list('acme')).toHaveLength(1)
  expect(base.list('globex')).toEqual([])
})

it('adding the same source again replaces the old version', async () => {
  const base = kb()
  const first = await base.add('acme', { title: 'Refund policy', source: 'refunds.md', text: REFUNDS })
  const second = await base.add('acme', { title: 'Refund policy', source: 'refunds.md', text: REFUNDS.replace('30 days', '14 days') })
  expect(second.id).toBe(first.id)
  expect(second.sha256).not.toBe(first.sha256)
  expect(base.list('acme')).toHaveLength(1)
  const hits = await base.search('acme', 'how many days to get a refund')
  expect(hits.map(h => h.text).join(' ')).toContain('14 days')
  expect(hits.map(h => h.text).join(' ')).not.toContain('30 days')
})

it('search ranks the passage that answers the question first, with its document and section', async () => {
  const base = kb()
  await base.add('acme', { title: 'Refund policy', source: 'refunds.md', text: REFUNDS })
  await base.add('acme', { title: 'Shipping', source: 'shipping.md', text: SHIPPING })
  const [top] = await base.search('acme', 'how much does shipping cost')
  expect(top).toMatchObject({ title: 'Shipping', section: 'Shipping › Costs', source: 'shipping.md' })
  expect(top!.text).toContain('4.95')
  expect((await base.search('acme', 'Can I return a gift card?'))[0]!.section).toBe('Refund policy › Exceptions')
  // Words match in their other forms: refunded / refunds / refund.
  expect((await base.search('acme', 'when is my money refunded'))[0]!.title).toBe('Refund policy')
})

it('search returns nothing for another tenant, an empty base or a query with no words in common', async () => {
  const base = kb()
  await base.add('acme', { title: 'Refund policy', source: 'refunds.md', text: REFUNDS })
  expect(await base.search('globex', 'refund')).toEqual([])
  expect(await base.search('acme', 'zebra quantum violin')).toEqual([])
  expect(await base.search('acme', '   ')).toEqual([])
})

it('remove deletes the document and its passages; read returns the text, capped', async () => {
  const base = kb()
  const doc = await base.add('acme', { title: 'Refund policy', source: 'refunds.md', text: REFUNDS })
  expect(base.read('acme', doc.id)).toMatchObject({ title: 'Refund policy', text: REFUNDS, truncated: false })
  expect(base.read('acme', doc.id, 20)).toMatchObject({ text: REFUNDS.slice(0, 20), truncated: true })
  base.remove('acme', doc.id)
  expect(base.list('acme')).toEqual([])
  expect(await base.search('acme', 'refund')).toEqual([])
  expect(() => base.read('acme', doc.id)).toThrow(/no document/)
})

it('refuses an empty document, an unsafe tenant and an unsafe document id', async () => {
  const base = kb()
  await expect(base.add('acme', { title: 'Empty', source: 'e.md', text: '  \n ' })).rejects.toThrow(/empty/)
  await expect(base.add('../acme', { title: 'x', source: 'x', text: 'hello there' })).rejects.toThrow(/tenant/)
  expect(() => base.read('acme', '../../etc/passwd')).toThrow(/no document/)
  expect(() => base.list('UPPER')).toThrow(/tenant/)
})

it('with an embedder, finds a passage that shares no words with the question', async () => {
  // A stand-in embedder that knows two meanings: money back, and delivery.
  const meaning = (text: string): number[] => [/refund|money back|reimburs|return/i.test(text) ? 1 : 0, /ship|deliver|post|parcel|dispatch/i.test(text) ? 1 : 0, 0.01]
  const calls: string[][] = []
  const embedder: Embedder = { embed: async (texts) => { calls.push(texts); return texts.map(meaning) } }
  const base = kb(embedder)
  await base.add('acme', { title: 'Refund policy', source: 'refunds.md', text: REFUNDS })
  await base.add('acme', { title: 'Shipping', source: 'shipping.md', text: SHIPPING })
  const hits = await base.search('acme', 'When will the parcel be dispatched?')
  expect(hits[0]!.title).toBe('Shipping')
  // Passages are embedded once, when added; a search embeds only the question.
  expect(calls.at(-1)).toEqual(['When will the parcel be dispatched?'])
  const plain = kb()
  await plain.add('acme', { title: 'Shipping', source: 'shipping.md', text: SHIPPING })
  expect(await plain.search('acme', 'When will the parcel be dispatched?')).toEqual([])
})

it('falls back to keyword search when the embedder fails at search time', async () => {
  let fail = false
  const base = kb({ embed: async (texts) => { if (fail) throw new Error('embedding server down'); return texts.map(() => [1, 0]) } })
  await base.add('acme', { title: 'Shipping', source: 'shipping.md', text: SHIPPING })
  fail = true
  expect((await base.search('acme', 'shipping costs'))[0]!.title).toBe('Shipping')
})

it('the connector gives an agent search and read, both read-only, and nothing that writes', async () => {
  const base = kb()
  const doc = await base.add('acme', { title: 'Refund policy', source: 'refunds.md', text: REFUNDS })
  const connector = knowledgeConnector({ kb: base })
  expect(connector.tools.map(t => [t.name, t.tier, t.untrusted])).toEqual([['kb.search', 'read', true], ['kb.read', 'read', true]])
  const core = createCore({ connectors: [connector], stateDir: mkdtempSync(join(tmpdir(), 'helmgear-kbc-')) })
  const ctx = { tenant: 'acme', sessionId: 's1', template: 'knowledge-answer' }
  const found = await core.executor.call('kb.search', { query: 'gift card refund' }, ctx, 'k1') as { status: 'ok'; result: { passages: { cite: string; documentId: string; text: string }[] } }
  expect(found.result.passages[0]).toMatchObject({ cite: 'Refund policy › Exceptions', documentId: doc.id })
  // The tenant comes from the caller's grant: another tenant sees nothing.
  const other = await core.executor.call('kb.search', { query: 'gift card refund' }, { ...ctx, tenant: 'globex' }, 'k2') as { status: 'ok'; result: { passages: unknown[] } }
  expect(other.result.passages).toEqual([])
  const read = await core.executor.call('kb.read', { documentId: doc.id }, ctx, 'k3') as { status: 'ok'; result: { text: string } }
  expect(read.result.text).toContain('30 days')
})

it('teiEmbedder posts texts in batches to <url>/embed and returns one vector per text', async () => {
  const bodies: { inputs: string[] }[] = []
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe('http://tei.test/embed')
    const body = JSON.parse(init!.body as string) as { inputs: string[] }
    bodies.push(body)
    return new Response(JSON.stringify(body.inputs.map(text => [text.length, 1])))
  }) as typeof globalThis.fetch
  const vectors = await teiEmbedder({ url: 'http://tei.test/', fetch, batchSize: 2 }).embed(['a', 'bb', 'ccc'])
  expect(vectors).toEqual([[1, 1], [2, 1], [3, 1]])
  expect(bodies.map(b => b.inputs.length)).toEqual([2, 1])
  const failing = teiEmbedder({ url: 'http://tei.test', fetch: (async () => new Response('x', { status: 503 })) as typeof globalThis.fetch })
  await expect(failing.embed(['a'])).rejects.toThrow(/503/)
})

it('teiEmbedder puts the model\'s query instruction in front of a question, not in front of passages', async () => {
  const seen: string[][] = []
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string) as { inputs: string[] }
    seen.push(body.inputs)
    return new Response(JSON.stringify(body.inputs.map(() => [1, 0])))
  }) as typeof globalThis.fetch
  const embedder = teiEmbedder({ url: 'http://tei.test', fetch, queryPrefix: 'Represent this sentence for searching relevant passages: ' })
  await embedder.embed(['a passage'])
  await embedder.embedQuery!('a question')
  expect(seen).toEqual([['a passage'], ['Represent this sentence for searching relevant passages: a question']])
  const base = kb(embedder)
  await base.add('acme', { title: 'Shipping', source: 'shipping.md', text: SHIPPING })
  await base.search('acme', 'parcel dispatch')
  expect(seen.at(-1)).toEqual(['Represent this sentence for searching relevant passages: parcel dispatch'])
})

// ---- reranking and file formats
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { docxXmlToText, extractText, htmlToText, teiReranker, type Reranker } from '../src/index.ts'

it('a reranker has the last word on order, and search survives it failing', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'helmgear-kb-')), 'kb')
  // Scores a passage by whether it mentions Rotterdam, whatever the first pass thought.
  const reranker: Reranker = { rerank: async (_query, texts) => texts.map(text => text.includes('Rotterdam') ? 1 : 0) }
  const ranked = new KnowledgeBase({ dir, reranker })
  await ranked.add('acme', { title: 'Refunds', source: 'refunds.md', text: REFUNDS })
  await ranked.add('acme', { title: 'Shipping', source: 'shipping.md', text: SHIPPING })
  const plain = await new KnowledgeBase({ dir }).search('acme', 'how long do refunds take for orders')
  expect(plain[0]!.title).toBe('Refunds')
  const hits = await ranked.search('acme', 'how long do refunds take for orders')
  expect(hits[0]!.text).toContain('Rotterdam')
  expect(hits).toHaveLength(plain.length)
  for (const rerank of [async () => { throw new Error('down') }, async () => [Number.NaN, 1, 2], async () => [1]] as Reranker['rerank'][]) {
    expect(await new KnowledgeBase({ dir, reranker: { rerank } }).search('acme', 'how long do refunds take for orders')).toEqual(plain)
  }
})

it('teiReranker posts the question with the texts and returns scores in input order', async () => {
  let sent: any
  const fake = (async (url: string, init: RequestInit) => {
    sent = { url, body: JSON.parse(String(init.body)) }
    return new Response(JSON.stringify([{ index: 1, score: 0.9 }, { index: 0, score: 0.1 }]))
  }) as unknown as typeof fetch
  expect(await teiReranker({ url: 'http://rerank.test/', fetch: fake }).rerank('q', ['a', 'b'])).toEqual([0.1, 0.9])
  expect(sent).toEqual({ url: 'http://rerank.test/rerank', body: { query: 'q', texts: ['a', 'b'], truncate: true } })
  const down = (async () => new Response('no', { status: 503 })) as unknown as typeof fetch
  await expect(teiReranker({ url: 'http://rerank.test', fetch: down }).rerank('q', ['a'])).rejects.toThrow(/503/)
})

it('reads Word paragraphs as lines and Word headings as Markdown headings', () => {
  const xml = '<w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Refund policy</w:t></w:r></w:p>'
    + '<w:p w:rsidR="1"><w:r><w:t>We refund within </w:t></w:r><w:r><w:t>30 days &amp; no later.</w:t></w:r></w:p></w:body>'
  expect(docxXmlToText(xml)).toBe('# Refund policy\n\nWe refund within 30 days & no later.')
  expect(chunk(docxXmlToText(xml))).toEqual([{ section: 'Refund policy', text: 'We refund within 30 days & no later.' }])
})

it('strips scripts, styles and tags from HTML', () => {
  expect(htmlToText('<style>p{}</style><p>Open &amp; ready</p><script>evil()</script>').trim()).toBe('Open & ready')
})

it('extractText reads text files, refuses unknown formats and missing files, and survives a bad entity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helmgear-x-'))
  writeFileSync(join(dir, 'a.md'), '# Hi')
  expect(await extractText(join(dir, 'a.md'))).toBe('# Hi')
  await expect(extractText(join(dir, 'a.xlsx'))).rejects.toThrow(/cannot read \.xlsx/)
  await expect(extractText(join(dir, '*.md'))).rejects.toThrow(/no file at/)
  expect(htmlToText('a&#99999999;b')).toBe('a&#99999999;b')
})

it.skipIf(spawnSync('pdftotext', ['-v']).error)('extractText reads the text of a PDF', async () => {
  const stream = 'BT /F1 18 Tf 72 720 Td (Refunds take seven days.) Tj ET'
  const pdf = `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n`
    + `3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n`
    + `4 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`
  const file = join(mkdtempSync(join(tmpdir(), 'helmgear-x-')), 'policy.pdf')
  writeFileSync(file, pdf)
  expect(await extractText(file)).toContain('Refunds take seven days.')
})
