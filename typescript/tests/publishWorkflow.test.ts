import { readFileSync } from 'node:fs'
import * as path from 'node:path'

// The publish workflow cannot run in CI (it is dispatched by hand, from a tag), so its order is pinned here.
const workflow = readFileSync(path.resolve(__dirname, '..', '..', '.github', 'workflows', 'publish.yml'), 'utf8')
const job = (name: string): string => {
  const start = workflow.indexOf(`\n  ${name}:\n`)
  expect(start).toBeGreaterThan(-1)
  const next = workflow.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/)
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next)
}
const steps = (body: string): string[] => body.split(/\n(?= {6}- )/).slice(1)

describe('the publish workflow', () => {
  const publish = job('publish')
  const all = steps(publish)
  const recheck = all.findIndex((s) => /node pkg\/release-tag\.mjs "\$TAG" "\$VER" --registry "\$NAME"/.test(s))
  const publishes = all.flatMap((s, i) => (/npm publish /.test(s) ? [i] : []))

  it('checks latest again in the publish job, before every npm publish, dry run or not', () => {
    expect(recheck).toBeGreaterThan(-1)
    expect(publishes).toHaveLength(2)
    for (const i of publishes) expect(recheck).toBeLessThan(i)
    expect(all[recheck]).not.toMatch(/\n {8}if:/)
    expect(all[recheck]).not.toMatch(/continue-on-error/)
  })

  it('runs the check verify packed, after checking its sha256', () => {
    const sums = all.findIndex((s) => /sha256sum -c -/.test(s) && /pkg\/release-tag\.mjs/.test(s))
    expect(sums).toBeGreaterThan(-1)
    expect(sums).toBeLessThan(recheck)
    const verify = job('verify')
    expect(verify).toMatch(/cp scripts\/release-tag\.mjs dist-pack\/release-tag\.mjs/)
    expect(verify).toMatch(/typescript\/dist-pack\/release-tag\.mjs/)
    expect(verify).toMatch(/node scripts\/release-tag\.mjs "\$TAG" --registry "\$\{name\}"/)
  })

  it('publishes one run at a time and never cancels a publish under way', () => {
    expect(publish).toMatch(/\n {4}concurrency:\n {6}group: npm-publish\n {6}cancel-in-progress: false\n/)
  })
})
