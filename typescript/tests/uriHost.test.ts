// A `uri` answer's host is judged the same on every Node: an `xn--` label that cannot be decoded is refused, a real one
// is accepted. Node 26's URL parser accepts both, so this is checked beside zod's check, and these cases pin where.
import { check } from '../src/internal'

const url = { type: 'string', format: 'uri' }
const ok = (schema: unknown, value: unknown) => check(schema, value).success

describe('the host of a uri answer', () => {
  const bad = ['https://xn--abc.com/x', 'https://xn--a.com/', 'https://xn--.com/', 'https://xn--zzzzzzzzz.com/', 'https://ok.example.xn--abc/', 'https://xn--abc-.com/x']
  const good = ['https://xn---4kq.com', 'https://xn--4kq.com', 'foo://xn--abc.com/x', 'ipfs://xn--abc/', 'foo://xn--BCHER-kva.example', 'https://xn--zckzah.example', 'https://xn--bcher-kva.example/x', 'https://xn--ls8h.example', 'https://xn--nxasmq6b.com', 'https://XN--BCHER-KVA.example', 'https://example.com', 'https://[::1]:8080/p', 'https://123.45.67.89']
  it.each(bad)('refuses %s', (v) => expect(ok(url, v)).toBe(false))
  it.each(good)('accepts %s', (v) => expect(ok(url, v)).toBe(true))
  it('is applied where the schema places the uri: a property, an array item, a nullable one, and one branch of a union', () => {
    const obj = { type: 'object', properties: { a: url, b: { type: ['string', 'null'], format: 'uri' }, list: { type: 'array', items: url }, plain: { type: 'string' } } }
    expect(ok(obj, { a: 'https://xn--abc.com', b: null, list: [], plain: 'xn--abc' })).toBe(false)
    expect(ok(obj, { a: 'https://example.com', b: 'https://xn--abc.com' })).toBe(false)
    expect(ok(obj, { a: 'https://example.com', list: ['https://example.com', 'https://xn--abc.com'] })).toBe(false)
    expect(ok(obj, { a: 'https://example.com', b: null, list: ['https://xn--ls8h.example'], plain: 'xn--abc' })).toBe(true)
    expect(ok({ anyOf: [{ type: 'object', properties: { u: url } }, { type: 'null' }] }, { u: 'https://xn--abc.com' })).toBe(false)
    expect(ok({ anyOf: [{ type: 'object', properties: { u: url } }, { type: 'null' }] }, null)).toBe(true)
  })
  it('reads a key the schema does not name by additionalProperties, not by the object prototype', () => {
    const obj = { type: 'object', properties: {}, additionalProperties: url }
    expect(ok(obj, { constructor: 'https://xn--abc.com', other: 'https://example.com' })).toBe(false)
    expect(ok({ type: 'object', properties: {} }, { constructor: 'https://xn--abc.com' })).toBe(true)
  })
  it('does not look at a string the schema does not call a uri', () => {
    expect(ok({ type: 'string' }, 'https://xn--abc.com')).toBe(true)
  })
})

describe('a uri under nested unions whose branches overlap', () => {
  // Each level is a union of two branches that both fit, over the same next level: a walk that re-checks every
  // fitting branch does 2^depth work when the host is bad.
  const chain = (depth: number): unknown => {
    let s: unknown = url
    for (let i = 0; i < depth; i++) {
      const next = s
      s = { anyOf: [{ type: 'object', properties: { a: next } }, { type: 'object', properties: { a: next, b: { type: 'string' } } }] }
    }
    return s
  }
  const value = (depth: number, leaf: string): unknown => {
    let v: unknown = leaf
    for (let i = 0; i < depth; i++) v = { a: v }
    return v
  }
  // The walk judges the host only where the runtime's URL parser accepts it (Node 26). Elsewhere zod refuses the host
  // first, so the walk never runs, and zod's own refusal under these unions is slow and, under jest on Node 22, leaves
  // its later url checks wrong for the rest of the run. The case runs only where the walk is what decides.
  const host = 'https://xn--abc.com/'
  const walkDecides = (() => {
    try {
      new URL(host)
      return true
    } catch {
      return false
    }
  })()
  ;(walkDecides ? it : it.skip)('is judged in time that grows with the depth, not doubles with it', () => {
    const schema = chain(14)
    // The first checks build the validators, once per branch; what is timed is the walk over a bad host after that.
    const good = value(14, 'https://example.com/')
    const bad = value(14, host)
    expect(ok(schema, good)).toBe(true)
    ok(schema, bad)
    const started = performance.now()
    expect(ok(schema, bad)).toBe(false)
    expect(performance.now() - started).toBeLessThan(50)
  })
})
