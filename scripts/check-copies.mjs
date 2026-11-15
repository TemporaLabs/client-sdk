#!/usr/bin/env node
// Each package folder ships its own LICENSE and NOTICE, because a package is packed from its own folder. They must
// be byte-identical to the ones at the repository root, which are the originals.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const PACKAGES = ['typescript', 'python']
const COPIES = ['LICENSE', 'NOTICE']

const stale = []
for (const pkg of PACKAGES) {
  for (const f of COPIES) {
    let copy
    try {
      copy = readFileSync(join(root, pkg, f))
    } catch {
      stale.push(`${pkg}/${f} (missing)`)
      continue
    }
    if (!copy.equals(readFileSync(join(root, f)))) stale.push(`${pkg}/${f}`)
  }
}
if (stale.length > 0) {
  console.error(`check-copies: not the same as the root file: ${stale.join(', ')}. Copy the root file over it.`)
  process.exit(1)
}
console.log(`check-copies: ${COPIES.join(' and ')} match the root in ${PACKAGES.join(', ')}`)
