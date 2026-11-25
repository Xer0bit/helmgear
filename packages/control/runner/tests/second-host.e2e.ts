import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCore, startGateway } from '@helmgear/gateway'
import { expect, it } from 'vitest'
import { createRunner } from '../src/index.ts'

// Needs no key: a local server stands in for an OpenAI-compatible model host, and the real
// harness process is pointed at it. It proves the host wiring, not any particular provider.
it('a sensitive template runs against a second model host', async () => {
  const seen: { path: string; authorization: string; model: string; system: string }[] = []
  const host = createServer((req, res) => {
    let body = ''
    req.on('data', (part) => { body += part })
    req.on('end', () => {
      const request = JSON.parse(body) as { model: string; messages: { role: string; content: unknown }[] }
      seen.push({ path: req.url ?? '', authorization: req.headers.authorization ?? '', model: request.model, system: JSON.stringify(request.messages[0]) })
      const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: request.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 } } : {}) })}\n\n`
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`${chunk({ role: 'assistant', content: 'Answered by the second host.' }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`)
    })
  })
  await new Promise<void>(resolve => host.listen(0, '127.0.0.1', resolve))
  const stateDir = mkdtempSync(join(tmpdir(), 'helmgear-host-'))
  const core = createCore({ connectors: [], stateDir })
  const gateway = await startGateway({ executor: core.executor, connectors: [] })
  process.env.SECOND_HOST_KEY = 'stand-in-key'
  try {
    const runner = createRunner({
      templatesDir: fileURLToPath(new URL('../../../../templates', import.meta.url)),
      stateDir,
      gateway: { ...gateway, approvals: core.approvals, audit: core.audit },
      classifier: { classify: async () => { throw new Error('not used') } },
      model: { provider: 'second-host', model: 'stand-in/model', host: { baseURL: `http://127.0.0.1:${(host.address() as AddressInfo).port}/v1`, apiKeyEnv: 'SECOND_HOST_KEY' } },
    })
    const result = await runner.runTask({ tenant: 'acme', template: 'bookkeeping-proposal', request: 'Say hello.' })
    expect(result).toMatchObject({ status: 'done', template: 'bookkeeping-proposal', response: 'Answered by the second host.' })
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(seen[0]).toMatchObject({ path: '/v1/chat/completions', authorization: 'Bearer stand-in-key', model: 'stand-in/model' })
    expect(seen[0]!.system).toContain('Rules for every task')
  } finally {
    delete process.env.SECOND_HOST_KEY
    await gateway.close()
    host.close()
  }
}, 120_000)
