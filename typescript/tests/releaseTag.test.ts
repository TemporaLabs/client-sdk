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

describe('a release must be above the version npm installs today', () => {
  it.each([
    ['v0.2.2', '0.2.2', '0.2.1'],
    ['v0.3.0', '0.3.0', '0.2.9'],
    ['v1.0.0', '1.0.0', '0.9.9'],
    ['v0.10.0', '0.10.0', '0.9.0'],
    ['v0.2.10', '0.2.10', '0.2.9'],
  ])('publishes %s over latest %s', (tag, version, latest) => {
    const r = run(tag, version, '--latest', latest)
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe('')
  })

  it('publishes the first release when nothing is published yet', () => {
    const r = run('v0.0.1', '0.0.1', '--latest', '')
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
  })

  it.each([
    ['v0.2.1', '0.2.1', '0.2.2'],
    ['v0.2.2', '0.2.2', '0.2.2'],
    ['v0.9.0', '0.9.0', '0.10.0'],
    ['v0.2.9', '0.2.9', '0.2.10'],
    ['v0.9.9', '0.9.9', '1.0.0'],
  ])('refuses %s when latest is %s', (tag, version, latest) => {
    const r = run(tag, version, '--latest', latest)
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr).toMatch(/not above the current latest/)
  })

  it.each(['0.2', 'v0.2.2', '0.2.2-rc.1', 'garbage'])('refuses an unreadable latest %j rather than guess', (latest) => {
    const r = run('v0.2.2', '0.2.2', '--latest', latest)
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/cannot read the current latest/)
  })

  it('reads --latest wherever it comes in the arguments', () => {
    expect(run('--latest', '0.2.1', 'v0.2.2', '0.2.2').status).toBe(0)
    const r = run('--latest', '0.2.2', 'v0.2.1', '0.2.1')
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/not above the current latest/)
  })

  it('refuses --latest with no value', () => {
    expect(run('v0.2.2', '0.2.2', '--latest').status).toBe(1)
  })
})
