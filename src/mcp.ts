/**
 * `@temporalabs/client/mcp`: the Tempora API's calls over its MCP endpoint, with the same names and the same Result as the
 * HTTP client, and the API's published tool list to pin. Every call returns a result and never throws.
 */
import { API_VERSION } from './generated/spec'
import { TOOLS } from './generated/tools'
import type { CallOptions, InputOf, Name, OutputOf, Result } from './internal'
import { isTool, mcpClientFor, PROTOCOL_VERSION, type McpClientOptions, type Tool } from './mcpClient'

export { PROTOCOL_VERSION, TOOLS }

/** The API's released tool list as one document, the shape `toolBreaks` takes: what a consumer pins. */
export const RELEASED = { version: API_VERSION, tools: TOOLS } as const
export type { CallOptions, McpClientOptions, Result, Tool }

type ToolName = (typeof TOOLS)[number] extends { name: infer N } ? N & Name : never
type Method<N extends Name> = (input: InputOf<N>, options?: CallOptions) => Promise<Result<OutputOf<N>>>

/** Each published tool as a method, `status_lookup` beside `status`, and `listTools`. */
export type McpClient = { [N in ToolName | ('status' extends ToolName ? 'status_lookup' : never)]: Method<N> } & {
  listTools(options?: CallOptions): Promise<Result<readonly Tool[]>>
}

/** A client for the MCP endpoint at `url`. A bad option is a TypeError here; a call never throws. */
export function createMcpClient(opts: McpClientOptions): McpClient {
  return mcpClientFor(opts, TOOLS as unknown as readonly Tool[]) as unknown as McpClient
}

/** A released tool list, for pinning: the tool's name, who may call it, its inputs, and its answers. */
export type ToolDoc = {
  version: string
  tools: readonly { name: string; exposure: string; inputSchema: Record<string, unknown>; outputSchema?: unknown; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }[]
}

type Schema = Record<string, unknown>
const isSchema = (x: unknown): x is Schema => typeof x === 'object' && x !== null && !Array.isArray(x)
const propsOf = (s: Schema): Schema => (isSchema(s.properties) ? s.properties : {})
const required = (s: Schema) => (Array.isArray(s.required) ? (s.required as string[]) : [])
/** How deep inside an input the comparison goes; a schema nested deeper is reported as a break, not compared. */
const MAX_SCHEMA_DEPTH = 64
class TooDeep extends Error {}
/** A schema as one string whatever its key order, so two alternatives compare by content. */
const canonical = (x: unknown, depth = 0): string => {
  if (depth > MAX_SCHEMA_DEPTH) throw new TooDeep()
  return Array.isArray(x)
    ? `[${x.map((v) => canonical(v, depth + 1)).join(',')}]`
    : isSchema(x)
      ? `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${canonical(x[k], depth + 1)}`).join(',')}}`
      : JSON.stringify(x)
}

/**
 * The input changes under `path` that could break a caller: a field removed, a field made required, and the same for
 * every object field inside, at any depth (not inside array items). An alternative (`oneOf`, `anyOf`) may be added;
 * one changed or removed is reported, since a caller may be sending exactly that one.
 */
function inputBreaks(tool: string, was: Schema, is: Schema, path: string, out: string[], depth = 0): void {
  if (depth > MAX_SCHEMA_DEPTH) throw new TooDeep()
  const before = propsOf(was)
  const after = propsOf(is)
  for (const name of Object.keys(before)) {
    const at = path + name
    const w = before[name]
    const n = after[name]
    if (n === undefined) {
      out.push(`${tool}: input ${at} removed`)
      continue
    }
    if (!isSchema(w) || !isSchema(n)) continue
    inputBreaks(tool, w, n, `${at}.`, out, depth + 1)
    for (const key of ['oneOf', 'anyOf'] as const) {
      if (!Array.isArray(w[key])) continue
      const now = new Set((Array.isArray(n[key]) ? (n[key] as unknown[]) : []).map((v) => canonical(v)))
      if ((w[key] as unknown[]).some((alt) => !now.has(canonical(alt)))) out.push(`${tool}: input ${at}: an alternative was changed or removed`)
    }
  }
  const req = new Set(required(was))
  for (const r of required(is)) if (!req.has(r)) out.push(`${tool}: input ${path}${r} is now required`)
}

/**
 * Every change from a released tool list that could break a client pinned to it; an empty list means only additions.
 * The API holds itself to the same rule: no tool removed, no input removed or made required (at any depth inside an
 * object input such as `body`), no output schema dropped, no change of exposure, no read made writable, no destructive
 * tool marked safe. It does not compare a field's type, an enum's members or an output schema's content, so a field
 * retyped, an enum narrowed or an output schema replaced passes: pin those with your own tests.
 */
export function toolBreaks(released: ToolDoc, current: ToolDoc): string[] {
  // A list that is not tools cannot be compared, so it is reported as a break rather than passed or thrown on.
  const readable = (d: ToolDoc) => Array.isArray(d?.tools) && d.tools.every(isTool)
  if (!readable(released) || !readable(current)) return [`${readable(released) ? 'the current' : 'the released'} tool list is not readable`]
  const out: string[] = []
  const now = new Map(current.tools.map((t) => [t.name, t]))
  for (const was of released.tools) {
    const is = now.get(was.name)
    if (!is) {
      out.push(`${was.name}: removed`)
      continue
    }
    if (is.exposure !== was.exposure) out.push(`${was.name}: exposure changed from ${was.exposure} to ${is.exposure}`)
    if (was.outputSchema !== undefined && is.outputSchema === undefined) out.push(`${was.name}: output schema removed`)
    if (was.annotations?.readOnlyHint === true && is.annotations?.readOnlyHint !== true) out.push(`${was.name}: no longer read-only`)
    if (was.annotations?.destructiveHint === true && is.annotations?.destructiveHint !== true) out.push(`${was.name}: no longer marked destructive`)
    try {
      inputBreaks(was.name, was.inputSchema, is.inputSchema, '', out)
    } catch (e) {
      if (!(e instanceof TooDeep)) throw e
      out.push(`${was.name}: input nested too deep to compare (more than ${MAX_SCHEMA_DEPTH} levels)`)
    }
  }
  return out
}
