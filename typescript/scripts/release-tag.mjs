#!/usr/bin/env node
// Decides whether a tag may be published, for the publish workflow.
//
//   node scripts/release-tag.mjs <tag> [<version>]
//
// <version> defaults to package.json's. Only a release is published: a tag vX.Y.Z, with no leading zeros
// and nothing after the patch number. Any other shape, a prerelease such as vX.Y.Z-rc.N included, is
// refused. The tag must also name the version package.json carries. On success it prints nothing and
// exits 0; otherwise it prints why and exits 1.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const NUM = '(?:0|[1-9][0-9]*)'
const RELEASE = new RegExp(`^v${NUM}\\.${NUM}\\.${NUM}$`)

const fail = (why) => {
  console.error(`release-tag: ${why}`)
  process.exit(1)
}

const [tag, given] = process.argv.slice(2)
if (!tag) fail('usage: release-tag.mjs <tag> [<version>]')
const version = given ?? JSON.parse(readFileSync(join(resolve(import.meta.dirname, '..'), 'package.json'), 'utf8')).version

if (!RELEASE.test(tag)) {
  fail(`${tag} is not a release tag (vX.Y.Z); only releases are published`)
}
if (tag.slice(1) !== version) {
  fail(`tag ${tag} carries version ${tag.slice(1)} but package.json says ${version}; publishing would spend the wrong version number, permanently`)
}
