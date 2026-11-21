# Contributing

Thanks for considering a contribution. These clients are licensed under the Apache License, Version 2.0
(see [`LICENSE`](LICENSE)). Tempora Labs reviews every change and decides what merges.

## How the clients are made

Most of each client is generated. `spec/openapi.json` is a copy of the Tempora API's own OpenAPI
document, taken at a release, and `spec/SOURCE` records its API version and sha256.
`npm run generate`, run in `typescript/`, writes `typescript/src/generated/` and `typescript/llms.txt` from it, and
`python scripts/generate.py`, run in `python/`, writes `python/src/generated/`. Never edit those by hand: CI
regenerates them and fails on any difference.

A change to what the API accepts or returns is a change to the API, not to this repository. A change
here is to a hand-written client (every file in `typescript/src/` or `python/src/` outside its `generated/`), or to
a generator, `typescript/scripts/generate.ts` or `python/scripts/generate.py`. [How the clients are
made](docs/how-it-is-made.md) shows how the parts fit together, and [One call traced](docs/one-call-traced.md)
follows one call end to end.

## Before you open a pull request

Work with the Node.js version in `typescript/.nvmrc` (26). The generator and checks run TypeScript directly with
`--experimental-strip-types`. The `engines` range in `typescript/package.json` (26 or later) is for the published client.

`npm run check`, run in `typescript/`, must pass. It runs the source and generation checks, the typecheck, the
tests (one worker), the public-text scan, the package check, and that each package folder's `LICENSE` and
`NOTICE` match the root's. Add a test for any behaviour you change.

For the Python package, work in `python/` with Python 3.14, in a virtual environment:

```sh
python -m venv .venv && . .venv/bin/activate
python -m pip install ".[dev]"          # the package and the pinned tools
ruff check . && ruff format --check .
mypy src tests
python scripts/generate.py --check     # python scripts/generate.py rewrites src/generated/
pytest
```

The tests run against the installed package, so install it again (`pip install .`) after a change under `src/`.
A change to how either client checks answers needs the same change in the other, and a case in
`cases/answers.json` that both test suites read. The Python generator reads the same `spec/` as the TypeScript one
and refuses the same documents.

## Sign off every commit

Every commit needs a `Signed-off-by` trailer (`git commit -s`) that names its author. It certifies the
[Developer Certificate of Origin](DCO.md): that you wrote the change, or have the right to submit it under
this repository's license. A check on every pull request refuses a commit without one. A merge commit that
only merges is exempt; one that resolves a conflict or adds changes of its own needs a sign-off too
(`git commit -s`, or `git merge --signoff`). A commit the dependency bot made on GitHub is exempt when GitHub's
signature on it verifies against GitHub's published signing key; its author and committer fields alone exempt
nothing.
