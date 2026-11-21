// A `uri` answer's host is judged the same on every Node: an `xn--` label that cannot be decoded is refused, a real one
// is accepted. Node 26's URL parser accepts both, so this is checked beside zod's check, and these cases pin where.
import { check } from '../src/internal'

const url = { type: 'string', format: 'uri' }
const ok = (schema: unknown, value: unknown) => check(schema, value).success

describe('the host of a uri answer', () => {
  const bad = ['https://xn--abc.com/x', 'https://xn--a.com/', 'https://xn--.com/', 'https://xn--zzzzzzzzz.com/', 'https://ok.example.xn--abc/']
  const good = ['https://xn--zckzah.example', 'https://xn--bcher-kva.example/x', 'https://xn--ls8h.example', 'https://xn--nxasmq6b.com', 'https://XN--BCHER-KVA.example', 'https://example.com', 'https://[::1]:8080/p', 'https://123.45.67.89']
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
  it('does not look at a string the schema does not call a uri', () => {
    expect(ok({ type: 'string' }, 'https://xn--abc.com')).toBe(true)
  })
})
