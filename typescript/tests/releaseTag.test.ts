import { spawnSync } from 'node:child_process'
import * as path from 'node:path'

const script = path.resolve(__dirname, '..', 'scripts', 'release-tag.mjs')
const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })

describe('which tags the publish workflow accepts', () => {
  it.each([
    ['v0.2.2', '0.2.2'],
    ['v1.10.0', '1.10.0'],
    ['v0.0.0', '0.0.0'],
  ])('publishes the release %s', (tag, version) => {
    const r = run(tag, version)
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe('')
  })

  it.each([
    ['v0.2.2-rc.1', '0.2.2-rc.1'],
    ['v0.2.2-rc.0', '0.2.2-rc.0'],
    ['v0.2.2-beta.1', '0.2.2-beta.1'],
    ['v0.2.2-alpha', '0.2.2-alpha'],
    ['0.2.2', '0.2.2'],
    ['v0.02.2', '0.02.2'],
    ['v0.2', '0.2'],
    ['v0.2.2.1', '0.2.2.1'],
    ['v0.2.2 ', '0.2.2 '],
  ])('refuses the tag %j', (tag, version) => {
    const r = run(tag, version)
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr).toMatch(/is not a release tag/)
  })

  it.each([
    ['v0.2.2', '0.2.1'],
    ['v0.2.2', '0.2.2-rc.1'],
  ])('refuses %s when package.json says %s', (tag, version) => {
    const r = run(tag, version)
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr).toMatch(/package\.json says/)
  })

  it('reads the version from package.json when none is given', () => {
    const r = run('v0.0.0')
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/package\.json says \d+\.\d+\.\d+/)
  })

  it('refuses to run without a tag', () => {
    expect(run().status).toBe(1)
  })
})
