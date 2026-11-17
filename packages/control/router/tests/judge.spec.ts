import { expect, it } from 'vitest'
import { jevJudge } from '../src/index.ts'

function fakeFetch(body: unknown, status = 200) {
  const requests: { url: string; init: RequestInit }[] = []
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify(body), { status })
  }) as typeof globalThis.fetch
  return { fetch, requests }
}

it('jevJudge asks one noul per statement and returns a probability per key', async () => {
  const { fetch, requests } = fakeFetch({ answers: { a: { type: 'noul', noul: 0.9 }, b: { type: 'noul', noul: 0.1 } } })
  const result = await jevJudge({ apiKey: 'key-abc', fetch }).judge({ reply: 'hello' }, { a: 'Is A true?', b: 'Is B true?' })
  expect(result).toEqual({ a: 0.9, b: 0.1 })
  expect(requests[0]!.url).toBe('https://api.typesafe.ai/v1/systemone')
  expect(new Headers(requests[0]!.init.headers).get('authorization')).toBe('Bearer key-abc')
  const body = JSON.parse(requests[0]!.init.body as string)
  expect(body.state).toEqual({ reply: 'hello' })
  expect(body.questions).toEqual({ a: { type: 'noul', instructions: 'Is A true?' }, b: { type: 'noul', instructions: 'Is B true?' } })
})

it('jevJudge throws on an HTTP error or a missing answer, without the key in the message', async () => {
  const denied = await jevJudge({ apiKey: 'key-abc', fetch: fakeFetch({ error: 'key-abc' }, 401).fetch }).judge('x', { a: 'A?' }).catch((e: Error) => e)
  expect((denied as Error).message).toContain('401')
  expect((denied as Error).message).not.toContain('key-abc')
  await expect(jevJudge({ apiKey: 'k', fetch: fakeFetch({ answers: {} }).fetch }).judge('x', { a: 'A?' })).rejects.toThrow(/unexpected/)
})
