#!/usr/bin/env node
// spec/SOURCE names the API version spec/openapi.json was copied at and that file's sha256. Fails when the copy no
// longer matches, so an edited or half-updated copy cannot pass for the API's own.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const source = readFileSync(join(root, 'spec', 'SOURCE'), 'utf8')
const field = (k) => new RegExp(`^${k}: (\\S+)$`, 'm').exec(source)?.[1]
const want = field('sha256')
const version = field('api-version')
const spec = readFileSync(join(root, 'spec', 'openapi.json'))
const fail = (why) => {
  console.error(`check-source: ${why}`)
  process.exit(1)
}
if (!want || !/^[0-9a-f]{64}$/.test(want)) fail('spec/SOURCE has no sha256')
if (!version) fail('spec/SOURCE has no api-version')
const have = createHash('sha256').update(spec).digest('hex')
if (have !== want) fail(`spec/openapi.json is ${have}, spec/SOURCE says ${want}`)
const info = JSON.parse(spec.toString('utf8')).info
if (info?.version !== version) fail(`spec/openapi.json is API ${info?.version}, spec/SOURCE says ${version}`)
// The MCP tool list is copied with the document and recorded beside it.
const toolsFile = join(root, 'spec', 'tools.json')
const wantTools = field('tools-sha256')
if (existsSync(toolsFile)) {
  if (!wantTools || !/^[0-9a-f]{64}$/.test(wantTools)) fail('spec/tools.json is not recorded: spec/SOURCE has no tools-sha256')
  const tools = readFileSync(toolsFile)
  const haveTools = createHash('sha256').update(tools).digest('hex')
  if (haveTools !== wantTools) fail(`spec/tools.json is ${haveTools}, spec/SOURCE says ${wantTools}`)
  const toolsVersion = JSON.parse(tools.toString('utf8')).version
  if (toolsVersion !== version) fail(`spec/tools.json is API ${toolsVersion}, spec/SOURCE says ${version}`)
} else if (wantTools) {
  fail('spec/tools.json is missing, and spec/SOURCE records a tools-sha256')
}
console.log(`check-source: spec/openapi.json is the API ${version} document, as recorded${existsSync(toolsFile) ? ', with its tool list' : ''}`)
