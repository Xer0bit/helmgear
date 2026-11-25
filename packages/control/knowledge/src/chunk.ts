export interface Chunk {
  /** The heading path the passage sits under, for example `Refund policy › Exceptions`. Empty when the text has no headings. */
  section: string
  text: string
}

const TARGET = 900
const MAX = 1600

/** Split one oversized paragraph at sentence ends, never above `MAX` characters. */
function splitLong(paragraph: string): string[] {
  const parts: string[] = []
  let current = ''
  for (const sentence of paragraph.match(/[^.!?\n]+[.!?]*\s*|\n+/g) ?? [paragraph]) {
    if (current && current.length + sentence.length > MAX) { parts.push(current.trim()); current = '' }
    current += sentence
    while (current.length > MAX) { parts.push(current.slice(0, MAX).trim()); current = current.slice(MAX) }
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

/**
 * Cut a Markdown or plain-text document into passages for retrieval: whole
 * paragraphs grouped up to about 900 characters, never across a heading, each
 * remembering the heading path it sits under. Paragraph groups retrieve
 * markedly better than fixed-size character windows.
 */
export function chunk(text: string): Chunk[] {
  const chunks: Chunk[] = []
  const headings: string[] = []
  let section = ''
  let group: string[] = []
  const flush = (): void => {
    if (group.length > 0) chunks.push({ section, text: group.join('\n\n') })
    group = []
  }
  for (const block of text.replace(/\r\n/g, '\n').split(/\n\s*\n/)) {
    for (const part of block.split(/\n(?=#{1,6}\s)/)) {
      const heading = /^(#{1,6})\s+(.+?)\s*#*\s*(?:\n|$)/.exec(part)
      let body = part
      if (heading) {
        flush()
        headings.length = heading[1]!.length - 1
        headings[heading[1]!.length - 1] = heading[2]!.trim()
        section = headings.filter(Boolean).join(' › ')
        body = part.slice(heading[0].length)
      }
      const paragraph = body.trim()
      if (!paragraph) continue
      for (const piece of paragraph.length > MAX ? splitLong(paragraph) : [paragraph]) {
        if (group.length > 0 && group.join('\n\n').length + piece.length > TARGET) flush()
        group.push(piece)
      }
    }
  }
  flush()
  return chunks
}
