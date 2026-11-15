# Development

The technologies and techniques this repository uses. Versions live in `typescript/package.json`,
`typescript/package-lock.json` and `python/pyproject.toml`; this page names what each one is for.

## Technologies

| Area | TypeScript package (`typescript/`) | Python package (`python/`) |
|---|---|---|
| Language and runtime | TypeScript 6 on Node.js 22 | Python 3.13 |
| Runtime dependencies | zod 4 (answer schemas from JSON Schema) | httpx (HTTP), pydantic 2 (answer models) |
| Code generation | `scripts/generate.ts`, run with Node's type stripping | `scripts/generate.py` |
| Build | esbuild (JavaScript), rollup with rollup-plugin-dts (one bundled `.d.ts`) | setuptools, `build` (wheel) |
| Tests | Jest 30 with SWC | pytest |
| Static checks | `tsc` (strict) | ruff (lint and format), mypy (strict) |
| Supply chain | exact pins, a lockfile, Dependabot | exact dev pins, Dependabot, pip-audit |
| Protocols | HTTP+JSON per the API's OpenAPI document; MCP (JSON-RPC over HTTP) | the same |

CI runs on GitHub Actions, with every third-party action pinned by commit SHA.

## Techniques

- **Clients generated from the API's OpenAPI document**, with generators that fail closed: an unknown keyword,
  pattern or format is an error, never a skipped check.
- **One test fixture for two languages.** `cases/answers.json` lists answers to accept and refuse for every shape,
  and both test suites read it, so the two validators cannot drift apart.
- **Results, not exceptions.** Every call returns `Ok` or `Err`, and an error's outcome says whether a write may
  have happened (`unknown`) or not (`refused`, `failed`).
- **Origin pinning.** Credentials go only to the configured origin. Redirects are refused, and a URL that would
  leave the origin sends nothing.
- **Pre-signing checks.** Each prepared step's calldata is decoded and compared with what the owner asked for
  before a wallet signs it. The client holds no key.
- **Reproducible packaging.** The npm tarball is built twice and compared byte for byte, then installed and
  type-checked in a clean project. The wheel is installed and imported from outside the repository.
- **Mutation-tested guards.** A new check comes with a case that fails when the check is removed.
- **Public-text scanning** of every tracked file and commit message.
- **DCO sign-offs**, checked from git on every pull request, with GitHub-signed dependency-bot commits verified
  against GitHub's published signing key.
