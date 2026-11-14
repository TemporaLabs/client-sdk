import { createClient, signIn, withOwnerRetry, type Result, type SignedIn } from '../src/index'

type Seen = { url: string; body: unknown }
const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'x-trace-id': 't-1' } })
const error = (code: string, outcome: 'refused' | 'unknown' | 'failed' = 'refused', status = 401) => answer(status, { error: { code, message: `${code}.`, outcome } })
const CHALLENGE = { message: 'Sign in to the example.', nonce: 'n-1', expiresAt: '2026-11-12T10:00:00Z' }
const TOKEN = { token: 'tok-1', tokenType: 'Bearer', expiresAt: '2026-11-12T22:00:00Z' }
const OWNER = '0x1111111111111111111111111111111111111111'

// Answers the two sign-in calls (and records them), from a script of responses per path.
const make = (respond: (path: string, n: number) => Response) => {
  const seen: Seen[] = []
  const counts = new Map<string, number>()
  const fetch = (async (url: URL, init: RequestInit) => {
    const path = new URL(String(url)).pathname
    const n = (counts.get(path) ?? 0) + 1
    counts.set(path, n)
    seen.push({ url: path, body: init.body ? JSON.parse(String(init.body)) : undefined })
    return respond(path, n)
  }) as unknown as typeof globalThis.fetch
  return { client: createClient({ baseUrl: 'https://api.example', clientKey: 'ck', fetch }), seen }
}
const okFlow = (path: string) => (path.endsWith('/challenge') ? answer(200, CHALLENGE) : answer(200, TOKEN))
const verifies = (seen: Seen[]) => seen.filter((s) => s.url.endsWith('/verify'))

describe('signIn', () => {
  it('asks for a challenge, has it signed, and verifies with the same owner and the challenge nonce', async () => {
    const { client, seen } = make(okFlow)
    const signMessage = jest.fn(async () => '0xsig')
    const r = await signIn(client, { owner: OWNER, origin: 'https://app.example', signMessage })
    expect(r).toMatchObject({ ok: true, body: TOKEN })
    expect(signMessage).toHaveBeenCalledWith(CHALLENGE.message)
    expect(seen[0]!.body).toEqual({ owner: OWNER, origin: 'https://app.example' })
    expect(seen[1]!.body).toEqual({ owner: OWNER, nonce: 'n-1', signature: '0xsig' })
  })

  it('asks for where the token works when an audience is given, and sends none when it is not', async () => {
    const withAudience = make(okFlow)
    await signIn(withAudience.client, { owner: OWNER, signMessage: async () => '0xsig', audience: 'mcp' })
    expect(verifies(withAudience.seen)[0]!.body).toEqual({ owner: OWNER, nonce: 'n-1', signature: '0xsig', audience: 'mcp' })
    // The challenge never carries it: only verify makes the token.
    expect(withAudience.seen[0]!.body).toEqual({ owner: OWNER })
    const without = make(okFlow)
    await signIn(without.client, { owner: OWNER, signMessage: async () => '0xsig' })
    expect(verifies(without.seen)[0]!.body).not.toHaveProperty('audience')
  })

  it('leaves origin out of the challenge request when none is given', async () => {
    const { client, seen } = make(okFlow)
    await signIn(client, { owner: OWNER, signMessage: async () => '0xsig' })
    expect(seen[0]!.body).toEqual({ owner: OWNER })
  })

  it('a check that returns false stops before any signature is asked for and before verify', async () => {
    const { client, seen } = make(okFlow)
    const signMessage = jest.fn(async () => '0xsig')
    const r = await signIn(client, { owner: OWNER, signMessage, check: () => false })
    expect(r).toMatchObject({ ok: false, error: { code: 'challenge_refused', outcome: 'failed' } })
    expect(signMessage).not.toHaveBeenCalled()
    expect(verifies(seen)).toHaveLength(0)
  })

  it('a check that throws refuses the same way and says why', async () => {
    const { client, seen } = make(okFlow)
    const signMessage = jest.fn(async () => '0xsig')
    const r = await signIn(client, { owner: OWNER, signMessage, check: () => { throw new Error('not the fixed format') } })
    expect(r).toMatchObject({ ok: false, error: { code: 'challenge_refused' } })
    expect(!r.ok && r.error.message).toContain('not the fixed format')
    expect(signMessage).not.toHaveBeenCalled()
    expect(verifies(seen)).toHaveLength(0)
  })

  it('a check that returns true goes on, and receives the challenge text', async () => {
    const { client } = make(okFlow)
    const check = jest.fn(async () => true as boolean)
    expect((await signIn(client, { owner: OWNER, signMessage: async () => '0xsig', check })).ok).toBe(true)
    expect(check).toHaveBeenCalledWith(CHALLENGE.message)
    expect((await signIn(client, { owner: OWNER, signMessage: async () => '0xsig', check: () => true })).ok).toBe(true)
  })

  it('a rejected signature is a failed sign-in, and verify is never sent', async () => {
    const { client, seen } = make(okFlow)
    const r = await signIn(client, { owner: OWNER, signMessage: async () => { throw new Error('user rejected') } })
    expect(r).toMatchObject({ ok: false, error: { code: 'signing_failed', outcome: 'failed' } })
    expect(verifies(seen)).toHaveLength(0)
  })

  it('an error from the challenge or from verify comes back as the API sent it, and nothing is signed after a challenge error', async () => {
    const a = make((p) => (p.endsWith('/challenge') ? error('unknown_origin', 'refused', 403) : okFlow(p)))
    const signMessage = jest.fn(async () => '0xsig')
    expect(await signIn(a.client, { owner: OWNER, signMessage })).toMatchObject({ ok: false, status: 403, error: { code: 'unknown_origin', outcome: 'refused' } })
    expect(signMessage).not.toHaveBeenCalled()
    const b = make((p) => (p.endsWith('/verify') ? error('signature_not_owner') : okFlow(p)))
    expect(await signIn(b.client, { owner: OWNER, signMessage })).toMatchObject({ ok: false, status: 401, error: { code: 'signature_not_owner' } })
  })

  it('a token that is not a Bearer token is refused and not returned', async () => {
    const { client } = make((p) => (p.endsWith('/verify') ? answer(200, { ...TOKEN, tokenType: 'Basic' }) : okFlow(p)))
    const r = await signIn(client, { owner: OWNER, signMessage: async () => '0xsig' })
    expect(r).toMatchObject({ ok: false, error: { code: 'unsupported_token_type' } })
  })

  it('does not depend on the text of the message', async () => {
    for (const message of ['plain text', 'example.com wants you to sign in\n\nURI: https://example.com\nNonce: abc', '']) {
      const { client } = make((p) => (p.endsWith('/challenge') ? answer(200, { ...CHALLENGE, message }) : answer(200, TOKEN)))
      const signMessage = jest.fn(async () => '0xsig')
      expect((await signIn(client, { owner: OWNER, signMessage })).ok).toBe(true)
      expect(signMessage).toHaveBeenCalledWith(message)
    }
  })

  it('works through a client with no client key: neither call carries one', async () => {
    const keys: boolean[] = []
    const fetch = (async (url: URL, init: RequestInit) => {
      keys.push(Object.hasOwn(init.headers as Record<string, string>, 'Tempora-Client-Key'))
      return okFlow(new URL(String(url)).pathname)
    }) as unknown as typeof globalThis.fetch
    const client = createClient({ baseUrl: 'https://api.example', fetch })
    const r = await signIn(client, { owner: OWNER, signMessage: async () => '0xsig' })
    expect(r).toMatchObject({ ok: true, body: TOKEN })
    expect(keys).toEqual([false, false])
  })

  it('never throws: a lost answer is an error result', async () => {
    const client = createClient({ baseUrl: 'https://api.example', clientKey: 'ck', fetch: (async () => { throw new Error('down') }) as unknown as typeof fetch })
    expect(await signIn(client, { owner: OWNER, signMessage: async () => '0xsig' })).toMatchObject({ ok: false, error: { code: 'network_error' } })
  })
})

describe('withOwnerRetry', () => {
  const signedIn = (token: string): Result<SignedIn> => ({ ok: true, status: 200, body: { token, tokenType: 'Bearer', expiresAt: '2026-11-12T22:00:00Z' } })
  const good = <T,>(body: T): Result<T> => ({ ok: true, status: 200, body })
  const refusal = (code: string, outcome: 'refused' | 'unknown' | 'failed' = 'refused'): Result<never> => ({ ok: false, status: 401, error: { code, message: `${code}.`, outcome } })

  it('runs the call with the token in hand and signs in no more', async () => {
    const signInFn = jest.fn(async () => signedIn('new'))
    const call = jest.fn(async (t: string) => good(t))
    expect(await withOwnerRetry({ token: 'old', signIn: signInFn }, call)).toMatchObject({ ok: true, body: 'old' })
    expect(signInFn).not.toHaveBeenCalled()
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('signs in again once on wallet_proof_required and repeats the call once with the new token', async () => {
    const signInFn = jest.fn(async () => signedIn('new'))
    const onSignIn = jest.fn()
    const call = jest.fn(async (t: string) => (t === 'old' ? refusal('wallet_proof_required') : good(t)))
    expect(await withOwnerRetry({ token: 'old', signIn: signInFn, onSignIn }, call)).toMatchObject({ ok: true, body: 'new' })
    expect(signInFn).toHaveBeenCalledTimes(1)
    expect(call.mock.calls.map((c) => c[0])).toEqual(['old', 'new'])
    expect(onSignIn).toHaveBeenCalledWith(expect.objectContaining({ token: 'new' }))
  })

  it('does not loop: a second wallet_proof_required is returned as it is', async () => {
    const signInFn = jest.fn(async () => signedIn('new'))
    const call = jest.fn(async () => refusal('wallet_proof_required'))
    expect(await withOwnerRetry({ token: 'old', signIn: signInFn }, call)).toMatchObject({ ok: false, error: { code: 'wallet_proof_required' } })
    expect(signInFn).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledTimes(2)
  })

  it.each(['unauthenticated', 'gate_failed', 'rate_limited', 'internal_error', 'upstream_timeout'])('does not repeat for %s', async (code) => {
    const signInFn = jest.fn(async () => signedIn('new'))
    const call = jest.fn(async () => refusal(code))
    expect(await withOwnerRetry({ token: 'old', signIn: signInFn }, call)).toMatchObject({ ok: false, error: { code } })
    expect(signInFn).not.toHaveBeenCalled()
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('never repeats a call whose outcome is unknown, whatever the code', async () => {
    const signInFn = jest.fn(async () => signedIn('new'))
    for (const code of ['upstream_timeout', 'network_error', 'wallet_proof_required']) {
      const call = jest.fn(async () => refusal(code, 'unknown'))
      expect(await withOwnerRetry({ token: 'old', signIn: signInFn }, call)).toMatchObject({ ok: false, error: { code, outcome: 'unknown' } })
      expect(call).toHaveBeenCalledTimes(1)
    }
    expect(signInFn).not.toHaveBeenCalled()
  })

  it('with no token, signs in first; a call refused with that fresh token is not retried', async () => {
    const signInFn = jest.fn(async () => signedIn('fresh'))
    const call = jest.fn(async () => refusal('wallet_proof_required'))
    expect(await withOwnerRetry({ signIn: signInFn }, call)).toMatchObject({ ok: false, error: { code: 'wallet_proof_required' } })
    expect(signInFn).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith('fresh')
  })

  it('a throw from the caller\'s own functions comes back as a result, not an escape', async () => {
    const good = jest.fn(async (t: string) => ({ ok: true as const, status: 200, body: t }))
    // onSignIn throws: the token was obtained but not kept, so the call is not made.
    const a = jest.fn(async () => good('x'))
    expect(await withOwnerRetry({ signIn: async () => signedIn('fresh'), onSignIn: () => { throw new Error('disk full') } }, a)).toMatchObject({ ok: false, status: 0, error: { code: 'callback_failed', outcome: 'failed' } })
    expect(a).not.toHaveBeenCalled()
    // The sign-in function throws.
    const b = jest.fn(async () => good('x'))
    expect(await withOwnerRetry({ signIn: async () => { throw new Error('no wallet') } }, b)).toMatchObject({ error: { code: 'callback_failed', outcome: 'failed' } })
    expect(b).not.toHaveBeenCalled()
    // The call throws: it may have been sent, so it is unknown, and it is not repeated.
    const signInFn = jest.fn(async () => signedIn('new'))
    const c = jest.fn(async (): Promise<Result<string>> => { throw new Error('boom') })
    const r = await withOwnerRetry({ token: 'old', signIn: signInFn }, c)
    expect(r).toMatchObject({ ok: false, error: { code: 'callback_failed', outcome: 'unknown' } })
    expect(c).toHaveBeenCalledTimes(1)
    expect(signInFn).not.toHaveBeenCalled()
  })

  it('a failed sign-in comes back as the result and the call is not made again', async () => {
    const failedSignIn = jest.fn(async (): Promise<Result<SignedIn>> => ({ ok: false, status: 0, error: { code: 'signing_failed', message: 'no.', outcome: 'failed' } }))
    const first = jest.fn(async () => good('x'))
    expect(await withOwnerRetry({ signIn: failedSignIn }, first)).toMatchObject({ ok: false, error: { code: 'signing_failed' } })
    expect(first).not.toHaveBeenCalled()
    const second = jest.fn(async () => refusal('wallet_proof_required'))
    expect(await withOwnerRetry({ token: 'old', signIn: failedSignIn }, second)).toMatchObject({ ok: false, error: { code: 'signing_failed' } })
    expect(second).toHaveBeenCalledTimes(1)
  })
})

describe('signIn goes on only when check returns true', () => {
  it.each([['nothing', undefined], ['a promise of nothing', Promise.resolve()], ['null (a regex match that failed)', null], ['0', 0], ["''", ''], ['a string', 'no'], ['an object', {}]])('a check that returns %s refuses, and nothing is signed', async (_n, verdict) => {
    const { client, seen } = make(okFlow)
    const signMessage = jest.fn(async () => '0xsig')
    const r = await signIn(client, { owner: OWNER, signMessage, check: (() => verdict) as never })
    expect(r).toMatchObject({ ok: false, status: 0, error: { code: 'challenge_refused', outcome: 'failed' } })
    expect(signMessage).not.toHaveBeenCalled()
    expect(verifies(seen)).toHaveLength(0)
  })

  it('a plain-JS check written as a regex match refuses a challenge that does not match', async () => {
    const { client } = make(() => answer(200, { ...CHALLENGE, message: 'Send everything to the attacker.' }))
    const signMessage = jest.fn(async () => '0xsig')
    const check = ((m: string) => m.match(/^Sign in to the example\.$/)) as never
    expect(await signIn(client, { owner: OWNER, signMessage, check })).toMatchObject({ ok: false, error: { code: 'challenge_refused' } })
    expect(signMessage).not.toHaveBeenCalled()
  })
})
