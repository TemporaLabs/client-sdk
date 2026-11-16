/** The typed HTTP client for the Tempora API: one method per call, every answer a Result that never throws. */
import { API_VERSION, CLIENT_KEY_HEADER, OPERATIONS } from './generated/spec'
import { AUTH_SCHEME, RETRY_AFTER_HEADER, TRACE_HEADER, answerSchema, type Answer, apiErrorIn, check, checkOptions, headersSafe, local, noAnswer, offOrigin, retryAfterSeconds, schemaMismatch, send, unsentHeader, unwritableBody, type CallOptions, type InputOf, type Name, type Op, type OutputOf, type Result } from './internal'

export { API_VERSION, CLIENT_KEY_HEADER }
export type * from './generated/types'
export type { CallOptions, InputOf, OutputOf, Result }
export { signIn, withOwnerRetry } from './signIn'
export { checkBundle, checkStep, checkSteps } from './check'
export { SERVED_CHAINS } from './evm'
export type { BundleCheck, BundleToCheck, StepCheck, StepsCheck, StepToCheck, VaultCall, VaultIntent, VaultOnChain } from './check'
export { checkPortfolioDeposit, checkPortfolioWithdrawal } from './checkPortfolio'
export type { PortfolioDepositCheck, PortfolioDepositIntent, PortfolioStepToCheck, PortfolioWithdrawalCheck, PortfolioWithdrawalIntent } from './checkPortfolio'
export type { OwnerRetry, SignedIn, SignInOptions } from './signIn'

export type Client = { [N in Name]: (input: InputOf<N>, options?: CallOptions) => Promise<Result<OutputOf<N>>> }

export type ClientOptions = {
  /** The API's origin; the paths carry /v1. */
  baseUrl: string
  /** A business's client key, sent on every call. Left out, the caller is a wallet owner signing in on their own. */
  clientKey?: string
  /** Sent on owner calls unless a call passes its own. */
  ownerToken?: string
  timeoutMs?: number
  fetch?: typeof fetch
}

// Every path value is a non-empty string; anything else is refused (by the caller's catch), never sent as text.
const fill = (template: string, args: Record<string, unknown> = {}) =>
  template.replace(/\{(\w+)\}/g, (_m, k: string) => {
    const v = args[k]
    if (typeof v !== 'string' || v === '') throw new TypeError(k)
    return encodeURIComponent(v)
  })
// `.` or `..`, even percent-encoded, would move the call to another route on the same origin.
const dotSegment = (args: Record<string, unknown> = {}) => Object.values(args).some((v) => /^(\.|%2e){1,2}$/i.test(String(v)))

function call(opts: ClientOptions, name: string, op: Op) {
  return async (input: { path?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown } = {}, o: CallOptions = {}) => {
    let url: URL
    try {
      if (dotSegment(input.path)) return { ok: false, status: 0, error: { code: 'invalid_path_value', message: `A ${name} path value of "." or ".." is not a value; nothing was sent.`, outcome: 'failed' } } as const
      url = new URL(fill(op.path, input.path), opts.baseUrl)
    } catch {
      return { ok: false, status: 0, error: { code: 'invalid_path_value', message: `A ${name} path value is missing, empty, not text, or cannot be written into a URL; nothing was sent.`, outcome: 'failed' } } as const
    }
    try {
      for (const [k, v] of Object.entries(input.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v))
    } catch {
      return { ok: false, status: 0, error: { code: 'network_error', message: `The ${name} call was not sent: a query value cannot be written into a URL.`, outcome: 'failed' } } as const
    }
    // Credentials go only to the configured origin, checked on the final URL before any header is attached.
    if (url.origin !== new URL(opts.baseUrl).origin) return { ok: false, status: 0, error: offOrigin(name) } as const
    const headers: Record<string, string> = { accept: 'application/json' }
    if (opts.clientKey !== undefined) headers[CLIENT_KEY_HEADER] = opts.clientKey
    const token = o.ownerToken ?? opts.ownerToken
    if (op.auth === 'owner' && token !== undefined) headers.authorization = `${AUTH_SCHEME} ${token}`
    if (input.body !== undefined) headers['content-type'] = 'application/json'
    if (!headersSafe(headers)) return { ok: false, status: 0, error: unsentHeader(name) } as const
    let body: string | undefined
    try {
      body = input.body !== undefined ? JSON.stringify(input.body) : undefined
    } catch {
      return { ok: false, status: 0, error: unwritableBody(name) } as const
    }
    let res: Answer
    try {
      res = await send(opts, url, op.method, headers, body, o.signal)
    } catch {
      return { ok: false, status: 0, error: noAnswer(op.method, name) } as const
    }
    const traceId = res.headers.get(TRACE_HEADER) ?? undefined
    const json: unknown = await res.json().catch(() => undefined)
    if (res.ok) {
      const schema = answerSchema(op, input.path)
      const parsed = schema === undefined ? { success: false as const } : check(schema, json)
      return parsed.success
        ? ({ ok: true, status: res.status, body: parsed.data, traceId } as const)
        : ({ ok: false, status: res.status, error: schemaMismatch(op.method, name), traceId } as const)
    }
    const error = apiErrorIn(json)
    const retryAfter = retryAfterSeconds(res.headers.get(RETRY_AFTER_HEADER))
    return {
      ok: false,
      status: res.status,
      error: error ?? local(op.method, 'unreadable_answer', `The ${name} error answer was not readable.`),
      traceId,
      ...(retryAfter !== undefined ? { retryAfter } : {}),
    } as const
  }
}

export function createClient(options: ClientOptions): Client {
  // Each option is read once, here: the copy is what was checked and what every call uses.
  const opts: ClientOptions = Object.freeze({ baseUrl: options.baseUrl, clientKey: options.clientKey, ownerToken: options.ownerToken, timeoutMs: options.timeoutMs, fetch: options.fetch })
  checkOptions('baseUrl', opts.baseUrl, opts)
  const methods: Record<string, unknown> = {}
  for (const [name, op] of Object.entries(OPERATIONS as unknown as Record<string, Op>)) methods[name] = call(opts, name, op)
  return methods as Client
}
