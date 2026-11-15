import { OPERATIONS } from '../src/generated/spec'
import { createClient } from '../src/index'

type Seen = { url: string; init: RequestInit }
const answer = (status: number, body: unknown, headers: Record<string, string> = { 'x-trace-id': 't-1' }) =>
  new Response(body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body), { status, headers })
const make = (respond: (s: Seen) => Response | Promise<Response>, ownerToken?: string) => {
  const seen: Seen[] = []
  const fetch = (async (url: URL, init: RequestInit) => {
    const s = { url: String(url), init }
    seen.push(s)
    return respond(s)
  }) as unknown as typeof globalThis.fetch
  return { client: createClient({ baseUrl: 'https://api.example', clientKey: 'ck', ...(ownerToken ? { ownerToken } : {}), fetch }), seen }
}
const header = (s: Seen, name: string) => (s.init.headers as Record<string, string>)[name]
const REQUEST = { requestId: 'req_0123456789', action: 'withdraw', state: 'processing', chose: { product: 'example-product' }, expiresAt: '2026-11-09T00:00:00Z', steps: [] }

describe('the client', () => {
  it('fills and encodes the path, sets the query, and sends the client key', async () => {
    const { client, seen } = make(() => answer(200, { productId: null }))
    await client.products_route({ query: { amount: '100', chain: 'eip155:56' } })
    await client.product({ path: { id: 'a/b' } })
    expect(seen[0]!.url).toBe('https://api.example/v1/products/route?amount=100&chain=eip155%3A56')
    expect(seen[1]!.url).toBe('https://api.example/v1/products/a%2Fb')
    expect(header(seen[0]!, 'Tempora-Client-Key')).toBe('ck')
  })

  it('with no client key, sends no client key header and still sends the owner token', async () => {
    const seen: Seen[] = []
    const fetch = (async (url: URL, init: RequestInit) => {
      seen.push({ url: String(url), init })
      return answer(200, REQUEST)
    }) as unknown as typeof globalThis.fetch
    const client = createClient({ baseUrl: 'https://api.example', ownerToken: 'owner-1', fetch })
    await client.status({ path: { requestId: 'req_0123456789' } })
    await client.products({})
    for (const s of seen) expect(Object.keys(s.init.headers as Record<string, string>)).not.toContain('Tempora-Client-Key')
    expect(header(seen[0]!, 'authorization')).toBe('Bearer owner-1')
  })

  it('sends the owner token on owner calls only, a call\'s own token first', async () => {
    const { client, seen } = make(() => answer(200, REQUEST), 'owner-1')
    await client.status({ path: { requestId: 'req_0123456789' } }, { ownerToken: 'owner-2' })
    await client.products({})
    expect(header(seen[0]!, 'authorization')).toBe('Bearer owner-2')
    expect(header(seen[1]!, 'authorization')).toBeUndefined()
  })

  it('decodes a success through the output schema, and product_read through its read', async () => {
    const { client } = make((s) => answer(200, s.url.endsWith('/tvl') ? { usd: 1, asOf: null, stale: false, extra: 'ignored' } : REQUEST))
    const r = await client.product_read({ path: { id: 'example-product', read: 'tvl' } })
    // A field the API adds later is tolerated, not refused: answers grow additively within a version.
    expect(r).toMatchObject({ ok: true, status: 200, body: { usd: 1, asOf: null, stale: false }, traceId: 't-1' })
    expect((await client.status_lookup({ query: { txHash: `0x${'a'.repeat(64)}` } })).ok).toBe(true)
  })

  it('checks a product read against that read\'s own shape, not any read\'s', async () => {
    const { client } = make(() => answer(200, { open: true, session: null, allHoldings: true }))
    expect(await client.product_read({ path: { id: 'example-product', read: 'market' } })).toMatchObject({ ok: true })
    expect(await client.product_read({ path: { id: 'example-product', read: 'tvl' } })).toMatchObject({ ok: false, error: { code: 'unreadable_answer', outcome: 'failed' } })
  })

  it('returns the server\'s error as it came, with the trace id', async () => {
    const error = { code: 'gate_failed', message: 'Not open to you.', outcome: 'refused' }
    const { client } = make(() => answer(403, { error }))
    expect(await client.withdraw({ body: { product: 'example-product', amount: { kind: 'all' } } })).toEqual({ ok: false, status: 403, error, traceId: 't-1' })
  })

  it.each([
    ['a lost write is unknown', 'withdraw', 'unknown'],
    ['a lost read is failed', 'positions', 'failed'],
  ] as const)('%s', async (_n, name, outcome) => {
    const { client } = make(() => Promise.reject(new TypeError('fetch failed')))
    const input = name === 'withdraw' ? { body: { product: 'example-product', amount: { kind: 'all' as const } } } : {}
    const r = await (client[name] as (i: unknown) => ReturnType<typeof client.positions>)(input)
    expect(r).toMatchObject({ ok: false, status: 0, error: { code: 'network_error', outcome } })
  })

  it('treats an answer that is not the contract as unreadable, unknown on a write', async () => {
    const { client } = make(() => answer(502, '<html>bad gateway</html>'))
    const r = await client.withdraw({ body: { product: 'example-product', amount: { kind: 'all' } } })
    expect(r).toMatchObject({ ok: false, status: 502, error: { code: 'unreadable_answer', outcome: 'unknown' } })
    const { client: c2 } = make(() => answer(200, { not: 'a request' }))
    expect(await c2.withdraw({ body: { product: 'example-product', amount: { kind: 'all' } } })).toMatchObject({ ok: false, error: { code: 'unreadable_answer', outcome: 'unknown' } })
  })

  it('keeps an unknown outcome from the server as unknown', async () => {
    const error = { code: 'upstream_in_progress', message: 'It may be running.', outcome: 'unknown' }
    const { client } = make(() => answer(409, { error }))
    expect(await client.cancel({ path: { requestId: 'req_0123456789' } })).toMatchObject({ ok: false, status: 409, error: { outcome: 'unknown' } })
  })

  it('has exactly one method per operation in the API document', () => {
    const { client } = make(() => answer(200, {}))
    expect(Object.keys(client).sort()).toEqual(Object.keys(OPERATIONS).sort())
    expect(Object.keys(client)).toHaveLength(17)
  })

  it('takes exactly one lookup key', () => {
    const { client } = make(() => answer(200, REQUEST))
    // @ts-expect-error two keys at once is not a lookup
    void client.status_lookup({ query: { txHash: `0x${'a'.repeat(64)}`, nonce: `0x${'b'.repeat(64)}` } })
  })
})

describe('the configured origin', () => {
  it('a path that would leave it is never sent, and no credential leaves', async () => {
    const op = (OPERATIONS as unknown as Record<string, { path: string }>).positions!
    const was = op.path
    op.path = '//collector.example/v1/positions'
    try {
      const { client, seen } = make(() => answer(200, {}), 'ot')
      const r = await client.positions({})
      expect(seen).toHaveLength(0)
      expect(r).toMatchObject({ ok: false, status: 0, error: { code: 'wrong_origin', outcome: 'failed' } })
    } finally {
      op.path = was
    }
  })
})

describe('rules the document now carries', () => {
  const step = (transaction: string) => ({ stepId: 's1', chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', state: 'ready', checks: [], kind: 'send_solana_transaction', payload: { generation: 1, expiresAt: '2026-11-09T00:00:00Z', transaction } })
  it.each([
    ['a Solana transaction that is not Base64', { ...REQUEST, steps: [step('not base64!')] }],
    ['the reserved product id', { ...REQUEST, chose: { product: 'route' } }],
  ])('an answer with %s is unreadable', async (_n, body) => {
    const { client } = make(() => answer(200, body), 'ot')
    expect(await client.status({ path: { requestId: 'req_0123456789' } })).toMatchObject({ ok: false, error: { code: 'unreadable_answer' } })
  })
  it('a Base64 transaction and an ordinary product id read', async () => {
    const { client } = make(() => answer(200, { ...REQUEST, steps: [step('AAEC')] }), 'ot')
    expect((await client.status({ path: { requestId: 'req_0123456789' } })).ok).toBe(true)
  })
})

describe('a withdrawal found by its operationId', () => {
  const byOperation = { ...REQUEST, action: 'withdraw', state: 'processing', steps: [], operation: { id: 'op-1', state: 'running' } }
  it('reads with its operation and no steps, found by operation id', async () => {
    const { client } = make(() => answer(200, byOperation), 'ot')
    const r = await client.status_lookup({ query: { operationId: 'op-1' } })
    expect(r).toMatchObject({ ok: true, body: { steps: [], operation: { id: 'op-1', state: 'running' } } })
  })
  it('an operation state added later still reads', async () => {
    const { client } = make(() => answer(200, { ...byOperation, operation: { id: 'op-1', state: 'paused' } }), 'ot')
    expect((await client.status_lookup({ query: { operationId: 'op-1' } })).ok).toBe(true)
  })
  it.each([
    ['no operation id', { ...byOperation, operation: { state: 'running' } }],
    ['an empty operation id', { ...byOperation, operation: { id: '', state: 'running' } }],
  ])('an operation with %s is unreadable', async (_n, body) => {
    const { client } = make(() => answer(200, body), 'ot')
    expect(await client.status_lookup({ query: { operationId: 'op-1' } })).toMatchObject({ ok: false, error: { code: 'unreadable_answer' } })
  })
})

describe('path values', () => {
  it.each([['.'], ['..'], ['%2e'], ['%2E%2e']])('a value of %s is refused and nothing is sent', async (v) => {
    const { client, seen } = make(() => answer(200, REQUEST), 'ot')
    const r = await client.status({ path: { requestId: v } })
    expect(seen).toHaveLength(0)
    expect(r).toMatchObject({ ok: false, status: 0, error: { code: 'invalid_path_value', outcome: 'failed' } })
  })
  it('a value with dots inside is sent as itself', async () => {
    const { client, seen } = make(() => answer(200, { productId: null }))
    await client.product({ path: { id: 'a.b' } })
    expect(new URL(seen[0]!.url).pathname).toBe('/v1/products/a.b')
  })
})

describe('redirects', () => {
  it('never follows a redirect, so a 307 to another origin gets no client key', async () => {
    const { createServer } = await import('node:http')
    const reached: Array<Record<string, unknown>> = []
    const other = createServer((req, res) => {
      reached.push(req.headers)
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r))
    const otherPort = (other.address() as { port: number }).port
    const api = createServer((_req, res) => res.writeHead(307, { location: `http://127.0.0.1:${otherPort}/v1/positions` }).end())
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r))
    const apiPort = (api.address() as { port: number }).port
    try {
      const client = createClient({ baseUrl: `http://localhost:${apiPort}`, clientKey: 'ck-secret', ownerToken: 'ot' })
      const read = await client.positions({})
      const write = await client.withdraw({ body: { product: 'example-product', amount: { kind: 'all' } } })
      expect(read).toMatchObject({ ok: false, error: { code: 'network_error', outcome: 'failed' } })
      expect(write).toMatchObject({ ok: false, error: { code: 'network_error', outcome: 'unknown' } })
      expect(reached).toEqual([])
    } finally {
      await new Promise((r) => api.close(r))
      await new Promise((r) => other.close(r))
    }
  })
})

describe('options and header values', () => {
  const fetch = (async () => answer(200, {})) as unknown as typeof globalThis.fetch
  it('refuses a bad option when the client is made, so no call throws for it', () => {
    expect(() => createClient({ baseUrl: 'api.example.com', clientKey: 'ck', fetch })).toThrow(TypeError)
    expect(() => createClient({ baseUrl: 'ftp://api.example', clientKey: 'ck', fetch })).toThrow(/https or http/)
    for (const timeoutMs of [-1, 0, 1.5, 0.4, Number.NaN, Infinity, 2 ** 31]) expect(() => createClient({ baseUrl: 'https://api.example', clientKey: 'ck', timeoutMs, fetch })).toThrow(/timeoutMs/)
    expect(() => createClient({ baseUrl: 'https://api.example', clientKey: 'ck\n', fetch })).toThrow(/clientKey/)
    expect(() => createClient({ baseUrl: 'https://api.example', clientKey: 'ck', ownerToken: 'tok\r\n', fetch })).toThrow(/ownerToken/)
    expect(() => createClient({ baseUrl: 'https://api.example', clientKey: 'ck', timeoutMs: 5000, fetch })).not.toThrow()
  })

  it('refuses plain http except to this machine, so a key or token never crosses a network in the clear', () => {
    for (const baseUrl of ['http://api.example', 'http://10.0.0.5:8080', 'http://localhost.example.com'])
      expect(() => createClient({ baseUrl, fetch })).toThrow(/https/)
    for (const baseUrl of ['http://localhost:3000', 'http://127.0.0.1:8080', 'http://[::1]:8080', 'https://api.example'])
      expect(() => createClient({ baseUrl, fetch })).not.toThrow()
  })

  it('refuses an empty or blank client key, which would quietly make the caller keyless', () => {
    for (const clientKey of ['', ' ', '   ', '\t']) expect(() => createClient({ baseUrl: 'https://api.example', clientKey, fetch })).toThrow(/clientKey/)
  })

  it('refuses any control character in a key, not only a line break', () => {
    for (const clientKey of ['ck\t\u0000', 'ck\u001b', 'ck\u007f']) expect(() => createClient({ baseUrl: 'https://api.example', clientKey, fetch })).toThrow(/clientKey/)
  })

  it('a call\'s own token with a line break is not sent, and the call failed rather than unknown', async () => {
    const { client, seen } = make(() => answer(200, REQUEST))
    const r = await client.cancel({ path: { requestId: 'req_0123456789' } }, { ownerToken: 'tok\n' })
    expect(r).toMatchObject({ ok: false, status: 0, error: { code: 'network_error', outcome: 'failed' } })
    expect(seen).toHaveLength(0)
  })
})

describe('a schema that cannot become a validator', () => {
  it('leaves the answer unreadable instead of throwing', async () => {
    let fresh: typeof createClient | undefined
    jest.isolateModules(() => {
      jest.doMock('zod', () => {
        const real = jest.requireActual('zod')
        return { ...real, z: { ...real.z, fromJSONSchema: () => { throw new Error('cannot convert') } } }
      })
      fresh = (require('../src/index') as { createClient: typeof createClient }).createClient
    })
    const fetch = (async () => answer(200, REQUEST)) as unknown as typeof globalThis.fetch
    const r = await fresh!({ baseUrl: 'https://api.example', clientKey: 'ck', fetch }).status({ path: { requestId: 'req_0123456789' } }, { ownerToken: 't' })
    expect(r).toMatchObject({ ok: false, error: { code: 'unreadable_answer' } })
    jest.dontMock('zod')
  })
})

describe('Retry-After', () => {
  it("a refusal's Retry-After header reaches the result, in seconds", async () => {
    const error = { code: 'rate_limited', message: 'Too many requests; try again later.', outcome: 'refused', traceId: 't-1' }
    const client = createClient({
      baseUrl: 'https://api.example.com',
      clientKey: 'k',
      fetch: (async () => new Response(JSON.stringify({ error }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '5', 'x-trace-id': 't-1' } })) as unknown as typeof fetch,
    })
    expect(await client.products({})).toEqual({ ok: false, status: 429, error, traceId: 't-1', retryAfter: 5 })
  })

  it('a missing or malformed Retry-After leaves it out', async () => {
    const error = { code: 'rate_limited', message: 'x', outcome: 'refused' }
    for (const h of [{}, { 'retry-after': 'soon' }]) {
      const client = createClient({ baseUrl: 'https://api.example.com', clientKey: 'k', fetch: (async () => new Response(JSON.stringify({ error }), { status: 429, headers: { 'content-type': 'application/json', ...h } })) as unknown as typeof fetch })
      expect(await client.products({})).not.toHaveProperty('retryAfter')
    }
  })
})

describe('what both clients share, pinned on the HTTP client', () => {
  afterEach(() => jest.restoreAllMocks())

  it('an error with a code that may hide a moved request, not saying unknown, is unreadable', async () => {
    const { client } = make(() => answer(504, { error: { code: 'upstream_timeout', message: 'No answer in time.', outcome: 'refused' } }))
    expect(await client.withdraw({ body: { product: 'example-product', amount: { kind: 'all' } } })).toMatchObject({ ok: false, status: 504, error: { code: 'unreadable_answer', outcome: 'unknown' } })
  })

  it.each([['__proto__'], ['constructor'], ['toString']])('a read named %s is not a listed read, so its answer is unreadable', async (read) => {
    const { client } = make(() => answer(200, { anything: true }))
    expect(await client.product_read({ path: { id: 'example-product', read } as never })).toMatchObject({ ok: false, status: 200, error: { code: 'unreadable_answer' } })
  })

  it('times a call out after 30 seconds unless timeoutMs says otherwise', async () => {
    const timeout = jest.spyOn(AbortSignal, 'timeout')
    await make(() => answer(200, { products: [] })).client.products({})
    expect(timeout).toHaveBeenLastCalledWith(30_000)
    const fetch = (async () => answer(200, { products: [] })) as unknown as typeof globalThis.fetch
    await createClient({ baseUrl: 'https://api.example', timeoutMs: 1_234, fetch }).products({})
    expect(timeout).toHaveBeenLastCalledWith(1_234)
  })

  it("the caller's own signal aborts the call", async () => {
    const ctrl = new AbortController()
    let aborted: boolean | undefined
    const { client } = make((s) => {
      ctrl.abort()
      aborted = s.init.signal?.aborted
      return answer(200, { products: [] })
    })
    await client.products({}, { signal: ctrl.signal })
    expect(aborted).toBe(true)
  })
})

describe('the request itself', () => {
  it('a call with no body sends no body key at all', async () => {
    const { client, seen } = make(() => answer(200, { products: [] }))
    await client.products({})
    expect('body' in seen[0]!.init).toBe(false)
  })

  it('names the option it refuses: baseUrl', () => {
    expect(() => createClient({ baseUrl: 'not a url' })).toThrow(/^baseUrl must be an absolute URL/)
    expect(() => createClient({ baseUrl: 'http://api.example' })).toThrow(/^baseUrl must use https/)
  })
})

describe('a call never throws for its input', () => {
  const hostile = { toString: () => { throw new Error('no') } }

  it.each([['a lone surrogate', '\uD800'], ['a value whose toString throws', hostile]])('a path value that is %s is refused and nothing is sent', async (_n, id) => {
    const { client, seen } = make(() => answer(200, { productId: null }))
    expect(await client.product({ path: { id } as never })).toMatchObject({ ok: false, status: 0, error: { code: 'invalid_path_value', outcome: 'failed' } })
    expect(seen).toHaveLength(0)
  })

  it('a query value whose toString throws is not sent, and the call failed', async () => {
    const { client, seen } = make(() => answer(200, { productId: null }))
    expect(await client.products_route({ query: { amount: hostile, chain: 'eip155:56' } as never })).toMatchObject({ ok: false, status: 0, error: { code: 'network_error', outcome: 'failed' } })
    expect(seen).toHaveLength(0)
  })
})

describe('options are read once, when the client is made', () => {
  it('changing the options object afterwards changes nothing a call sends', async () => {
    const seen: Seen[] = []
    const fetch = (async (url: URL, init: RequestInit) => {
      seen.push({ url: String(url), init })
      return answer(200, { positions: [] })
    }) as unknown as typeof globalThis.fetch
    const opts = { baseUrl: 'https://api.example', clientKey: 'ck', ownerToken: 'tok', fetch }
    const client = createClient(opts)
    Object.assign(opts, { baseUrl: 'http://evil.example', clientKey: 'other', ownerToken: 'other', fetch: undefined })
    expect(await client.positions({})).toMatchObject({ ok: true })
    expect(seen[0]!.url).toBe('https://api.example/v1/positions')
    expect(header(seen[0]!, 'Tempora-Client-Key')).toBe('ck')
    expect(header(seen[0]!, 'authorization')).toBe('Bearer tok')
  })

  it('an option is read once, so the value checked is the value used', async () => {
    let reads = 0
    const seen: Seen[] = []
    const fetch = (async (url: URL, init: RequestInit) => {
      seen.push({ url: String(url), init })
      return answer(200, { positions: [] })
    }) as unknown as typeof globalThis.fetch
    const client = createClient({ get baseUrl() { return reads++ === 0 ? 'https://api.example' : 'http://evil.example' }, fetch })
    await client.products({})
    expect(seen[0]!.url).toBe('https://api.example/v1/products')
  })
})

describe('inputs that cannot be sent as given', () => {
  it('a body that cannot be written as JSON is not sent, and the call failed rather than unknown', async () => {
    const { client, seen } = make(() => answer(200, REQUEST))
    expect(await client.withdraw({ body: { product: 'p', amount: { kind: 'all' }, extra: 1n } } as never)).toMatchObject({ ok: false, status: 0, error: { code: 'network_error', outcome: 'failed' } })
    expect(seen).toHaveLength(0)
  })

  it.each([['missing', undefined], ['empty', ''], ['a number', 5], ['an object', {}]])('a path value that is %s is refused and nothing is sent', async (_n, id) => {
    const { client, seen } = make(() => answer(200, { productId: null }))
    expect(await client.product({ path: { id } as never })).toMatchObject({ ok: false, status: 0, error: { code: 'invalid_path_value', outcome: 'failed' } })
    expect(seen).toHaveLength(0)
  })

  it('refuses an empty owner token and a baseUrl carrying a user or password when the client is made', () => {
    expect(() => createClient({ baseUrl: 'https://api.example', ownerToken: '' })).toThrow(/ownerToken/)
    expect(() => createClient({ baseUrl: 'https://user:pass@api.example' })).toThrow(/^baseUrl must not carry/)
    expect(() => createClient({ baseUrl: 'https://user@api.example' })).toThrow(/^baseUrl must not carry/)
  })

  it('a Retry-After above one day is left out', async () => {
    const error = { code: 'rate_limited', message: 'Slow down.', outcome: 'refused' }
    const at = (wait: string) => make(() => new Response(JSON.stringify({ error }), { status: 429, headers: { 'retry-after': wait } })).client.products({})
    expect(await at('86400')).toMatchObject({ retryAfter: 86_400 })
    expect('retryAfter' in (await at('86401'))).toBe(false)
  })
})

describe('the client survives a careless caller and a careless fetch', () => {
  it('a call made with no argument at all is a Result, not a throw', async () => {
    const { client } = make(() => answer(200, { products: [] }))
    expect(await (client.products as unknown as () => Promise<unknown>)()).toMatchObject({ ok: true })
  })

  it('a timeout fires even when the given fetch ignores the abort signal', async () => {
    const fetch = (() => new Promise(() => {})) as unknown as typeof globalThis.fetch
    const client = createClient({ baseUrl: 'https://api.example', timeoutMs: 50, fetch })
    const started = Date.now()
    expect(await client.products({})).toMatchObject({ ok: false, status: 0, error: { code: 'network_error', outcome: 'failed' } })
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})

describe('a fetch that resolves to something that is not a response', () => {
  it.each([['null', null], ['an empty object', {}], ['a bare ok and status', { ok: true, status: 200 }]])('%s is a network_error Result, not a throw', async (_, value) => {
    const fetch = (async () => value) as unknown as typeof globalThis.fetch
    const client = createClient({ baseUrl: 'https://api.example', fetch })
    expect(await client.products({})).toMatchObject({ ok: false, status: 0, error: { code: 'network_error' } })
  })

  it.each(['status', 'ok', 'headers', 'json'])('a response with no %s is one too', async (field) => {
    const whole: Record<string, unknown> = { status: 200, ok: true, headers: new Headers(), json: async () => ({ products: [] }) }
    expect(await createClient({ baseUrl: 'https://api.example', fetch: (async () => whole) as unknown as typeof globalThis.fetch }).products({})).toMatchObject({ ok: true })
    delete whole[field]
    const client = createClient({ baseUrl: 'https://api.example', fetch: (async () => whole) as unknown as typeof globalThis.fetch })
    expect(await client.products({})).toMatchObject({ ok: false, status: 0, error: { code: 'network_error' } })
  })
})

describe('a body that never ends', () => {
  // A given fetch that ignores the abort signal and answers with a body that never closes: the timeout still ends the call.
  const endless = (async () => new Response(new ReadableStream({ start() {} }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof globalThis.fetch
  it('ends at the timeout as unreadable_answer: failed on a read, unknown on a write', async () => {
    const client = createClient({ baseUrl: 'https://api.example', ownerToken: 'tok', timeoutMs: 50, fetch: endless })
    const started = Date.now()
    expect(await client.products({})).toMatchObject({ ok: false, status: 200, error: { code: 'unreadable_answer', outcome: 'failed' } })
    expect(await client.withdraw({ body: { product: 'example-product', amount: { kind: 'all' } } })).toMatchObject({ ok: false, status: 200, error: { code: 'unreadable_answer', outcome: 'unknown' } })
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})
