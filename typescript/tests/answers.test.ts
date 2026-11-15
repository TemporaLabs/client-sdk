// The answers both clients must judge alike, from cases/answers.json, which python/tests/test_answers.py reads too:
// every named shape, every call's answer, every product read and the error bodies, each with the verdict this client's
// answer check gives. A verdict that changes here must change in the Python client in the same change.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { DEFS, OPERATIONS } from '../src/generated/spec'
import { apiErrorIn, check } from '../src/internal'

type Verdicts = { accept: unknown[]; reject: unknown[] }
type Cases = {
  schemas: Record<string, Verdicts>
  operations: Record<string, Verdicts & { reads?: Record<string, Verdicts> }>
  errors: { body: unknown; error: { code: string; outcome: string } | null }[]
}
const cases = JSON.parse(readFileSync(join(__dirname, '..', '..', 'cases', 'answers.json'), 'utf8')) as Cases
const ops = OPERATIONS as unknown as Record<string, { response: unknown; outputs?: Record<string, unknown> }>
const verdicts = (o: Verdicts) => [...o.accept.map((v) => [v, true] as const), ...o.reject.map((v) => [v, false] as const)]

describe('cases/answers.json covers the whole document', () => {
  it('names every named shape, every call and every read, and nothing else', () => {
    expect(Object.keys(cases.schemas).sort()).toEqual(Object.keys(DEFS).sort())
    expect(Object.keys(cases.operations).sort()).toEqual(Object.keys(ops).sort())
    for (const [name, op] of Object.entries(ops)) expect(Object.keys(cases.operations[name]!.reads ?? {}).sort()).toEqual(Object.keys(op.outputs ?? {}).sort())
  })
  it('has a value to accept and one to refuse for every shape and every call', () => {
    for (const o of [...Object.values(cases.schemas), ...Object.values(cases.operations)]) {
      expect(o.accept.length).toBeGreaterThan(0)
      expect(o.reject.length).toBeGreaterThan(0)
    }
  })
})

describe('the answer check gives the verdicts in cases/answers.json', () => {
  it.each(Object.entries(cases.schemas))('%s', (name, o) => {
    for (const [value, ok] of verdicts(o)) expect([value, check({ $ref: `#/$defs/${name}` }, value).success]).toEqual([value, ok])
  })
  it.each(Object.entries(cases.operations))('the %s answer', (name, o) => {
    for (const [value, ok] of verdicts(o)) expect([value, check(ops[name]!.response, value).success]).toEqual([value, ok])
    for (const [read, r] of Object.entries(o.reads ?? {})) for (const [value, ok] of verdicts(r)) expect([read, value, check(ops[name]!.outputs![read], value).success]).toEqual([read, value, ok])
  })
  it('reads each error body as the file says', () => {
    for (const { body, error } of cases.errors) {
      const read = apiErrorIn(body)
      expect([body, read === undefined ? null : { code: read.code, outcome: read.outcome }]).toEqual([body, error])
    }
  })
})
