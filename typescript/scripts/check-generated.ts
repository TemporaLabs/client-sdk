// Fails when src/generated/ or llms.txt differs from what scripts/generate.ts writes from spec/openapi.json:
// a hand edit, a spec copied in without regenerating, or a file in src/generated/ the generator does not write.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

import { generate, readToolDoc, type Spec } from './generate.ts'

// The package is typescript/; the API document is spec/ at the repository root.
const root = join(dirname(new URL(import.meta.url).pathname), '..')
const repo = join(root, '..')
const spec = JSON.parse(readFileSync(join(repo, 'spec', 'openapi.json'), 'utf8')) as Spec
const stale: string[] = []
const written = generate(spec, readToolDoc(repo))
// A file in src/generated/ the generator no longer writes is stale too: it would ship, and nothing would update it.
const generatedDir = join(root, 'src', 'generated')
for (const e of readdirSync(generatedDir, { recursive: true, withFileTypes: true })) {
  if (!e.isFile()) continue
  const rel = relative(root, join(e.parentPath, e.name)).split('\\').join('/')
  if (!(rel in written)) stale.push(`${rel} (not generated)`)
}
for (const [rel, text] of Object.entries(written)) {
  let have = ''
  try {
    have = readFileSync(join(root, rel), 'utf8')
  } catch {
    stale.push(`${rel} (missing)`)
    continue
  }
  if (have !== text) stale.push(rel)
}
if (stale.length > 0) {
  console.error(`check-generated: not what spec/openapi.json generates: ${stale.join(', ')}. Run npm run generate.`)
  process.exit(1)
}
console.log('check-generated: src/generated/ and llms.txt match spec/openapi.json')
