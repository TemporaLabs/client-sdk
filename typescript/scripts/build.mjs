// Builds the published files, without comments: build/index.js and build/mcp.js (ESM, zod external), each with its .d.ts.
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { build } from 'esbuild'
import { rollup } from 'rollup'
import { dts } from 'rollup-plugin-dts'
import ts from '@typescript/typescript6'

const root = join(import.meta.dirname, '..')
process.chdir(root)
rmSync('build', { recursive: true, force: true })
rmSync('dist', { recursive: true, force: true })
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

// TypeScript 7 emits the declarations and type-checks; its compiler API is gone, so @typescript/typescript6 prints the
// comment-free output below.
// Types are bundled from the declarations tsc emits, not re-inferred from source, so union order is stable.
execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'], { stdio: 'inherit' })
// One bundle per entry, so each .d.ts stands alone (no shared chunk file).
for (const e of ENTRIES) {
  const types = await rollup({ input: `dist/${e}.d.ts`, external: ['zod'], plugins: [dts({ respectExternal: true })] })
  await types.write({ file: `build/${e}.d.ts`, format: 'es' })
}
rmSync('dist', { recursive: true, force: true })

const printer = ts.createPrinter({ removeComments: true })
for (const file of ENTRIES.flatMap((e) => [`build/${e}.js`, `build/${e}.d.ts`])) {
  writeFileSync(file, printer.printFile(ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest)))
}
