/**
 * The MCP client: the HTTP client's calls, each one `tools/call` POST to the API's MCP endpoint, with the same Result.
 * Credentials travel in headers, never in a tool's arguments.
 */
import { CLIENT_KEY_HEADER, OPERATIONS } from './generated/spec'
import { CLIENT_VERSION } from './version'
import type { ApiError } from './generated/types'
import { AUTH_SCHEME, RETRY_AFTER_HEADER, TRACE_HEADER, answerSchema, type Answer, apiErrorIn, check, checkOptions, headersSafe, local, noAnswer, retryAfterSeconds, schemaMismatch, send, unsentHeader, unwritableBody, type CallOptions, type Op, type Result } from './internal'

/** Whether a value has a tool's shape: a name, an exposure and an input schema object. */
export const isTool = (t: unknown): t is Tool => {
  const v = t as Partial<Tool> | null
  return typeof v === 'object' && v !== null && typeof v.name === 'string' && typeof v.exposure === 'string' && typeof v.inputSchema === 'object' && v.inputSchema !== null && !Array.isArray(v.inputSchema)
}

/** One tool of the API's published list (copied here as spec/tools.json). */
export type Tool = { name: string; description: string; exposure: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown>; annotations?: Record<string, unknown> }

export type McpClientOptions = {
  /** The MCP endpoint's address, such as https://<mcp origin>/mcp. */
  url: string
  /** Sent on every call when given. */
  clientKey?: string
  /** Sent on owner tools and on `listTools`, unless a call passes its own. */
  ownerToken?: string
  timeoutMs?: number
  fetch?: typeof fetch
}

/** The protocol revision this client speaks. */
export const PROTOCOL_VERSION = '2026-07-28'
const CLIENT_INFO = { name: '@temporalabs/client', version: CLIENT_VERSION }
// The protocol's code for a revision the server does not serve; its data names the ones it does.
const UNSUPPORTED_PROTOCOL = -32022
const META = {
  'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientInfo': CLIENT_INFO,
  'io.modelcontextprotocol/clientCapabilities': {},
}
// Every message is one JSON-RPC 2.0 request, so one id is enough.
const JSON_RPC = { jsonrpc: '2.0', id: 1 } as const
// The tool list goes out as a POST but only reads, so a lost list is `failed`, never `unknown`.
const LIST_METHOD = 'GET'
const STATUS = 'status'
const STATUS_LOOKUP = 'status_lookup'

type Input = { path?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown }
type Rpc = { result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean; tools?: unknown }; error?: { code?: unknown; data?: unknown } }

const unreadable = (method: string, name: string): ApiError => local(method, 'unreadable_answer', `The ${name} answer was not readable.`)

/** An API error, if the value is one the document allows (the same rule as the HTTP client). */
const apiError = (value: unknown): ApiError | undefined => apiErrorIn({ error: value })

/** A JSON-RPC error as a Result: the endpoint's own refusal (an API error), a protocol revision it no longer serves, or unreadable. */
function rpcError(res: Answer, error: NonNullable<Rpc['error']>, method: string, name: string): Result<never> {
  if (error.code === UNSUPPORTED_PROTOCOL) {
    const supported = (error.data as { supported?: unknown } | undefined)?.supported
    // Only date-shaped revisions are quoted: the rest of the list is the endpoint's text, not the protocol's.
    const dates = Array.isArray(supported) ? supported.filter((s): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)) : []
    const list = dates.length > 0 ? dates.join(', ') : 'none named'
    return { ok: false, status: res.status, error: { code: 'unsupported_protocol', message: `The MCP endpoint no longer serves protocol ${PROTOCOL_VERSION}; it serves ${list}. Upgrade @temporalabs/client.`, outcome: 'failed' } }
  }
  // A refusal before the protocol layer (the origin check; a deployment with no MCP endpoint) is a plain API error body,
  // `{ error: { code, message, outcome } }`, so `error` is itself the API error. A JSON-RPC error's code is a number.
  const api = apiError(error.data) ?? apiError(error)
  const retryAfter = retryAfterSeconds(res.headers.get(RETRY_AFTER_HEADER))
  return api
    ? { ok: false, status: res.status, error: api, ...(api.traceId !== undefined && { traceId: api.traceId }), ...(retryAfter !== undefined && { retryAfter }) }
    : { ok: false, status: res.status, error: unreadable(method, name) }
}

const post = (opts: McpClientOptions, headers: Record<string, string>, body: string, signal?: AbortSignal): Promise<Answer> =>
  send(opts, opts.url, 'POST', headers, body, signal)

function headersFor(opts: McpClientOptions, method: string, name: string | undefined, owner: boolean, o: CallOptions) {
  const headers: Record<string, string> = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-protocol-version': PROTOCOL_VERSION,
    'mcp-method': method,
    ...(name ? { 'mcp-name': name } : {}),
  }
  if (opts.clientKey !== undefined) headers[CLIENT_KEY_HEADER] = opts.clientKey
  const token = o.ownerToken ?? opts.ownerToken
  if (owner && token !== undefined) headers.authorization = `${AUTH_SCHEME} ${token}`
  return headers
}

const plain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

function callTool(opts: McpClientOptions, tool: Tool, name: string, op: Op) {
  return async (given: Input = {}, o: CallOptions = {}): Promise<Result<unknown>> => {
    // Only plain objects are read: a call never throws, and a string is never spread into its characters.
    const input: Input = plain(given) ? given : {}
    const args = { ...(plain(input.path) ? input.path : {}), ...(plain(input.query) ? input.query : {}), ...(input.body !== undefined ? { body: input.body } : {}) }
    const headers = headersFor(opts, 'tools/call', tool.name, tool.exposure === 'owner', o)
    if (!headersSafe(headers)) return { ok: false, status: 0, error: unsentHeader(name) }
    let rpcBody: string
    try {
      rpcBody = JSON.stringify({ ...JSON_RPC, method: 'tools/call', params: { name: tool.name, arguments: args, _meta: META } })
    } catch {
      return { ok: false, status: 0, error: unwritableBody(name) }
    }
    let res: Answer
    try {
      res = await post(opts, headers, rpcBody, o.signal)
    } catch {
      return { ok: false, status: 0, error: noAnswer(op.method, name) }
    }
    // The endpoint answers in JSON; anything else (a stream, a page) is not its answer.
    if (!(res.headers.get('content-type') ?? '').includes('application/json')) return { ok: false, status: res.status, error: unreadable(op.method, name) }
    const rpc = (await res.json().catch(() => undefined)) as Rpc | undefined
    if (rpc?.error) return rpcError(res, rpc.error, op.method, name)
    const text = rpc?.result?.content?.[0]?.text
    let value: unknown
    try {
      value = text === undefined ? undefined : JSON.parse(text)
    } catch {
      value = undefined
    }
    if (rpc?.result?.isError) {
      const v = (value ?? {}) as { error?: unknown; status?: unknown; retryAfter?: unknown }
      const error = apiError(v.error)
      // A non-2xx HTTP status stands; otherwise the body's status is used only when it is an error status.
      const status = !res.ok ? res.status : Number.isInteger(v.status) && (v.status as number) >= 400 && (v.status as number) <= 599 ? (v.status as number) : res.status
      const retryAfter = retryAfterSeconds(v.retryAfter)
      return error
        ? { ok: false, status, error, ...(error.traceId !== undefined && { traceId: error.traceId }), ...(retryAfter !== undefined && { retryAfter }) }
        : { ok: false, status, error: unreadable(op.method, name) }
    }
    if (!res.ok) return { ok: false, status: res.status, error: unreadable(op.method, name) }
    const schema = answerSchema(op, input.path)
    const body = schema === undefined || value === undefined ? { success: false as const } : check(schema, value)
    const traceId = res.headers.get(TRACE_HEADER) ?? undefined
    return body.success
      ? { ok: true, status: res.status, body: body.data, ...(traceId !== undefined && { traceId }) }
      : { ok: false, status: res.status, error: schemaMismatch(op.method, name), ...(traceId !== undefined && { traceId }) }
  }
}

function listTools(opts: McpClientOptions) {
  return async (o: CallOptions = {}): Promise<Result<readonly Tool[]>> => {
    // The owner token goes too, when there is one: the endpoint lists the owner tools only to a caller that carries it.
    const headers = headersFor(opts, 'tools/list', undefined, true, o)
    if (!headersSafe(headers)) return { ok: false, status: 0, error: unsentHeader('tool list') }
    let res: Answer
    try {
      res = await post(opts, headers, JSON.stringify({ ...JSON_RPC, method: 'tools/list', params: { _meta: META } }), o.signal)
    } catch {
      return { ok: false, status: 0, error: local(LIST_METHOD, 'network_error', 'The tool list got no answer.') }
    }
    const unreadableList = { ok: false, status: res.status, error: local(LIST_METHOD, 'unreadable_answer', 'The tool list was not readable.') } as const
    // The endpoint answers in JSON, and every item of the list must be a tool.
    if (!(res.headers.get('content-type') ?? '').includes('application/json')) return unreadableList
    const rpc = (await res.json().catch(() => undefined)) as Rpc | undefined
    if (rpc?.error) return rpcError(res, rpc.error, LIST_METHOD, 'tool list')
    // A list on a non-2xx answer is not the endpoint's answer, as for a tool call.
    if (!res.ok) return unreadableList
    const tools = rpc?.result?.tools
    return Array.isArray(tools) && tools.every(isTool) ? { ok: true, status: res.status, body: tools } : unreadableList
  }
}

/** The client over a given tool list: each tool a method, plus `status_lookup` when `status` is a tool, and `listTools`. */
export function mcpClientFor(options: McpClientOptions, tools: readonly Tool[]): Record<string, unknown> {
  // Each option is read once, here: the copy is what was checked and what every call uses.
  const opts: McpClientOptions = Object.freeze({ url: options.url, clientKey: options.clientKey, ownerToken: options.ownerToken, timeoutMs: options.timeoutMs, fetch: options.fetch })
  checkOptions('url', opts.url, opts)
  const ops = OPERATIONS as unknown as Record<string, Op>
  const methods: Record<string, unknown> = { listTools: listTools(opts) }
  for (const t of tools) {
    const op = ops[t.name]
    if (!op) continue
    methods[t.name] = callTool(opts, t, t.name, op)
    if (t.name === STATUS && ops[STATUS_LOOKUP]) methods[STATUS_LOOKUP] = callTool(opts, t, STATUS_LOOKUP, ops[STATUS_LOOKUP])
  }
  return methods
}
