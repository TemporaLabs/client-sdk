import { spawnSync } from 'node:child_process'
import * as path from 'node:path'

const script = path.resolve(__dirname, '..', 'scripts', 'release-tag.mjs')
const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })

describe('which tags the publish workflow accepts', () => {
  it('publishes a release on main under latest', () => {
    const r = run('v0.2.2', '0.2.2')
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('dist_tag=latest\nbranch=main\n')
  })

  it.each([
    ['v0.2.2-rc.1', '0.2.2-rc.1', 'release/v0.2.2'],
    ['v0.2.2-rc.0', '0.2.2-rc.0', 'release/v0.2.2'],
    ['v1.10.0-rc.12', '1.10.0-rc.12', 'release/v1.10.0'],
  ])('publishes the prerelease %s on its release branch under next', (tag, version, branch) => {
    const r = run(tag, version)
    expect(r.status).toBe(0)
    expect(r.stdout).toBe(`dist_tag=next\nbranch=${branch}\n`)
  })

  it.each([
    ['0.2.2', '0.2.2'],
    ['v0.2.2-beta.1', '0.2.2-beta.1'],
    ['v0.2.2-rc1', '0.2.2-rc1'],
    ['v0.2.2-rc.01', '0.2.2-rc.01'],
    ['v0.2.2-rc.1.1', '0.2.2-rc.1.1'],
    ['v0.02.2', '0.02.2'],
    ['v0.2', '0.2'],
    ['v0.2.2-rc.', '0.2.2-rc.'],
    ['v0.2.2 ', '0.2.2 '],
  ])('refuses the tag %j', (tag, version) => {
    const r = run(tag, version)
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr).toMatch(/neither a release/)
  })

  it.each([
    ['v0.2.2', '0.2.1'],
    ['v0.2.2-rc.1', '0.2.2'],
    ['v0.2.2', '0.2.2-rc.1'],
    ['v0.2.2-rc.2', '0.2.2-rc.1'],
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
