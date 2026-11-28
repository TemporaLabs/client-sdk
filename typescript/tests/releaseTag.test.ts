import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

describe('reading latest from the registry', () => {
  // A stand-in for npm: it records its arguments and answers as FAKE_NPM says.
  const dir = mkdtempSync(path.join(tmpdir(), 'release-tag-'))
  const fake = path.join(dir, 'npm')
  writeFileSync(
    fake,
    `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.FAKE_ARGS, JSON.stringify(process.argv.slice(2)))
const [kind, value] = (process.env.FAKE_NPM ?? '').split(':')
if (kind === 'ok') { process.stdout.write(value + '\\n'); process.exit(0) }
process.stderr.write('npm error code ' + value + '\\n'); process.exit(1)
`,
  )
  chmodSync(fake, 0o755)
  const argsFile = path.join(dir, 'args.json')
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const withNpm = (answer: string, npm = fake, ...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, NPM_BIN: npm, FAKE_NPM: answer, FAKE_ARGS: argsFile } })

  it('asks npm for the named package\'s latest', () => {
    expect(withNpm('ok:0.2.1', fake, 'v0.2.2', '0.2.2', '--registry', '@temporalabs/client').status).toBe(0)
    expect(JSON.parse(readFileSync(argsFile, 'utf8'))).toEqual(['view', '@temporalabs/client', 'dist-tags.latest'])
  })

  it.each([
    ['latest is lower', 'ok:0.2.1'],
  ])('publishes when %s', (_, answer) => {
    const r = withNpm(answer, fake, 'v0.2.2', '0.2.2', '--registry', 'p')
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
  })

  it.each([
    ['latest is the same version', 'ok:0.2.2', /not above the current latest/],
    ['latest is higher', 'ok:0.2.3', /not above the current latest/],
    ['latest is unreadable', 'ok:0.2', /cannot read the current latest/],
    ['npm answers with no latest for a package it has', 'ok:', /npm answered with no latest for p/],
    ['npm answers E404 without --first-publish', 'err:E404', /npm answered E404 for p/],
    ['the registry fails', 'err:E500', /could not read p's current latest/],
    ['the registry times out', 'err:ETIMEDOUT', /could not read p's current latest/],
  ])('refuses when %s', (_, answer, why) => {
    const r = withNpm(answer, fake, 'v0.2.2', '0.2.2', '--registry', 'p')
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(why)
  })

  it('reads E404 as no latest only with --first-publish', () => {
    const r = withNpm('err:E404', fake, 'v0.0.1', '0.0.1', '--registry', 'p', '--first-publish')
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
    expect(withNpm('ok:0.2.2', fake, 'v0.2.1', '0.2.1', '--first-publish', '--registry', 'p').status).toBe(1)
  })

  it('refuses when npm cannot be run at all', () => {
    const r = withNpm('ok:0.2.1', path.join(dir, 'no-such-npm'), 'v0.2.2', '0.2.2', '--registry', 'p')
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/could not read p's current latest/)
  })

  it.each([
    [['v0.2.2', '0.2.2', '--registry']],
    [['v0.2.2', '0.2.2', '--registry', '']],
    [['v0.2.2', '0.2.2', '--latest', '0.2.1', '--registry', 'p']],
    [['v0.0.1', '0.0.1', '--first-publish']],
    [['v0.0.1', '0.0.1', '--latest', '', '--first-publish']],
  ])('refuses %j', (args) => {
    expect(withNpm('ok:0.2.1', fake, ...args).status).toBe(1)
  })
})
