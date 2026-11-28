#!/usr/bin/env node
// Decides whether a tag may be published, for the publish workflow.
//
//   node scripts/release-tag.mjs <tag> [<version>] [--latest <version npm installs today> | --registry <package> [--first-publish]]
//
// <version> defaults to package.json's. Only a release is published: a tag vX.Y.Z, with no leading zeros
// and nothing after the patch number. Any other shape, a prerelease such as vX.Y.Z-rc.N included, is
// refused. The tag must also name the version package.json carries. With --latest, the release must also be
// above the registry's current `latest`, so publishing never moves `latest` back to an older version; an empty
// value means nothing is published yet. --registry <package> reads that `latest` from npm itself
// (`npm view <package> dist-tags.latest`; the npm binary is $NPM_BIN when set). npm answering that it does not have
// the package (E404) means no latest only with --first-publish, for a package's very first release: without it E404
// is refused, because a package that was published before can be answered E404 by a registry in trouble, and reading
// that as "no latest" would let a lower version through. An empty answer for a package it has, and any other failure to read the registry is refused rather than skipped. The
// publish workflow runs it twice, once in `verify` and again just before `npm publish`, because `latest` can
// move while the publish waits for its approval. On success it prints nothing and exits 0; otherwise it
// prints why and exits 1.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const NUM = '(?:0|[1-9][0-9]*)'
const RELEASE = new RegExp(`^v${NUM}\\.${NUM}\\.${NUM}$`)

const fail = (why) => {
  console.error(`release-tag: ${why}`)
  process.exit(1)
}

const args = process.argv.slice(2)
const at = args.indexOf('--latest')
let latest
if (at !== -1) {
  if (at + 1 >= args.length) fail('--latest needs a value (empty when nothing is published yet)')
  latest = args[at + 1]
  args.splice(at, 2)
}
const first = args.indexOf('--first-publish')
const firstPublish = first !== -1
if (firstPublish) args.splice(first, 1)
const reg = args.indexOf('--registry')
if (firstPublish && reg === -1) fail('--first-publish goes with --registry')
if (reg !== -1) {
  if (at !== -1) fail('give --latest or --registry, not both')
  if (reg + 1 >= args.length || !args[reg + 1]) fail('--registry needs the package name')
  const name = args[reg + 1]
  args.splice(reg, 2)
  const r = spawnSync(process.env.NPM_BIN || 'npm', ['view', name, 'dist-tags.latest'], { encoding: 'utf8' })
  if (r.status === 0) {
    // A package npm has always carries a latest; an empty answer is not "nothing published", so refuse it.
    latest = r.stdout.trim()
    if (latest === '') fail(`npm answered with no latest for ${name}, which it does have; refusing rather than guess`)
  } else if (/\bE404\b/.test(r.stderr ?? '')) {
    if (!firstPublish) fail(`npm answered E404 for ${name}; refusing rather than read it as no latest (pass --first-publish only for the package's very first release)`)
    latest = ''
  }
  else fail(`could not read ${name}'s current latest from the registry; refusing rather than skip the check\n${(r.stderr || String(r.error ?? '')).trim()}`)
}
const [tag, given] = args
if (!tag) fail('usage: release-tag.mjs <tag> [<version>] [--latest <version> | --registry <package> [--first-publish]]')
const version = given ?? JSON.parse(readFileSync(join(resolve(import.meta.dirname, '..'), 'package.json'), 'utf8')).version

if (!RELEASE.test(tag)) {
  fail(`${tag} is not a release tag (vX.Y.Z); only releases are published`)
}
if (tag.slice(1) !== version) {
  fail(`tag ${tag} carries version ${tag.slice(1)} but package.json says ${version}; publishing would spend the wrong version number, permanently`)
}
if (latest !== undefined && latest !== '') {
  if (!new RegExp(`^${NUM}\\.${NUM}\\.${NUM}$`).test(latest)) {
    fail(`cannot read the current latest ${JSON.stringify(latest)}; refusing rather than guess`)
  }
  const parts = (v) => v.split('.').map(BigInt)
  const [a, b] = [parts(version), parts(latest)]
  const i = a.findIndex((n, k) => n !== b[k])
  if (i === -1 || a[i] < b[i]) {
    fail(`${version} is not above the current latest ${latest}; publishing it would move latest back to an older version`)
  }
}
