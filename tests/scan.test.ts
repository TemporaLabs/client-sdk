import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const scan = path.resolve(__dirname, '..', 'scripts', 'public-text', 'scan.mjs')
const run = (text: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'))
  fs.writeFileSync(path.join(dir, 'a.txt'), text)
  const r = spawnSync(process.execPath, [scan, dir], { encoding: 'utf8' })
  fs.rmSync(dir, { recursive: true, force: true })
  return r.status
}

describe('the public text scan', () => {
  // Built at run time, so this file carries no reference for the scan to find.
  const ref = (before: string, n: number) => `${before}#${n}`
  it.each([ref('see ', 12), `(${ref('', 12)})`, ref('name', 12), ref('owner/name', 12), ref('PR', 5), ref('fixes some-repo', 3)])('finds a reference in %j', (text) => expect(run(text)).toBe(1))
  it.each(['no references here', 'color #fff', 'a#b', 'version 0.1.1'])('passes %j', (text) => expect(run(text)).toBe(0))
})

describe('the public text scan: references the old word guard missed', () => {
  const ref = (before: string, n: number, after = '') => `${before}#${n}${after}`
  it.each([ref('see ', 12, '-related'), ref('name', 12, '_x'), ref('see ', 12, '_'), ref('', 7, '-')])('finds a reference in %j', (text) => expect(run(text)).toBe(1))
  // A full pull-request or issue link names the repository as well as the number.
  const link = (kind: string) => ['https://github.com', 'some-org', 'some-repo', kind, '123'].join('/')
  it.each([link('pull'), link('issues'), `see ${link('pull')}#discussion`])('finds a link in %j', (text) => expect(run(text)).toBe(1))
  it.each(['step 1 of 3', 'color #fff and #abc123', 'a#b', 'https://github.com/some-org/some-repo', 'item #a-1'])('still passes %j', (text) => expect(run(text)).toBe(0))
})

describe('the public text scan of commit messages', () => {
  const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  const scanCommits = (messages: string[]) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-git-'))
    git(dir, 'init', '-q')
    for (const m of messages) git(dir, 'commit', '-q', '--allow-empty', '-m', m)
    const r = spawnSync(process.execPath, [scan, '--commits'], { cwd: dir, encoding: 'utf8' })
    fs.rmSync(dir, { recursive: true, force: true })
    return r
  }
  const n = (k: number) => `#${k}`
  it("drops this repository's own pull-request number from a merge title and a squash title, and passes", () => {
    const r = scanCommits([`Merge pull request ${n(4)} from org/branch`, `fix: a thing (${n(5)})`, 'plain commit'])
    expect(r.stdout).toMatch(/3 commit\(s\)/)
    expect(r.status).toBe(0)
  })
  const finds = (messages: string[], hit: string) => {
    const r = scanCommits(messages)
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/1 hit\(s\)/)
    expect(r.stderr).toContain(`"${hit}"`)
  }
  it('still finds a reference elsewhere in a squash title or in the body', () => {
    finds([`fix: closes ${n(9)} (${n(5)})`], n(9))
    finds([`fix: a thing (${n(5)})\n\nsee ${n(9)}`], n(9))
    finds([`Merge pull request ${n(4)} from org/branch\n\nfixes ${n(9)}`], n(9))
  })
  it('only drops the number at the very end of the subject line', () => finds([`fix: a thing (${n(5)}) and more`], n(5)))
})
