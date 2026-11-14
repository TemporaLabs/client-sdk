# Contributing

Thanks for considering a contribution. This client is licensed under the Apache License, Version 2.0
(see [`LICENSE`](LICENSE)). Tempora Labs reviews every change and decides what merges.

## How the client is made

Most of the client is generated. `spec/openapi.json` is a copy of the Tempora API's own OpenAPI
document, taken at a release, and `spec/SOURCE` records its API version and sha256.
`npm run generate` writes `src/generated/` and `llms.txt` from it. Never edit those by hand: CI
regenerates them and fails on any difference.

A change to what the API accepts or returns is a change to the API, not to this repository. A change
here is to the hand-written client in `src/` (every file outside `src/generated/`), or to the generator,
`scripts/generate.ts`. [How the client is made](docs/how-it-is-made.md) shows how the two fit together, and
[One call traced](docs/one-call-traced.md) follows one call end to end.

## Before you open a pull request

Work with the Node.js version in `.nvmrc` (22). The generator and checks need Node.js 22.6 or later, since they
run TypeScript directly with `--experimental-strip-types`. The `engines` range in `package.json` (20.3 or later) is
for the published client, not for these scripts.

`npm run check` must pass. It runs the source and generation checks, the typecheck, the tests (one
worker), the public-text scan and the package check. Add a test for any behaviour you change.

## Sign off every commit

Every commit needs a `Signed-off-by` trailer (`git commit -s`) that names its author. It certifies the
[Developer Certificate of Origin](DCO.md): that you wrote the change, or have the right to submit it under
this repository's license. A check on every pull request refuses a commit without one. A merge commit that
only merges is exempt; one that resolves a conflict or adds changes of its own needs a sign-off too
(`git commit -s`, or `git merge --signoff`).
