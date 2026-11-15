# How the client is made

The client is mostly generated. The API's document and its MCP tool list become four generated files. The
hand-written client in `typescript/src/` uses them, and a build turns the source into the published package. Checks sit
between each pair of layers so that no layer can drift from the one before it. In the diagram, every path but
`spec/` is under `typescript/`.

```
spec/openapi.json ─┬─scripts/generate.ts──▶ src/generated/types.ts   (TypeScript types)
spec/tools.json ───┘                     ├▶ src/generated/spec.ts    (answer schemas and the call table)
   ▲                                     ├▶ src/generated/tools.ts   (the MCP tool list)
   │ spec/SOURCE (version, sha256s)      └▶ llms.txt                 (the calls and error codes, as text)
   │                                                │
   │                 src/ (hand-written: index.ts, mcp.ts and the files they share)
   │                                                │
   │                                      scripts/build.mjs
   │                                                ▼
   │                         build/index.js, build/mcp.js and their .d.ts ──npm pack──▶ the package
```

## The layers, and who owns each

**1. The API document: `spec/openapi.json`.** An OpenAPI document describes an HTTP API as data: every
path, method, parameter and answer, with the answer shapes written as JSON Schema. This file is a copy of
the Tempora API's own document, taken at an API release; `spec/tools.json` is a copy of the MCP tool list
the same release publishes. The API owns its content; this repository owns
only the copy. `spec/SOURCE` records the API version and the copy's sha256, and
`scripts/check-source.mjs` fails when any of them no longer matches, so an edited or half-updated copy cannot
pass for the API's.

**2. The generator: `typescript/scripts/generate.ts`.** It reads the document in two passes.

- `operationsOf` checks every assumption the client makes, once, and fails on the first one that does not
  hold. Among them: the document is OpenAPI 3.1; the API version is `X.Y.Z`; the client-key scheme is an
  API-key header and the owner scheme is HTTP bearer; every call has an `operationId`, states its security,
  answers 200 with JSON, and sends every other status through the shared `Error` response; every write is a
  POST (so that a lost answer to a write can always be read as `unknown`); a path cannot name another host
  or climb out with `..`; the `Error` response carries `x-unknown-codes`, the codes whose outcome is always
  `unknown`.
- `generate` prints the files. `tsType` turns a JSON Schema into a TypeScript type, and fails on any
  keyword that is neither one it can type (`TYPE_KEYWORDS`) nor one that only narrows a value at run time
  (`NARROWING`). That is what "fails closed" means here: a document the generator does not understand is
  an error, never a client with a silently missing check.

**3. The generated files.** `typescript/src/generated/types.ts` holds one type per named shape, `ApiError`, and
`Operations`: per call, its path, query and body inputs and its answer type. `typescript/src/generated/spec.ts`
holds the run-time values: `API_VERSION`, `CLIENT_KEY_HEADER`, `DEFS` (every named shape, with
`#/components/schemas/X` rewritten to `#/$defs/X`, the form a JSON Schema validator resolves),
`UNKNOWN_CODES`, `ERROR_BODY` and `OPERATIONS`, the table of calls (method, path, auth, answer schema,
and for a call with one shape per read, `outputs`). `typescript/src/generated/tools.ts` holds `TOOLS`, the published MCP
tool list. `typescript/llms.txt` lists the same calls and error codes as text, for readers and language models. All
four start with a "do not edit" header.

**4. The client: `typescript/src/`.** Every file outside `typescript/src/generated/` is written by hand. `typescript/src/index.ts` is the
package's main entry: `createClient` walks `OPERATIONS` and makes one method per call, so a call added to the
document becomes a method with no edit here. `typescript/src/mcp.ts` is the `@temporalabs/client/mcp` entry, and
`typescript/src/mcpClient.ts` makes the same calls over the API's MCP endpoint. Both share `typescript/src/internal.ts`: the option
checks, sending a request (the timeout and the refused redirects), the answer checks and the reading of an
error. Each builds its own headers, and the HTTP client also checks that every call stays on `baseUrl`'s
origin. `typescript/src/signIn.ts` is the owner sign-in, and
`typescript/src/check.ts` and `typescript/src/checkPortfolio.ts` are the checks before signing. The
types come from `Operations` through `InputOf` and `OutputOf`; `status_lookup` is typed with `OneOf`, so
exactly one lookup key type-checks. What a call does at run time is in [One call traced](one-call-traced.md).

**5. The build: `typescript/scripts/build.mjs`.** esbuild bundles each entry, `typescript/src/index.ts` and `typescript/src/mcp.ts`, into
one ES module of its own, with `zod` left external (it is the one runtime dependency). The declarations are emitted by `tsc` and bundled by
`rollup-plugin-dts`, rather than inferred again, so the order of union members is stable. Last, the
TypeScript printer rewrites both files without comments: notes in the source are for this repository,
not for callers.

**6. The package.** `files` in `typescript/package.json` names what is packed. `typescript/scripts/client-pack.mjs`:

- builds and packs twice and requires the same integrity hash;
- requires exactly the files in `ALLOWED`;
- runs the public-text scan over the unpacked tarball;
- refuses a comment in the built files and any `@temporalabs/` dependency;
- then installs the tarball into an empty project and type-checks a file that uses it. That file includes a
  line marked `@ts-expect-error` that must fail to compile, which proves the published types are real and
  not `any`.

## The checks, and the drift each one stops

| Check (`npm run ...`) | Fails when |
|---|---|
| `check:source` | `spec/openapi.json` or `spec/tools.json` is not the copy `spec/SOURCE` describes |
| `check:generated` | a file in `typescript/src/generated/` or `typescript/llms.txt` differs from what the generator writes from the document: a hand edit, or a document copied in without regenerating |
| `typecheck` | the hand-written client, the tests or the scripts no longer type-check against the generated types |
| `test` | behaviour changed: `typescript/tests/generate.test.ts` covers the document, the fail-closed cases, the printed types and the checks themselves; `typescript/tests/client.test.ts` covers requests, credentials, outcomes and answer checks; `typescript/tests/mcp.test.ts` the MCP client; `typescript/tests/signIn.test.ts`, `typescript/tests/check.test.ts` and `typescript/tests/checkPortfolio.test.ts` the sign-in and the checks before signing; `typescript/tests/scan.test.ts` the public-text scanner |
| `check:public-text` | a tracked file contains text on the deny list in `scripts/public-text/deny.json` |
| `check:client-pack` | the package holds an unexpected file, builds differently twice, or does not install and type-check |

`npm run check`, in `typescript/`, runs them all in that order. CI runs the same steps:
`.github/workflows/ci-typescript.yml` the package's, and `.github/workflows/ci-repo.yml` the ones that cover the
whole repository, which also checks each package's `LICENSE` and `NOTICE` copies and scans every commit message
with the public-text scanner.

## Changing the client: which layer?

| You want to | Change | Then |
|---|---|---|
| take a newer API | `spec/openapi.json` and `spec/SOURCE`, from the API's release | `npm run generate`, commit the generated files with them |
| support a schema keyword the generator rejects | `typescript/scripts/generate.ts`, with a test | `npm run generate` |
| change what a call does on the wire | `typescript/src/index.ts` or `typescript/src/internal.ts` (and `typescript/src/mcpClient.ts` for the MCP endpoint), with a test in `typescript/tests/client.test.ts` or `typescript/tests/mcp.test.ts` | update the usage doc the change makes wrong |
| fix a wrong answer shape | nothing here: it is fixed in the API, then taken as a newer copy | |
