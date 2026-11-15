# Working in this repository

The typed clients for the Tempora API, one folder per language: `typescript/` is the npm package
`@temporalabs/client` (source in `typescript/src/`) and `python/` the Python package `temporalabs-client` (source in
`python/src/`, imported as `temporalabs_client`). `spec/` at the root is the API document both are generated from,
and `cases/` holds test fixtures both read. This file points; the docs and the code explain.
This repository is public: every byte you add, commit messages included, is public text.

## Start here

1. [How the clients are made](docs/how-it-is-made.md), from the API document to the published packages, then
   [one call traced](docs/one-call-traced.md).
2. [Development](docs/DEVELOPMENT.md): the technologies and techniques in use.
3. The usage doc for the area you touch: [errors](docs/errors.md), [sign-in](docs/sign-in.md),
   [requests and steps](docs/requests-and-steps.md), [versioning](docs/versioning.md).

## Where authority lives

Copy no fact from prose. Read it from its source.

| Fact | Its source |
|---|---|
| Every call, its method, path, auth, inputs and answer shape | `spec/openapi.json`, a copy of the API's own document |
| Which API version that copy is, and its sha256 | `spec/SOURCE` (checked by `scripts/check-source.mjs`) |
| The MCP tools the API publishes | `spec/tools.json`, a copy of the API's tool list, with its sha256 as `tools-sha256` in `spec/SOURCE` |
| The generated types, answer schemas, `API_VERSION`, `CLIENT_KEY_HEADER`, the always-`unknown` codes | `typescript/src/generated/types.ts` and `typescript/src/generated/spec.ts`, written by `typescript/scripts/generate.ts`; `python/src/generated/models.py`, `spec.py` and `operations.py`, written by `python/scripts/generate.py`; never edited by hand |
| The list of calls and error codes for readers and LLMs | `typescript/llms.txt`, also generated |
| Which JSON Schema keywords the generators accept | `TYPE_KEYWORDS` and `NARROWING` in `typescript/scripts/generate.ts`; the same sets in `python/scripts/generate.py`, which also refuses a pattern or format it cannot check the way the TypeScript client does |
| How the Python answer checks match the TypeScript ones, keyword by keyword | `python/src/_schema.py` |
| The answers both clients must judge alike | `cases/answers.json`, read by `typescript/tests/answers.test.ts` and `python/tests/test_answers.py` |
| Request behaviour: the origin check, headers, timeout, the outcome of a lost answer | `typescript/src/index.ts` (HTTP) and `typescript/src/mcpClient.ts` (MCP), over `typescript/src/internal.ts`, which both share; in Python, `python/src/client.py` and `python/src/mcp_client.py` over `python/src/_internal.py` |
| The default timeout and the trace header name | constants in `typescript/src/internal.ts` and `python/src/_internal.py` |
| What the published package may contain | `ALLOWED` in `typescript/scripts/client-pack.mjs`, and `files` in `typescript/package.json`; `[tool.setuptools]` in `python/pyproject.toml` |
| Python versions and dependencies | `requires-python`, `dependencies` and the pinned `dev` tools in `python/pyproject.toml` |
| Text that must never appear in a file or commit message | `scripts/public-text/deny.json` |
| Node versions | `typescript/.nvmrc` for tooling, `engines` in `typescript/package.json` for the client |
| The TypeScript compiler, test runner and other tool versions | `devDependencies` in `typescript/package.json`, each pinned exactly, and `typescript/package-lock.json` |
| Which commits need a sign-off, and which are exempt | `.github/scripts/dco-check.sh` and its test `.github/scripts/dco-check.test.sh`; the signing key it trusts for the dependency bot's commits is `.github/keys/github-web-flow.asc` |
| Where dependency-update pull requests go | `.github/workflows/dependabot-to-cycle-branch.yml` (onto the current `release/vX.Y.Z` branch) and `.github/dependabot.yml` |
| What CI runs | `.github/workflows/ci-repo.yml` (the whole repository), `.github/workflows/ci-typescript.yml` (the npm package), `.github/workflows/ci-python.yml` (the Python package) and `.github/workflows/dco.yml` (sign-offs), and the `check` script in `typescript/package.json` |
| How a release is published | `.github/workflows/publish.yml`, run by hand from a release tag; nothing publishes on a merge |

## Binding rules

Each of these fails a check or breaks a caller when ignored.

1. **Generated, never hand-edited.** `typescript/src/generated/` and `typescript/llms.txt` come from `npm run generate`,
   and `python/src/generated/` from `python scripts/generate.py`. `npm run check:generated` and
   `python scripts/generate.py --check` fail on any difference. See [the pipeline](docs/how-it-is-made.md).
2. **The API document is a copy, refreshed only at an API release**, with `spec/SOURCE` updated in the
   same change (`npm run check:source`), and both packages regenerated from it. A wrong or missing shape is fixed in
   the API, never here.
3. **The generator fails closed.** A document it does not understand is an error, never a partial client.
   Teach both generators the new keyword, with a test in `typescript/tests/generate.test.ts` and
   `python/tests/test_generate.py`.
4. **The contract is additive within an API version.** Answers may gain fields and open lists may gain
   values; the client must keep tolerating both. See [Versioning](docs/versioning.md).
5. **Both clients judge every answer alike.** A change to what one accepts changes `cases/answers.json`, and the other
   client in the same change.
6. **Credentials stay on the configured origin.** The off-origin check and the dot-segment refusal in
   `typescript/src/index.ts` and `python/src/client.py`, and the refused redirects in `send` in
   `typescript/src/internal.ts` and `python/src/_internal.py`, are security boundaries, and the owner token is sent only
   on owner calls (and, over MCP, on the tool list). See [one call traced](docs/one-call-traced.md).
7. **A lost or unreadable answer to a POST is `unknown`, never `failed`.** Every write is a POST, and the
   generator refuses any other write method so that this rule stays true. See [Errors](docs/errors.md).
8. **Never throw or raise for an API or network problem.** Every call resolves to a `Result`. A bad option fails
   when the client is made, never on a call.
9. **The client never signs and never holds a wallet key.** It carries the client key and an owner token;
   signatures come from the owner's own wallet and are passed in. See [Sign-in](docs/sign-in.md).
10. **Public text.** No internal names, private paths, issue or pull-request references, or process notes
   in files, commit messages or pull request text. `npm run check:public-text` scans the files; CI also
   scans every commit message.
11. **Every commit is signed off** (`git commit -s`), as [CONTRIBUTING.md](CONTRIBUTING.md) says. The DCO check runs
    on `pull_request_target`, so it always uses the checker on `main`, not the pull request's copy.
12. **Checks:** `npm run check` in `typescript/`, tests with one worker (`npm test` already passes `--maxWorkers=1`).
    In `python/`: `ruff check . && ruff format --check .`, `mypy src tests`, `python scripts/generate.py --check` and
    `pytest` (one process). At the root: `node scripts/check-copies.mjs`.

## Reviewing a pull request

Check the change against its sources above, then these, each of which a reviewer is expected to catch:

- Generated files changed only by their generator, with `spec/SOURCE` updated when `spec/` changed.
- A change to what one client accepts or sends is made in the other client in the same pull request, with
  `cases/answers.json` updated and both suites reading it.
- No call can throw or raise for an API or network problem, and a lost answer to a POST is `unknown`.
- Credentials cannot leave the configured origin, and the owner token goes only where rule 6 says.
- New tests can fail: each guard has a case that fails without it.
- Pinned versions stay exact, and the CHANGELOG's `Unreleased` section names any change a caller can see.
- Nothing internal in files, commit messages or the pull request text (rule 10).

## When a doc is wrong

The code wins. Fix the doc in its own docs-only pull request into the current `release/vX.Y.Z` branch.
