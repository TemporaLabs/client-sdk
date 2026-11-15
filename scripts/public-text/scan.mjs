#!/usr/bin/env node
// Scans the given directories for text that must never ship in a public artifact.
// Usage: node scripts/public-text/scan.mjs --tracked | --commits | <dir> [<dir> ...]
// Exits 1 and prints every hit, or exits 0 and prints how many files it read.
// A run that reads no file fails: a scan of nothing is not a pass.
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// The repository root: `--tracked` covers the whole repository whichever folder it is run from.
const top = join(here, '..', '..')
const { patterns } = JSON.parse(readFileSync(join(here, 'deny.json'), 'utf8'))
// Not inside a longer word before it; not followed by a letter or digit. A hyphen or underscore after a reference
// ends it rather than hiding it, as in a number followed by "-related".
const deny = patterns.map((p) => new RegExp(`(?<![A-Za-z0-9_-])(?:${p})(?![A-Za-z0-9])`, 'i'))
const SKIP = new Set(['node_modules', 'dist', 'tsconfig.tsbuildinfo'])

// `--tracked` scans every file git tracks, so a new root file is covered without editing this list; the exclusions
// below are the only files it skips, each named.
const TRACKED_SKIP = new Set([])
const args = process.argv.slice(2)
const tracked = args[0] === '--tracked'
const commits = args[0] === '--commits'
const dirs = commits ? ['(commits)'] : tracked
  ? execFileSync('git', ['ls-files', '-z'], { cwd: top, encoding: 'utf8' }).split('\0').filter((f) => f && !TRACKED_SKIP.has(f)).map((f) => join(top, f))
  : args
if (dirs.length === 0) {
  console.error('usage: scan.mjs --tracked | --commits | <dir> [<dir> ...]')
  process.exit(2)
}

let read = 0
const hits = []
const walk = (p) => {
  const st = statSync(p)
  if (st.isDirectory()) {
    for (const name of readdirSync(p)) if (!SKIP.has(name)) walk(join(p, name))
    return
  }
  const text = readFileSync(p, 'utf8')
  // A binary file has no text to leak; it is counted as skipped, never as read.
  if (text.includes('\0')) return
  read += 1
  scanText(relative(process.cwd(), p), text)
}
const scanText = (label, text) =>
  text.split('\n').forEach((line, i) => {
    for (const re of deny) {
      const m = re.exec(line)
      if (m) hits.push(`${label}:${i + 1}: "${m[0]}"`)
    }
  })

// Every commit message on the current branch. A merge or squash title carries this repository's own pull-request
// number, put there by GitHub: "Merge pull request #N from <branch>" (or "#N: <subject>" by hand), and "<subject> (#N)"
// for a squash. That number alone is dropped from the subject line before the scan; the rest of the subject, and the
// whole body, are scanned.
const scanCommits = () => {
  const log = execFileSync('git', ['log', '--format=%H%x00%B%x01'], { encoding: 'utf8' })
  for (const entry of log.split('\x01')) {
    const at = entry.indexOf('\0')
    if (at === -1) continue
    const hash = entry.slice(0, at).trim()
    const [subject = '', ...body] = entry.slice(at + 1).replace(/^\n/, '').split('\n')
    const own = subject.replace(/^Merge pull request #[0-9]+/, 'Merge pull request').replace(/ \(#[0-9]+\)$/, '')
    read += 1
    scanText(`commit ${hash.slice(0, 12)}`, [own, ...body].join('\n'))
  }
}
if (commits) scanCommits()
else for (const d of dirs) walk(d)

const unit = commits ? 'commit(s)' : 'file(s)'
if (read === 0) {
  console.error(`public-text: no ${commits ? 'commit' : 'file'} read`)
  process.exit(1)
}
if (hits.length > 0) {
  console.error(`public-text: ${hits.length} hit(s)\n${hits.join('\n')}`)
  process.exit(1)
}
console.log(`public-text: ${read} ${unit} read, no hit`)
