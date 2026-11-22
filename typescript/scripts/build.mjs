// Builds the published files: build/index.js and build/mcp.js (ESM bundles, zod external), and the declarations
// TypeScript 7 emits next to them (build/index.d.ts, build/mcp.d.ts and the modules they import), all without comments.
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { generate } from '@babel/generator'
import { parse } from '@babel/parser'
import { build } from 'esbuild'

const root = join(import.meta.dirname, '..')
process.chdir(root)
rmSync('build', { recursive: true, force: true })
const ENTRIES = ['index', 'mcp']
await build({
  entryPoints: ENTRIES.map((e) => `src/${e}.ts`),
  outdir: 'build',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  target: 'es2022',
  external: ['zod'],
  legalComments: 'none',
})
// Notes in the source are for this repository, not for callers: each bundle is parsed and printed again without its
// comments. The code is the same; only the layout is the printer's.
for (const e of ENTRIES) {
  const file = `build/${e}.js`
  const ast = parse(readFileSync(file, 'utf8'), { sourceType: 'module' })
  writeFileSync(file, `${generate(ast, { comments: false }).code}\n`)
}

// The declarations are emitted by TypeScript 7's tsc from the source, with comments removed (tsconfig.build.json).
execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'], { stdio: 'inherit' })
