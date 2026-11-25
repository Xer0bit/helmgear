import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const TEXT = ['.md', '.markdown', '.txt', '.csv', '.json']
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' }
const decode = (text: string): string => text
  .replace(/&#(\d+);/g, (whole, code: string) => Number(code) <= 0x10FFFF ? String.fromCodePoint(Number(code)) : whole)
  .replace(/&(\w+);/g, (whole, name: string) => ENTITIES[name] ?? whole)

/** The formats `extractText` reads. */
export const EXTRACTABLE = [...TEXT, '.html', '.htm', '.pdf', '.docx']

/** A Word document body (`word/document.xml`) as text: one line per paragraph, headings as Markdown headings. */
export function docxXmlToText(xml: string): string {
  return (xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []).map((paragraph) => {
    const level = Number(/<w:pStyle w:val="Heading(\d)"/.exec(paragraph)?.[1] ?? 0)
    const text = decode(paragraph.replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n').replace(/<[^>]+>/g, ''))
    return level && text.trim() ? `${'#'.repeat(level)} ${text.trim()}` : text
  }).join('\n\n')
}

export const htmlToText = (html: string): string =>
  decode(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' '))

async function tool(command: string, args: string[], packageName: string): Promise<string> {
  try {
    // No shell: the file name is one argument, whatever characters it holds.
    return (await run(command, args, { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 })).stdout
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${command} is not installed; install the ${packageName} package to read this kind of file`)
    throw new Error(`${command} could not read the file: ${(error as Error).message.split('\n')[0]}`)
  }
}

/**
 * The text of a document file, by its extension. PDF needs `pdftotext`
 * (poppler-utils) and Word needs `unzip` on the machine.
 * ponytail: a scanned PDF has no text layer and comes back empty; add OCR when that is a real case.
 */
export async function extractText(file: string): Promise<string> {
  // An absolute path cannot be mistaken for an option by the tools below.
  const path = resolve(file)
  const kind = extname(path).toLowerCase()
  if (!EXTRACTABLE.includes(kind)) throw new Error(`cannot read ${kind ? `${kind} files` : 'a file without an extension'}; supported: ${EXTRACTABLE.join(', ')}`)
  // unzip would treat a missing name as a wildcard pattern.
  if (!existsSync(path)) throw new Error(`no file at ${file}`)
  if (TEXT.includes(kind)) return readFileSync(path, 'utf8')
  if (kind === '.html' || kind === '.htm') return htmlToText(readFileSync(path, 'utf8'))
  if (kind === '.pdf') return tool('pdftotext', ['-enc', 'UTF-8', path, '-'], 'poppler-utils')
  return docxXmlToText(await tool('unzip', ['-p', path, 'word/document.xml'], 'unzip'))
}
