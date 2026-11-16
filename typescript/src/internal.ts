/** What both entry points share: the call and result types, the answer checks, and the option checks. Not exported. */
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

const validators = new Map<unknown, z.ZodType>()
const validator = (schema: unknown): z.ZodType => {
  let v = validators.get(schema)
  if (!v) {
    v = z.fromJSONSchema({ ...(schema as object), $defs: DEFS } as unknown as Parameters<typeof z.fromJSONSchema>[0])
    validators.set(schema, v)
  }
  return v
}

// A schema that cannot be turned into a validator leaves the answer unread, never a thrown call.
export const check = (schema: unknown, json: unknown): { success: true; data: unknown } | { success: false } => {
  try {
    return validator(schema).safeParse(json)
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
