import { readFileSync } from 'node:fs'
import * as path from 'node:path'

// The publish workflow cannot run in CI (it is dispatched by hand, from a tag), so its order is pinned here.
const workflow = readFileSync(path.resolve(__dirname, '..', '..', '.github', 'workflows', 'publish.yml'), 'utf8')
const job = (name: string): string => {
  const start = workflow.indexOf(`\n  ${name}:\n`)
  expect(start).toBeGreaterThan(-1)
  const next = workflow.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/)
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next)
}
const steps = (body: string): string[] => body.split(/\n(?= {6}- )/).slice(1)

describe('the publish workflow', () => {
  const publish = job('publish')
  const verifyJob = job('verify')
  const all = steps(publish)
  const recheck = all.findIndex((s) => /node gate\/typescript\/scripts\/release-tag\.mjs "\$TAG" "\$VER" --registry "\$NAME"/.test(s))
  const publishes = all.flatMap((s, i) => (/npm publish /.test(s) ? [i] : []))

  it('checks latest again in the publish job, before every npm publish, dry run or not', () => {
    expect(recheck).toBeGreaterThan(-1)
    expect(publishes).toHaveLength(2)
    for (const i of publishes) expect(recheck).toBeLessThan(i)
    expect(all[recheck]).not.toMatch(/\n {8}if:/)
    expect(all[recheck]).not.toMatch(/continue-on-error/)
  })

  it('takes the check from git at this run\'s commit, never from verify\'s artifact', () => {
    const checkout = all.findIndex((s) => /uses: actions\/checkout@/.test(s))
    expect(checkout).toBeGreaterThan(-1)
    expect(checkout).toBeLessThan(recheck)
    const step = all[checkout]
    expect(step).toMatch(/\n {10}ref: \$\{\{ github\.sha \}\}\n/)
    expect(step).toMatch(/\n {10}path: gate\n/)
    expect(step).toMatch(/\n {10}persist-credentials: false\n/)
    expect(step).toMatch(/\n {10}sparse-checkout: typescript\/scripts\/release-tag\.mjs\n/)
    expect(step).toMatch(/\n {10}sparse-checkout-cone-mode: false\n/)
    expect(all.filter((s) => /uses: actions\/checkout@/.test(s))).toHaveLength(1)
    expect(verifyJob).not.toMatch(/release-tag\.mjs dist-pack/)
    expect(verifyJob).toMatch(/node scripts\/release-tag\.mjs "\$TAG" --registry "\$\{name\}"/)
  })

  it('runs nothing from verify\'s artifact: the tarball is only hashed and published', () => {
    const uses = publish.split('\n').filter((l) => /pkg\//.test(l) || /\bpkg\b/.test(l))
    expect(uses.length).toBeGreaterThan(0)
    const allowed = [
      /^ {10}path: pkg$/,
      /^ {10}echo "\$\{SUM\}  pkg\/\$\{FILE\}" \| sha256sum -c -$/,
      /^ {10}manifest="\$\(tar -xOzf "pkg\/\$\{FILE\}" package\/package\.json\)"$/,
      /^ {10}npm publish "\.\/pkg\/\$\{FILE\}" --access public --tag latest --dry-run$/,
      /^ {8}run: npm publish "\.\/pkg\/\$\{FILE\}" --access public --tag latest --provenance$/,
    ]
    for (const l of uses) expect(allowed.some((a) => a.test(l)) ? l : `not allowed: ${l}`).toBe(l)
  })

  it('checks the name and version of the tarball it publishes, not the ones verify reported', () => {
    const step = all[recheck]
    expect(step).not.toMatch(/needs\.verify\.outputs\.(name|version)/)
    expect(step).toMatch(/\n {10}NAME="\$\(node -e 'console\.log\(JSON\.parse\(process\.argv\[1\]\)\.name\)' "\$manifest"\)"\n/)
    expect(step).toMatch(/\n {10}VER="\$\(node -e 'console\.log\(JSON\.parse\(process\.argv\[1\]\)\.version\)' "\$manifest"\)"\n/)
    expect(step).toMatch(/\n {10}\[ "\$NAME" = "@temporalabs\/client" \] \|\| \{ echo "::error::[^"]*"; exit 1; \}\n/)
  })

  it('never passes --first-publish: @temporalabs/client is already on npm, so an E404 is refused, not read as no latest', () => {
    const code = workflow.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
    expect(code).not.toMatch(/--first-publish/)
    expect(code).toMatch(/release-tag\.mjs "\$TAG" --registry/)
  })

  it('publishes one run at a time and never cancels a publish under way', () => {
    expect(publish).toMatch(/\n {4}concurrency:\n {6}group: npm-publish\n {6}cancel-in-progress: false\n/)
  })
})
