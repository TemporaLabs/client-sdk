# Working in this repository

`@temporalabs/client`: the typed client for the Tempora API. The npm package is `typescript/` (source in
`typescript/src/`); `spec/` at the root is the API document it is generated from, and `cases/` holds shared test
fixtures. This file points;
the docs and the code explain.
This repository is public: every byte you add, commit messages included, is public text.

## Start here

1. [How the client is made](docs/how-it-is-made.md), from the API document to the published package, then
   [one call traced](docs/one-call-traced.md).
2. The usage doc for the area you touch: [errors](docs/errors.md), [sign-in](docs/sign-in.md),
   [requests and steps](docs/requests-and-steps.md), [versioning](docs/versioning.md).

## Where authority lives

Copy no fact from prose. Read it from its source.

| Fact | Its source |
|---|---|
| Every call, its method, path, auth, inputs and answer shape | `spec/openapi.json`, a copy of the API's own document |
| Which API version that copy is, and its sha256 | `spec/SOURCE` (checked by `scripts/check-source.mjs`) |
| The MCP tools the API publishes | `spec/tools.json`, a copy of the API's tool list, with its sha256 as `tools-sha256` in `spec/SOURCE` |
| The generated types, answer schemas, `API_VERSION`, `CLIENT_KEY_HEADER`, the always-`unknown` codes | `typescript/src/generated/types.ts` and `typescript/src/generated/spec.ts`, written by `typescript/scripts/generate.ts`; never edited by hand |
| The list of calls and error codes for readers and LLMs | `typescript/llms.txt`, also generated |
| Which JSON Schema keywords the generator accepts | `TYPE_KEYWORDS` and `NARROWING` in `typescript/scripts/generate.ts` |
| Request behaviour: the origin check, headers, timeout, the outcome of a lost answer | `typescript/src/index.ts` (HTTP) and `typescript/src/mcpClient.ts` (MCP), over `typescript/src/internal.ts`, which both share |
| The default timeout and the trace header name | constants in `typescript/src/internal.ts` |
| What the published package may contain | `ALLOWED` in `typescript/scripts/client-pack.mjs`, and `files` in `typescript/package.json` |
| Text that must never appear in a file or commit message | `scripts/public-text/deny.json` |
| Node versions | `typescript/.nvmrc` for tooling, `engines` in `typescript/package.json` for the client |
| What CI runs | `.github/workflows/ci-repo.yml` (the whole repository) and `.github/workflows/ci-typescript.yml` (the npm package), and the `check` script in `typescript/package.json` |

## Binding rules

Each of these fails a check or breaks a caller when ignored.

1. **Generated, never hand-edited.** `typescript/src/generated/` and `typescript/llms.txt` come from `npm run generate`.
   `npm run check:generated` fails on any difference. See [the pipeline](docs/how-it-is-made.md).
2. **The API document is a copy, refreshed only at an API release**, with `spec/SOURCE` updated in the
   same change (`npm run check:source`). A wrong or missing shape is fixed in the API, never here.
3. **The generator fails closed.** A document it does not understand is an error, never a partial client.
   Teach it the new keyword, with a test in `typescript/tests/generate.test.ts`.
4. **The contract is additive within an API version.** Answers may gain fields and open lists may gain
   values; the client must keep tolerating both. See [Versioning](docs/versioning.md).
5. **Credentials stay on the configured origin.** The off-origin check and the dot-segment refusal in
   `typescript/src/index.ts`, and `redirect: 'error'` in `send` in `typescript/src/internal.ts`, are security boundaries, and the
   owner token is sent only on owner calls (and, over MCP, on the tool list). See
   [one call traced](docs/one-call-traced.md).
6. **A lost or unreadable answer to a POST is `unknown`, never `failed`.** Every write is a POST, and the
   generator refuses any other write method so that this rule stays true. See [Errors](docs/errors.md).
7. **Never throw for an API or network problem.** Every call resolves to a `Result`.
8. **The client never signs and never holds a wallet key.** It carries the client key and an owner token;
   signatures come from the owner's own wallet and are passed in. See [Sign-in](docs/sign-in.md).
9. **Public text.** No internal names, private paths, issue or pull-request references, or process notes
   in files, commit messages or pull request text. `npm run check:public-text` scans the files; CI also
   scans every commit message.
10. **Checks:** `npm run check` in `typescript/`, tests with one worker (`npm test` already passes `--maxWorkers=1`).

## When a doc is wrong

The code wins. Fix the doc in its own docs-only pull request into the current `release/vX.Y.Z` branch.
