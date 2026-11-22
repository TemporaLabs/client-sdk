/** What both entry points share: the call and result types, the answer checks, and the option checks. Not a package entry point. */
import { z } from 'zod'

import { DEFS, ERROR_BODY, UNKNOWN_CODES } from './generated/spec'
import type { ApiError, Operations } from './generated/types'

export type Name = keyof Operations
type Part<K extends string, T> = [T] extends [never] ? unknown : { [P in K]: T }
type BodyPart<O extends { body: unknown; bodyRequired: boolean }> = [O['body']] extends [never] ? unknown : O['bodyRequired'] extends true ? { body: O['body'] } : { body?: O['body'] }
// Exactly one lookup key per call.
type OneOf<T> = { [K in keyof T]-?: { [P in K]-?: NonNullable<T[K]> } & { [P in Exclude<keyof T, K>]?: never } }[keyof T]
/** A call's input: its path, query and body, each present only when the call takes it. status_lookup takes one key. */
export type InputOf<N extends Name> = N extends 'status_lookup'
  ? { query: OneOf<Operations[N]['query']> }
  : Part<'path', Operations[N]['path']> & Part<'query', Operations[N]['query']> & BodyPart<Operations[N]>
export type OutputOf<N extends Name> = Operations[N]['output']

export type Result<T> =
  | { ok: true; status: number; body: T; traceId?: string }
  | { ok: false; status: number; error: ApiError; traceId?: string; /** Seconds to wait before trying again, when the API says. */ retryAfter?: number }

export type CallOptions = { ownerToken?: string; signal?: AbortSignal }

export type Op = { method: string; path: string; auth: 'owner' | 'client' | 'none'; response: unknown; outputs?: Record<string, unknown> }
/** The options both clients share beside their address. */
export type SharedOptions = { clientKey?: string; ownerToken?: string; timeoutMs?: number; fetch?: typeof fetch }

const DEFAULT_TIMEOUT_MS = 30_000
export const TRACE_HEADER = 'x-trace-id'
export const RETRY_AFTER_HEADER = 'retry-after'
/** The authorization scheme every owner token is sent with. */
export const AUTH_SCHEME = 'Bearer'

const validators = new Map<unknown, z.ZodType>()
const validator = (schema: unknown): z.ZodType => {
  let v = validators.get(schema)
  if (!v) {
    v = z.fromJSONSchema({ ...(schema as object), $defs: DEFS } as unknown as Parameters<typeof z.fromJSONSchema>[0])
    validators.set(schema, v)
  }
  return v
}

// The URL parser of a runtime is not one parser: Node 26's accepts a host with a punycode label that cannot be decoded
// (`xn--abc`), which Node 22 and 24 and the Python client refuse. So the `uri` answers get this check on top of zod's:
// each `xn--` label must decode (RFC 3492) to text the URL parser accepts and writes as an `xn--` host again.
// The Punycode parameter values, named as in RFC 3492 section 5.
const PUNY_BASE = 36
const PUNY_TMIN = 1
const PUNY_TMAX = 26
const PUNY_SKEW = 38
const PUNY_DAMP = 700
const PUNY_INITIAL_BIAS = 72
const PUNY_INITIAL_N = 128
const PUNY_MAXINT = 0x7fffffff
const punyAdapt = (delta: number, points: number, first: boolean): number => {
  let d = first ? Math.floor(delta / PUNY_DAMP) : delta >> 1
  d += Math.floor(d / points)
  let k = 0
  for (; d > ((PUNY_BASE - PUNY_TMIN) * PUNY_TMAX) >> 1; k += PUNY_BASE) d = Math.floor(d / (PUNY_BASE - PUNY_TMIN))
  return k + Math.floor(((PUNY_BASE - PUNY_TMIN + 1) * d) / (d + PUNY_SKEW))
}
// A host from the URL parser is lower case ASCII, so a digit is 0-9 (26-35) or a-z (0-25); anything else is not one.
const punyDigit = (c: number): number => {
  if (c >= 0x30 && c <= 0x39) return c - 0x30 + 26
  if (c >= 0x61 && c <= 0x7a) return c - 0x61
  return PUNY_BASE
}
// The threshold t of RFC 3492 section 6.2: k - bias, clamped to [tmin, tmax].
const punyThreshold = (k: number, bias: number): number => {
  if (k <= bias) return PUNY_TMIN
  if (k >= bias + PUNY_TMAX) return PUNY_TMAX
  return k - bias
}
/** Decodes the part of an `xn--` label after the prefix (RFC 3492 section 6.2), or null when it is not valid Punycode. Exported for its tests only. */
export const punyDecode = (input: string): string | null => {
  const out: number[] = []
  const basic = input.lastIndexOf('-')
  for (let j = 0; j < Math.max(basic, 0); j++) out.push(input.charCodeAt(j))
  let n = PUNY_INITIAL_N
  let i = 0
  let bias = PUNY_INITIAL_BIAS
  for (let at = basic >= 0 ? basic + 1 : 0; at < input.length; ) {
    const before = i
    let weight = 1
    for (let k = PUNY_BASE; ; k += PUNY_BASE) {
      if (at >= input.length) return null
      const digit = punyDigit(input.charCodeAt(at++))
      if (digit >= PUNY_BASE) return null
      i += digit * weight
      if (i > PUNY_MAXINT) return null
      const t = punyThreshold(k, bias)
      if (digit < t) break
      weight *= PUNY_BASE - t
    }
    bias = punyAdapt(i - before, out.length + 1, before === 0)
    n += Math.floor(i / (out.length + 1))
    i %= out.length + 1
    out.splice(i++, 0, n)
  }
  // fromCodePoint throws on a point above U+10FFFF, and `check` reads a throw as a refusal.
  return out.length === 0 ? null : String.fromCodePoint(...out)
}
// The schemes whose host the URL parser treats as a domain; the host of any other is opaque and is not read as one.
const DOMAIN_SCHEMES = ['http:', 'https:', 'ws:', 'wss:', 'ftp:', 'file:']
const punycodeHostOk = (value: string): boolean => {
  let host: string
  try {
    const url = new URL(value)
    if (!DOMAIN_SCHEMES.includes(url.protocol)) return true
    host = url.hostname
  } catch {
    return true
  }
  return host.split('.').every((label) => {
    if (!label.startsWith('xn--')) return true
    const text = punyDecode(label.slice(4))
    if (text === null) return false
    try {
      return new URL(`https://${text}`).hostname.startsWith('xn--')
    } catch {
      return false
    }
  })
}
type Node = Record<string, unknown>
const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v)
/** Whether every `uri` string in `data` that `schema` places has a host `punycodeHostOk` accepts. It only narrows what zod accepted. A union passes when a branch the data fits does. */
const uriHostsOk = (schema: unknown, data: unknown): boolean => {
  if (!isNode(schema)) return true
  const ref = schema.$ref
  if (typeof ref === 'string') return uriHostsOk((DEFS as Record<string, unknown>)[ref.slice('#/$defs/'.length)], data)
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = schema[key]
    if (Array.isArray(branches) && !branches.some((b) => validator(b).safeParse(data).success && uriHostsOk(b, data))) return false
  }
  if (Array.isArray(schema.allOf) && !schema.allOf.every((b) => uriHostsOk(b, data))) return false
  if (typeof data === 'string') return schema.format !== 'uri' || punycodeHostOk(data)
  if (Array.isArray(data)) return !isNode(schema.items) || data.every((d) => uriHostsOk(schema.items, d))
  if (isNode(data)) {
    const props = isNode(schema.properties) ? schema.properties : {}
    return Object.entries(data).every(([k, v]) => uriHostsOk(Object.hasOwn(props, k) ? props[k] : schema.additionalProperties, v))
  }
  return true
}

// A schema that cannot be turned into a validator leaves the answer unread, never a thrown call.
export const check = (schema: unknown, json: unknown): { success: true; data: unknown } | { success: false } => {
  try {
    const parsed = validator(schema).safeParse(json)
    return parsed.success && !uriHostsOk(schema, parsed.data) ? { success: false } : parsed
  } catch {
    return { success: false }
  }
}
// What fetch accepts as a header value: visible ASCII, spaces and tabs.
const headerSafe = (v: string) => /^[\t\x20-\x7e]*$/.test(v)
// The largest delay a timer accepts.
const MAX_TIMEOUT_MS = 2 ** 31 - 1

// A write whose answer was lost may have gone through, so it is `unknown`; a lost read changed nothing.
export const local = (method: string, code: 'network_error' | 'unreadable_answer', message: string): ApiError => ({
  code,
  message,
  outcome: method === 'POST' ? 'unknown' : 'failed',
})
export const offOrigin = (name: string): ApiError => ({ code: 'wrong_origin', message: `The ${name} call would leave the configured origin; nothing was sent.`, outcome: 'failed' })
export const headersSafe = (headers: Record<string, string>) => Object.values(headers).every(headerSafe)
export const unwritableBody = (name: string): ApiError => ({ code: 'network_error', message: `The ${name} call was not sent: its body cannot be written as JSON.`, outcome: 'failed' })
/** The longest wait the client passes on as `retryAfter`, in seconds: one day. A longer one is left out. */
export const MAX_RETRY_AFTER_S = 86_400
export const unsentHeader = (name: string): ApiError => ({ code: 'network_error', message: `The ${name} call was not sent: a key or token is not a valid header value.`, outcome: 'failed' })
export const schemaMismatch = (method: string, name: string): ApiError => local(method, 'unreadable_answer', `The ${name} answer did not match its schema.`)
/** A call that went out and got no answer: its outcome follows the method (see `local`). */
export const noAnswer = (method: string, name: string): ApiError => local(method, 'network_error', `The ${name} call got no answer.`)
/** Retry-After in whole seconds, up to a day; a date, or anything longer or not a whole number, is left out. */
export const retryAfterSeconds = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN
  return n >= 0 && n <= MAX_RETRY_AFTER_S ? n : undefined
}

// One answer shape per read (x-outputs), looked up as an own key, so `constructor` is not a read.
export function answerSchema(op: Op, path: Record<string, unknown> | undefined): unknown {
  const read = String(path?.read)
  return op.outputs ? (Object.hasOwn(op.outputs, read) ? op.outputs[read] : undefined) : op.response
}

/** The API error in an error body, when the document allows it. A code that may hide a moved request must say `unknown`; any other pairing is unreadable. */
export function apiErrorIn(body: unknown): ApiError | undefined {
  const parsed = check(ERROR_BODY, body)
  if (!parsed.success) return undefined
  const error = (parsed.data as { error: ApiError }).error
  return !UNKNOWN_CODES.includes(error.code) || error.outcome === 'unknown' ? error : undefined
}

/** The parts of an answer the clients read. Its body is read under the same timeout and signal as the request. */
export type Answer = { readonly status: number; readonly ok: boolean; readonly headers: { get(name: string): string | null }; json(): Promise<unknown> }

/** What a given fetch resolved to, when it is a response the client can read; anything else is no answer, so the call fails as one. */
function response(r: unknown): Response {
  const v = r as Partial<Response> | null | undefined
  if (typeof v?.status !== 'number' || typeof v.ok !== 'boolean' || typeof v.headers?.get !== 'function' || typeof v.json !== 'function') throw new TypeError('the fetch resolved to something that is not a response')
  return v as Response
}
/** One request, with the client's timeout and the caller's signal. Redirects are refused: a followed redirect would carry the credentials to wherever it points. */
export function send(opts: SharedOptions, url: string | URL, method: string, headers: Record<string, string>, body: string | undefined, signal: AbortSignal | undefined): Promise<Answer> {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const stop = signal ? AbortSignal.any([signal, timeout]) : timeout
  const sent = (opts.fetch ?? fetch)(url, { method, headers, redirect: 'error', ...(body !== undefined ? { body } : {}), signal: stop }).then(response)
  // Raced against the signal too, so the timeout holds even for a given fetch that ignores it, through the body's last byte.
  const stopped = new Promise<never>((_, reject) => {
    if (stop.aborted) reject(stop.reason)
    else stop.addEventListener('abort', () => reject(stop.reason), { once: true })
  })
  return Promise.race([sent, stopped]).then((res) => ({
    status: res.status,
    ok: res.ok,
    headers: res.headers,
    json: () => Promise.race([res.json() as Promise<unknown>, stopped]),
  }))
}

/** The options both clients take, checked the same way: a bad one is a TypeError when the client is made, so a call never throws for them. */
export function checkOptions(urlName: string, url: string, opts: SharedOptions): void {
  checkUrl(urlName, url)
  checkTimeout(opts.timeoutMs)
  checkClientKey(opts.clientKey)
  if (opts.ownerToken === '') throw new TypeError('ownerToken is empty: leave it out for a caller with no token, or give the token')
  checkHeaderValue('ownerToken', opts.ownerToken)
}
function checkUrl(name: string, value: string): URL {
  let u: URL
  try {
    u = new URL(value)
  } catch {
    throw new TypeError(`${name} must be an absolute URL, such as https://api.example.com; got ${JSON.stringify(value)}`)
  }
  if (u.username !== '' || u.password !== '') throw new TypeError(`${name} must not carry a user name or password; got ${u.host}`)
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new TypeError(`${name} must use https or http; got ${u.protocol}`)
  // A key or token sent over plain http can be read on the way, so http is only for this machine.
  if (u.protocol === 'http:' && !LOCAL_HOSTS.includes(u.hostname)) throw new TypeError(`${name} must use https unless it is this machine (localhost, 127.0.0.1 or [::1]); got ${u.host}`)
  return u
}
function checkTimeout(t: number | undefined): void {
  if (t !== undefined && !(Number.isInteger(t) && t > 0 && t <= MAX_TIMEOUT_MS)) throw new TypeError(`timeoutMs must be a whole number of milliseconds from 1 to ${MAX_TIMEOUT_MS}; got ${t}`)
}
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]']

/** A client key, when given: a header-safe value with something in it. A blank one would be sent as no key at all. */
function checkClientKey(v: string | undefined): void {
  if (v !== undefined && v.trim() === '') throw new TypeError('clientKey is empty: leave it out for a caller with no key, or give the key')
  checkHeaderValue('clientKey', v)
}
function checkHeaderValue(name: string, v: string | undefined): void {
  if (v !== undefined && !headerSafe(v)) throw new TypeError(`${name} is not a valid header value (it has a line break or a control character)`)
}
