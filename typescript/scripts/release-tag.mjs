#!/usr/bin/env node
// Decides whether a tag may be published, for the publish workflow.
//
//   node scripts/release-tag.mjs <tag> [<version>] [--latest <version npm installs today>]
//
// <version> defaults to package.json's. Only a release is published: a tag vX.Y.Z, with no leading zeros
// and nothing after the patch number. Any other shape, a prerelease such as vX.Y.Z-rc.N included, is
// refused. The tag must also name the version package.json carries. With --latest, the release must also be
// above the registry's current `latest`, so publishing never moves `latest` back to an older version; an empty
// value means nothing is published yet. On success it prints nothing and
// exits 0; otherwise it prints why and exits 1.
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
const [tag, given] = args
if (!tag) fail('usage: release-tag.mjs <tag> [<version>] [--latest <version>]')
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
