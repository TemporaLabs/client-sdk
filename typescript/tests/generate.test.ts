import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { z } from 'zod'

import { errorCodes, generate, operationsOf, readToolDoc, tsType, type Spec } from '../scripts/generate'
import { DEFS, ERROR_BODY, OPERATIONS } from '../src/generated/spec'
import { createClient } from '../src/index'

// The package (typescript/) and the repository root, which holds spec/ and the repository-wide scripts/.
const root = path.resolve(__dirname, '..')
const repo = path.resolve(root, '..')
const SPEC = JSON.parse(fs.readFileSync(path.join(repo, 'spec', 'openapi.json'), 'utf8')) as Spec
const clone = (): Spec => JSON.parse(JSON.stringify(SPEC)) as Spec
const toZod = (schema: unknown) => z.fromJSONSchema({ ...(schema as object), $defs: DEFS } as never)

describe('the API document in spec/', () => {
  it('has the 17 calls, each with its auth', () => {
    const ops = Object.fromEntries(operationsOf(SPEC).map((o) => [o.id, o.auth]))
    expect(Object.keys(ops)).toHaveLength(17)
    expect(ops).toMatchObject({ products: 'none', sign_in_challenge: 'client', account: 'owner', withdraw: 'owner', submit: 'owner' })
  })

  it('every named shape, every answer and the error body become validators', () => {
    for (const name of Object.keys(DEFS)) expect(() => toZod({ $ref: `#/$defs/${name}` })).not.toThrow()
    for (const op of Object.values(OPERATIONS) as Array<{ response: unknown; outputs?: Record<string, unknown> }>) {
      expect(() => toZod(op.response)).not.toThrow()
      for (const s of Object.values(op.outputs ?? {})) expect(() => toZod(s)).not.toThrow()
    }
    expect(() => toZod(ERROR_BODY)).not.toThrow()
  })

  it('every $ref points at a named shape', () => {
    const refs = [...JSON.stringify(SPEC).matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)].map((m) => m[1]!)
    expect(refs.length).toBeGreaterThan(100)
    for (const r of refs) expect(SPEC.components.schemas).toHaveProperty([r])
  })
})

describe('the generator fails closed', () => {
  const fails = (mutate: (s: Spec) => void, why: RegExp) => {
    const s = clone()
    mutate(s)
    expect(() => generate(s)).toThrow(why)
  }
  it('on a $ref outside the named shapes', () =>
    fails((s) => (((s.components.schemas.Tvl as Record<string, unknown>).properties as Record<string, unknown>).usd = { $ref: '#/elsewhere/Usd' }), /unsupported \$ref/))
  it('on a keyword it cannot type', () => fails((s) => ((s.components.schemas.Tvl as Record<string, unknown>).if = {}), /unsupported keyword if/))
  it('on an error body that is not { error }', () =>
    fails((s) => {
      const c = (s.components.responses!.Error as { content: Record<string, { schema: unknown }> }).content
      c['application/json']!.schema = { $ref: '#/components/schemas/ApiErrorSchema' }
    }, /must be \{ error/))
  it('on a document that is not OpenAPI 3.1', () => fails((s) => (s.openapi = '3.0.3'), /expected OpenAPI 3.1/))
  it('on a path parameter the client cannot fill', () =>
    fails((s) => {
      const op = s.paths['/v1/requests/{requestId}']!.get! as { parameters: Array<{ name: string }> }
      s.paths['/v1/requests/{request-id}'] = { get: { ...op, parameters: op.parameters.map((p) => (p.name === 'requestId' ? { ...p, name: 'request-id' } : p)) } }
      delete s.paths['/v1/requests/{requestId}']
    }, /must be a required word name/))
  it('on a path parameter that is not required', () =>
    fails((s) => {
      const op = s.paths['/v1/requests/{requestId}']!.get! as { parameters: Array<{ name: string; required?: boolean }> }
      op.parameters = op.parameters.map((p) => (p.name === 'requestId' ? { ...p, required: false } : p))
    }, /must be a required word name/))
  it('on a path that names a parameter the call does not have', () =>
    fails((s) => {
      s.paths['/v1/requests/{requestId}/{extra}'] = s.paths['/v1/requests/{requestId}']!
      delete s.paths['/v1/requests/{requestId}']
    }, /names \{extra\}/))
  it('on a call without an operationId', () => fails((s) => delete s.paths['/v1/positions']!.get!.operationId, /has no operationId/))
  it('on an unknown security scheme', () => fails((s) => (s.paths['/v1/positions']!.get!.security = [{ cookie: [] }]), /unknown security scheme/))
  it('on a required header', () =>
    fails((s) => (s.paths['/v1/positions']!.get!.parameters = [{ name: 'x-tenant', in: 'header', required: true, schema: { type: 'string' } }]), /required header x-tenant/))
  it('on a request body that is not JSON', () =>
    fails((s) => (s.paths['/v1/deposits']!.post!.requestBody = { required: true, content: { 'text/plain': { schema: { type: 'string' } } } }), /no application\/json schema/))
  it('on a keyword it cannot type inside the items of a schema with no type', () =>
    fails((s) => (s.components.schemas.ReviewProbe = { items: { not: {} } }), /unsupported keyword not/))
  it('on a keyword it cannot type inside an open object\'s other fields', () =>
    fails((s) => (s.components.schemas.Tvl = { type: 'object', properties: { usd: { type: 'number' } }, additionalProperties: { not: {} } }), /unsupported keyword not/))
  it.each([['//collector.example/v1/positions'], ['/v1/../../x'], ['https://collector.example/v1/positions'], ['/v1\\positions']])(
    'on a path that is not a plain absolute path: %s',
    (bad) =>
      fails((s) => {
        s.paths[bad] = s.paths['/v1/positions']!
        delete s.paths['/v1/positions']
      }, /is not a plain absolute path/),
  )
  // A lost answer is unknown only on a POST, so a call with any other write method would read a lost write as failed.
  it.each(['put', 'patch', 'delete'])('on a method the client does not send: %s', (method) =>
    fails((s) => (s.paths['/v1/positions']![method] = { ...s.paths['/v1/positions']!.get!, operationId: `positions_${method}` }), new RegExp(`unsupported method ${method}`)))
  // The version is written into generated source and llms.txt as text, so it must be a version and nothing else.
  it.each(['0.1.1 */ export const injected = 1; /*', '', 'v0.1.1', '0.1'])('on an API version that is not a version: %j', (version) =>
    fails((s) => (s.info.version = version), /API version/))
  it('on an Error response without x-unknown-codes', () =>
    fails((s) => delete (s.components.responses!.Error as Record<string, unknown>)['x-unknown-codes'], /x-unknown-codes/))
  it('on an error code that names no codes', () =>
    fails((s) => (((s.components.schemas.ApiErrorSchema as Record<string, Record<string, unknown>>).properties!).code = { type: 'string' }), /names no error codes/))
})

describe('the type printer fails rather than drop part of a schema', () => {
  it.each([
    ['a $ref beside properties', { $ref: '#/components/schemas/Time', properties: { a: { type: 'string' } } }],
    ['a $ref beside a type', { $ref: '#/components/schemas/Time', type: 'object' }],
    ['anyOf beside properties', { anyOf: [{ type: 'string' }], properties: { a: { type: 'string' } } }],
    ['oneOf beside required', { oneOf: [{ type: 'object' }], required: ['a'] }],
    ['allOf beside items', { allOf: [{ type: 'array' }], items: { type: 'string' } }],
    ['an enum beside properties', { enum: ['x'], properties: { a: {} } }],
    ['a const beside additionalProperties', { const: 'x', additionalProperties: true }],
    ['a $ref beside anyOf', { $ref: '#/components/schemas/Time', anyOf: [{ type: 'null' }] }],
    ['an enum beside a const', { enum: ['x', 'y'], const: 'x' }],
  ])('on %s', (_, schema) => expect(() => tsType(schema as never)).toThrow(/beside/))
  it('on a required field the object does not name', () =>
    expect(() => tsType({ type: 'object', properties: { a: { type: 'string' } }, required: ['a', 'b'] } as never)).toThrow(/required field b/))
  it('still prints an enum or a const beside its own scalar type, and a $ref beside a description', () => {
    expect(tsType({ type: 'string', enum: ['x', 'y'] } as never)).toBe('"x" | "y"')
    expect(tsType({ type: 'string', const: 'x' } as never)).toBe('"x"')
    expect(tsType({ $ref: '#/components/schemas/Time', description: 'when' } as never)).toBe('Time')
  })
})

describe('the types it prints', () => {
  it.each([
    [{ type: ['string', 'null'] }, 'string | null'],
    [{ anyOf: [{ $ref: '#/components/schemas/Time' }, { type: 'null' }] }, 'Time | null'],
    [{ type: 'object', properties: { a: { type: 'integer' }, b: { type: 'boolean' } }, required: ['a'] }, '{ a: number; b?: boolean }'],
    [{ type: 'array', items: { enum: ['x', 'y'] } }, 'Array<"x" | "y">'],
    [{ type: 'object', additionalProperties: { type: 'number' } }, 'Record<string, number>'],
    [{ type: 'object', additionalProperties: true }, 'Record<string, unknown>'],
    [{ type: 'object', additionalProperties: {} }, 'Record<string, unknown>'],
    // An open object with named fields keeps the named fields and its other ones (the EIP-712 domain).
    [{ type: 'object', properties: { chainId: { type: 'integer' } }, required: ['chainId'], additionalProperties: {} }, '{ chainId: number; [key: string]: unknown }'],
    [{ type: 'object', properties: { a: { type: 'string' } }, additionalProperties: { type: 'number' } }, '{ a?: string; [key: string]: number | string | undefined }'],
    [{ type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false }, '{ a: string }'],
  ])('%j is %s', (schema, want) => expect(tsType(schema as never)).toBe(want))
})

describe('the client-key header line', () => {
  // Consumers read the header's value from this one line (README); its form is part of the contract.
  it('appears exactly once, in a stable form, and is the header the client sends', async () => {
    const text = fs.readFileSync(path.join(root, 'src', 'generated', 'spec.ts'), 'utf8')
    const lines = text.split('\n').filter((l) => l.includes('CLIENT_KEY_HEADER'))
    expect(lines).toHaveLength(1)
    const m = /^export const CLIENT_KEY_HEADER = "([^"]+)"$/.exec(lines[0]!)
    expect(m?.[1]).toBe('Tempora-Client-Key')
    let sent: Record<string, string> = {}
    const c = createClient({ baseUrl: 'https://api.example', clientKey: 'ck', fetch: (async (_u: URL, init: RequestInit) => ((sent = init.headers as Record<string, string>), new Response('{}', { status: 200 }))) as unknown as typeof fetch })
    await c.products({})
    expect(sent[m![1]!]).toBe('ck')
  })
})

describe('llms.txt', () => {
  it('lists every error code the document names, through the error body\'s $ref', () => {
    const named = (SPEC.components.schemas.ApiErrorSchema as { properties: { code: { anyOf: Array<{ enum?: string[] }> } } }).properties.code.anyOf.flatMap((b) => b.enum ?? [])
    expect(named.length).toBeGreaterThan(0)
    const errorBody = (SPEC.components.responses!.Error as { content: { 'application/json': { schema: never } } }).content['application/json'].schema
    expect(errorCodes(SPEC, errorBody)).toEqual(named)
    const text = generate(SPEC)['llms.txt']!
    for (const c of [...named, 'network_error', 'unreadable_answer', 'wrong_origin', 'invalid_path_value']) expect(text).toContain(`\`${c}\``)
  })
})

describe('what is committed is what the document generates', () => {
  it('src/generated/ and llms.txt match spec/openapi.json and spec/tools.json', () => {
    for (const [rel, text] of Object.entries(generate(SPEC, readToolDoc(repo)))) expect(fs.readFileSync(path.join(root, rel), 'utf8')).toBe(text)
  })

  // The two checks CI runs, against a planted defect in a scratch copy of the repo.
  const scratch = () => {
    // A space in the path: the scripts must read file paths, not URL paths with %20 in them.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'client check '))
    for (const rel of ['spec', 'scripts']) fs.cpSync(path.join(repo, rel), path.join(dir, rel), { recursive: true })
    for (const rel of ['src', 'scripts']) fs.cpSync(path.join(root, rel), path.join(dir, 'typescript', rel), { recursive: true })
    fs.copyFileSync(path.join(root, 'llms.txt'), path.join(dir, 'typescript', 'llms.txt'))
    return dir
  }
  it('check-generated fails on a hand edit in src/generated/', () => {
    const dir = scratch()
    try {
      fs.appendFileSync(path.join(dir, 'typescript', 'src', 'generated', 'spec.ts'), '// edited\n')
      const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', path.join(dir, 'typescript', 'scripts', 'check-generated.ts')], { encoding: 'utf8' })
      expect(r.status).toBe(1)
      expect(r.stderr).toMatch(/src\/generated\/spec\.ts/)
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })
  it('check-generated fails on a file in src/generated/ the generator does not write', () => {
    const dir = scratch()
    try {
      const run = () => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', path.join(dir, 'typescript', 'scripts', 'check-generated.ts')], { encoding: 'utf8' })
      expect(run().status).toBe(0)
      fs.writeFileSync(path.join(dir, 'typescript', 'src', 'generated', 'stale.ts'), 'export const STALE = 1\n')
      const r = run()
      expect(r.status).toBe(1)
      expect(r.stderr).toMatch(/src\/generated\/stale\.ts/)
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })
  it('check-source passes on the copy as recorded and fails on a one-byte edit', () => {
    const dir = scratch()
    try {
      const run = () => spawnSync(process.execPath, [path.join(dir, 'scripts', 'check-source.mjs')], { encoding: 'utf8' })
      expect(run().status).toBe(0)
      fs.copyFileSync(path.join(repo, 'spec', 'SOURCE'), path.join(dir, 'spec', 'SOURCE'))
      const f = path.join(dir, 'spec', 'openapi.json')
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('"Tempora API"', '"Tempora APJ"'))
      const r = run()
      expect(r.status).toBe(1)
      expect(r.stderr).toMatch(/spec\/SOURCE says/)
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })
  it('the generator script writes the same files it is tested on', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-gen-'))
    try {
      fs.mkdirSync(path.join(dir, 'spec'))
      fs.copyFileSync(path.join(repo, 'spec', 'openapi.json'), path.join(dir, 'spec', 'openapi.json'))
      execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', path.join(root, 'scripts', 'generate.ts'), '--out', dir])
      expect(fs.readFileSync(path.join(dir, 'src', 'generated', 'types.ts'), 'utf8')).toBe(fs.readFileSync(path.join(root, 'src', 'generated', 'types.ts'), 'utf8'))
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })
})

describe('answers are checked against the document', () => {
  const REQUEST = { requestId: 'req_0123456789', action: 'withdraw', state: 'processing', chose: { product: 'example-product' }, expiresAt: '2026-11-09T00:00:00Z', steps: [] }
  const make = (status: number, body: unknown) =>
    createClient({
      baseUrl: 'https://api.example',
      clientKey: 'ck',
      fetch: (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch,
    })

  it('a good request record passes', async () => expect(await make(200, REQUEST).status({ path: { requestId: 'req_0123456789' } })).toMatchObject({ ok: true }))
  it('a request record missing a required field is unreadable', async () => {
    const { state: _s, ...missing } = REQUEST
    expect(await make(200, missing).status({ path: { requestId: 'req_0123456789' } })).toMatchObject({ ok: false, error: { code: 'unreadable_answer', outcome: 'failed' } })
  })
  it('a nullable reference takes null: a tvl read with no asOf', async () =>
    expect(await make(200, { usd: null, asOf: null, stale: true }).product_read({ path: { id: 'example-product', read: 'tvl' } })).toMatchObject({ ok: true }))
  it('an error with an outcome outside the three is unreadable, unknown on a write', async () =>
    expect(await make(409, { error: { code: 'not_found', message: 'x', outcome: 'maybe' } }).cancel({ path: { requestId: 'req_0123456789' } })).toMatchObject({
      ok: false,
      error: { code: 'unreadable_answer', outcome: 'unknown' },
    }))
  it.each(['upstream_in_progress', 'upstream_unavailable', 'upstream_timeout', 'upstream_unreadable'])(
    '%s with any outcome but unknown is unreadable',
    async (code) => {
      expect(await make(502, { error: { code, message: 'x', outcome: 'failed' } }).positions({})).toMatchObject({ ok: false, error: { code: 'unreadable_answer', outcome: 'failed' } })
      expect(await make(502, { error: { code, message: 'x', outcome: 'unknown' } }).positions({})).toMatchObject({ ok: false, error: { code, outcome: 'unknown' } })
    },
  )
  it('a read the document does not list is unreadable', async () =>
    expect(await make(200, { usd: 1, asOf: null, stale: false }).product_read({ path: { id: 'example-product', read: 'other' as 'tvl' } })).toMatchObject({
      ok: false,
      error: { code: 'unreadable_answer' },
    }))
  // The answer shapes are looked up by the read's own name, never through an object's inherited properties.
  it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__'])('a read named like an object property is unreadable: %s', async (read) =>
    expect(await make(200, { anything: true }).product_read({ path: { id: 'example-product', read: read as 'tvl' } })).toMatchObject({
      ok: false,
      error: { code: 'unreadable_answer', outcome: 'failed' },
    }))
  it('an error code the client does not know yet still passes: the code list is open', async () =>
    expect(await make(503, { error: { code: 'something_new', message: 'x', outcome: 'failed' } }).products({})).toMatchObject({
      ok: false,
      error: { code: 'something_new', outcome: 'failed' },
    }))
})

describe('the MCP tool list', () => {
  const tool = (name: string, exposure = 'public') => ({ name, description: `Read ${name}.`, exposure, inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true } })
  const doc = (tools: ReturnType<typeof tool>[], version = SPEC.info.version) => ({ version, tools })

  it('is empty until the API publishes one, and llms.txt says so', () => {
    const out = generate(SPEC)
    expect(out['src/generated/tools.ts']).toContain('export const TOOLS = [] as const')
    expect(out['llms.txt']).toMatch(/## MCP tools\n\nNone in this API version/)
  })

  it('carries the published tools, and llms.txt names each', () => {
    const out = generate(SPEC, doc([tool('products'), tool('positions', 'owner')]))
    expect(out['src/generated/tools.ts']).toContain('"name":"products"')
    expect(out['llms.txt']).toContain('- `products` (anyone): Read products.')
    expect(out['llms.txt']).toContain('- `positions` (the owner): Read positions.')
  })

  it('fails closed on a tool that is no call in the document, a repeated name, an unknown exposure, or another version', () => {
    expect(() => generate(SPEC, doc([tool('nope')]))).toThrow(/tool nope is not a call/)
    expect(() => generate(SPEC, doc([tool('products'), tool('products')]))).toThrow(/tool products is listed twice/)
    expect(() => generate(SPEC, doc([tool('products', 'everyone')]))).toThrow(/tool products has exposure everyone/)
    expect(() => generate(SPEC, doc([tool('products')], '9.9.9'))).toThrow(/the tool list is API 9.9.9/)
  })
})

describe('check-source and the tool list', () => {
  const scratch = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-tools-'))
    for (const rel of ['spec', 'scripts']) fs.cpSync(path.join(repo, rel), path.join(dir, rel), { recursive: true })
    // Each case starts from the document alone: no tool list and none recorded.
    fs.rmSync(path.join(dir, 'spec', 'tools.json'), { force: true })
    const source = path.join(dir, 'spec', 'SOURCE')
    fs.writeFileSync(source, fs.readFileSync(source, 'utf8').replace(/^tools-sha256: .*\n/m, ''))
    return dir
  }
  const run = (dir: string) => spawnSync(process.execPath, [path.join(dir, 'scripts', 'check-source.mjs')], { encoding: 'utf8' })
  const sha = (f: string) => require('node:crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex') as string

  it('passes with a recorded copy, and fails on a one-byte edit or a missing record', () => {
    const dir = scratch()
    try {
      const f = path.join(dir, 'spec', 'tools.json')
      fs.writeFileSync(f, JSON.stringify({ version: SPEC.info.version, tools: [] }))
      expect(run(dir).stderr).toMatch(/spec\/tools\.json is not recorded/)
      fs.appendFileSync(path.join(dir, 'spec', 'SOURCE'), `tools-sha256: ${sha(f)}\n`)
      expect(run(dir).status).toBe(0)
      fs.writeFileSync(f, JSON.stringify({ version: SPEC.info.version, tools: [{}] }))
      expect(run(dir).stderr).toMatch(/spec\/tools\.json is .*, spec\/SOURCE says/)
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })

  it('fails on a recorded hash with no copy', () => {
    const dir = scratch()
    try {
      fs.appendFileSync(path.join(dir, 'spec', 'SOURCE'), `tools-sha256: ${'0'.repeat(64)}\n`)
      expect(run(dir).stderr).toMatch(/spec\/tools\.json is missing/)
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })
})
