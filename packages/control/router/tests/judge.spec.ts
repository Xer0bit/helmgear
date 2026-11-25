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

it('retries once when the request fails to connect or the service is briefly unavailable, then gives up', async () => {
  let calls = 0
  const flaky = (async () => {
    if (++calls === 1) throw new TypeError('fetch failed')
    return new Response(JSON.stringify({ answers: { a: { type: 'noul', noul: 0.4 } } }))
  }) as typeof globalThis.fetch
  expect(await jevJudge({ apiKey: 'k', fetch: flaky }).judge('x', { a: 'A?' })).toEqual({ a: 0.4 })
  expect(calls).toBe(2)
  calls = 0
  const busy = (async () => { calls++; return new Response('{}', { status: calls === 1 ? 503 : 200 }) }) as typeof globalThis.fetch
  await expect(jevJudge({ apiKey: 'k', fetch: busy }).judge('x', { a: 'A?' })).rejects.toThrow(/unexpected/)
  expect(calls).toBe(2)
  calls = 0
  const dead = (async () => { calls++; throw new TypeError('fetch failed') }) as typeof globalThis.fetch
  await expect(jevJudge({ apiKey: 'k', fetch: dead }).judge('x', { a: 'A?' })).rejects.toThrow('fetch failed')
  expect(calls).toBe(2)
  // A refusal such as a bad key is not retried.
  calls = 0
  const denied = (async () => { calls++; return new Response('{}', { status: 401 }) }) as typeof globalThis.fetch
  await expect(jevJudge({ apiKey: 'k', fetch: denied }).judge('x', { a: 'A?' })).rejects.toThrow(/401/)
  expect(calls).toBe(1)
})
