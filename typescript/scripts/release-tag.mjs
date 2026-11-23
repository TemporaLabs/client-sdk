#!/usr/bin/env node
// Decides how a tag may be published, for the publish workflow.
//
//   node scripts/release-tag.mjs <tag> [<version>]
//
// <version> defaults to package.json's. Two shapes are accepted, and nothing else:
//   - a release, vX.Y.Z: it must be on main, and it is published under the npm dist-tag `latest`;
//   - a prerelease, vX.Y.Z-rc.N: it must be on its release branch, release/vX.Y.Z, and it is published under `next`,
//     so `latest` never moves to a prerelease.
// The tag must name the version package.json carries. On success it prints `dist_tag=<tag>` and `branch=<branch>`,
// one per line, for $GITHUB_OUTPUT; otherwise it prints why and exits 1.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const NUM = '(?:0|[1-9][0-9]*)'
const CORE = `${NUM}\\.${NUM}\\.${NUM}`
const RELEASE = new RegExp(`^v(${CORE})$`)
const PRERELEASE = new RegExp(`^v(${CORE})-rc\\.${NUM}$`)

const fail = (why) => {
  console.error(`release-tag: ${why}`)
  process.exit(1)
}

const [tag, given] = process.argv.slice(2)
if (!tag) fail('usage: release-tag.mjs <tag> [<version>]')
const version = given ?? JSON.parse(readFileSync(join(resolve(import.meta.dirname, '..'), 'package.json'), 'utf8')).version

let distTag
let branch
const release = RELEASE.exec(tag)
const prerelease = PRERELEASE.exec(tag)
if (release) {
  distTag = 'latest'
  branch = 'main'
} else if (prerelease) {
  distTag = 'next'
  branch = `release/v${prerelease[1]}`
} else {
  fail(`${tag} is neither a release (vX.Y.Z) nor a prerelease (vX.Y.Z-rc.N)`)
}
if (tag.slice(1) !== version) {
  fail(`tag ${tag} carries version ${tag.slice(1)} but package.json says ${version}; publishing would spend the wrong version number, permanently`)
}
console.log(`dist_tag=${distTag}`)
console.log(`branch=${branch}`)
