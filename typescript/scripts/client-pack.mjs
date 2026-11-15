#!/usr/bin/env node
// Packs @temporalabs/client and proves the tarball is safe to hand out: only the allowed files, no
// internal text, no private dependency, and it installs and type-checks in a clean project.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const pkgDir = root
const ALLOWED = ['package.json', 'README.md', 'LICENSE', 'NOTICE', 'llms.txt', 'build/index.js', 'build/index.d.ts', 'build/mcp.js', 'build/mcp.d.ts']
const BUILT = ALLOWED.filter((f) => f.startsWith('build/'))
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
const fail = (why) => {
  console.error(`client-pack: ${why}`)
  process.exit(1)
}

const work = mkdtempSync(join(tmpdir(), 'client-pack-'))
const pack = (dest) => {
  run('mkdir', ['-p', dest], work)
  run('npm', ['run', 'build'], pkgDir)
  return JSON.parse(run('npm', ['pack', '--json', '--pack-destination', dest], pkgDir))[0]
}
try {
  const packed = pack(work)
  const again = pack(join(work, 'again'))
  if (again.integrity !== packed.integrity) fail(`two builds differ: ${packed.integrity} vs ${again.integrity}`)
  const files = packed.files.map((f) => f.path).sort()
  if (JSON.stringify(files) !== JSON.stringify([...ALLOWED].sort())) fail(`unexpected files: ${files.join(', ')}`)

  const extracted = join(work, 'extracted')
  run('mkdir', ['-p', extracted], work)
  run('tar', ['-xzf', join(work, packed.filename), '-C', extracted, '--strip-components=1'], work)
  run('node', [join(root, '..', 'scripts', 'public-text', 'scan.mjs'), extracted], root)
  for (const f of BUILT) {
    if (/^\s*(\/\/|\/\*)/m.test(readFileSync(join(extracted, f), 'utf8'))) fail(`${f} carries a comment`)
  }
  const manifest = JSON.parse(readFileSync(join(extracted, 'package.json'), 'utf8'))
  const deps = Object.keys(manifest.dependencies ?? {})
  if (deps.some((d) => d.startsWith('@temporalabs/'))) fail(`private dependency: ${deps.join(', ')}`)

  const app = join(work, 'app')
  run('mkdir', ['-p', app], work)
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'clean-install', private: true, type: 'module' }))
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(work, packed.filename), `typescript@${readTs()}`], app)
  writeFileSync(
    join(app, 'index.ts'),
    [
      "import { createClient, type Result } from '@temporalabs/client'",
      "const c = createClient({ baseUrl: 'https://api.example', clientKey: 'k' })",
      "const r: Promise<Result<unknown>> = c.withdraw({ body: { product: 'example-product', amount: { kind: 'all' } } })",
      // The types are real, not `any`: an amount kind outside the union must not compile.
      '// @ts-expect-error',
      "void c.withdraw({ body: { product: 'example-product', amount: { kind: 'everything' } } })",
      'void r',
      // The MCP entry point resolves, type-checks, and keeps its own types.
      "import { createMcpClient, toolBreaks, TOOLS, type McpClient } from '@temporalabs/client/mcp'",
      "const m: McpClient = createMcpClient({ url: 'https://mcp.example/mcp' })",
      'void m.listTools()',
      "const breaks: string[] = toolBreaks({ version: '0', tools: [] }, { version: '0', tools: TOOLS })",
      'void breaks',
    ].join('\n'),
  )
  writeFileSync(
    join(app, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022', noEmit: true, skipLibCheck: false, lib: ['es2022', 'dom'] }, files: ['index.ts'] }),
  )
  run(join(app, 'node_modules', '.bin', 'tsc'), ['-p', '.'], app)
  const loaded = run('node', ['--input-type=module', '-e', "import('@temporalabs/client').then((m) => console.log(typeof m.createClient))"], app).trim()
  if (loaded !== 'function') fail(`import gave ${loaded}`)
  const loadedMcp = run('node', ['--input-type=module', '-e', "import('@temporalabs/client/mcp').then((m) => console.log(typeof m.createMcpClient, typeof m.toolBreaks))"], app).trim()
  if (loadedMcp !== 'function function') fail(`import of /mcp gave ${loadedMcp}`)
  console.log(`client-pack: ${packed.filename} has ${files.length} files, builds identically twice, scans clean, installs and type-checks in a clean project`)
} finally {
  rmSync(work, { recursive: true, force: true })
}

function readTs() {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).devDependencies.typescript
}
