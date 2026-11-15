# Tempora API clients

**The typed clients for the Tempora API, in TypeScript and Python.** Built by Tempora Labs and contributors.

[![ci typescript](https://github.com/TemporaLabs/client-sdk/actions/workflows/ci-typescript.yml/badge.svg?branch=main)](https://github.com/TemporaLabs/client-sdk/actions/workflows/ci-typescript.yml)
[![ci python](https://github.com/TemporaLabs/client-sdk/actions/workflows/ci-python.yml/badge.svg?branch=main)](https://github.com/TemporaLabs/client-sdk/actions/workflows/ci-python.yml)

The clients let an application read Tempora Labs' products, sign a wallet owner in, and take that owner's deposits
and withdrawals into its vaults and portfolios, over the API's HTTP routes or its MCP endpoint.

| Package | Install | Read |
|---|---|---|
| `@temporalabs/client` (TypeScript, Node.js 22 or later) | `npm install @temporalabs/client` | [typescript/README.md](typescript/README.md) |
| `temporalabs-client` (Python 3.13) | from this repository at a release tag: see [python/README.md](python/README.md#install) | [python/README.md](python/README.md) |

> **Pre-1.0.** A minor version (`0.2.0`) may change a client's interface; see [versioning](docs/versioning.md).
> Deposits and withdrawals move real funds: check every step before the owner signs it.

## What both clients promise

- **Generated from the API's own document.** `spec/openapi.json` is a copy of the Tempora API's OpenAPI document, and
  `spec/tools.json` of its MCP tool list. Each package's generator reads them and fails on anything it does not
  understand, so a client never ships with a check silently missing.
- **Every call returns a result.** No call throws or raises for an API or network problem. An error says whether
  anything happened: `refused` or `failed` (nothing did) or `unknown` (a write may have gone through).
- **Every answer is checked** against the API's schema before your code sees it. One that does not match is the
  error `unreadable_answer`. Both clients judge every answer alike: `cases/answers.json` holds answers to accept and
  to refuse for every shape and every call, and both test suites read it.
- **Credentials stay on the configured origin.** Redirects are refused, a call whose URL would leave the origin
  sends nothing, and the owner token goes only on owner calls.
- **The client never signs.** A deposit or a withdrawal comes back as steps for the owner's own wallet; the checks
  before signing compare each step's bytes with what the owner asked for.

## Setup

### Using a client

1. **Prerequisites.** TypeScript: Node.js 22 or later. Python: Python 3.13.
2. **Install.**

   ```bash
   npm install @temporalabs/client
   ```

   ```bash
   pip install "temporalabs-client @ git+https://github.com/TemporaLabs/client-sdk.git@v0.1.1#subdirectory=python"
   ```

   The Python package installs from this repository at a release tag; it is not on PyPI. Pin the tag.
3. **Configure.**
   - **API address:** `https://api.temporalabs.com`, and its MCP endpoint at `https://api.temporalabs.com/mcp`.
   - **Client key:** businesses Tempora Labs works with get one and pass it as `clientKey` / `client_key`, read
     from the environment (for example `TEMPORALABS_CLIENT_KEY`). Keep it on a server.
   - **Without a client key:** a wallet owner's own application leaves the key out. Product reads need no
     sign-in; owner calls need an owner token from [sign-in](docs/sign-in.md).
4. **Run** a first call:

   ```ts
   import { createClient } from '@temporalabs/client'

   const client = createClient({ baseUrl: 'https://api.temporalabs.com' })
   const r = await client.products({})
   if (r.ok) console.log(r.body.products.map((p) => p.id))
   else console.error(r.error.code, r.error.outcome)
   ```

   ```python
   from temporalabs_client import Ok, create_client

   client = create_client("https://api.temporalabs.com")
   r = client.products()
   print([p.id for p in r.body.products] if isinstance(r, Ok) else (r.error.code, r.error.outcome))
   ```

   [Getting started](docs/getting-started.md) goes on from here.

### Contributing

1. **Prerequisites.** Node.js 22 (the version in `typescript/.nvmrc`; the scripts need 22.6 or later), Python 3.13 and
   git. Tool versions are pinned in `typescript/package.json` and `python/pyproject.toml`.
2. **Install.**

   ```bash
   git clone https://github.com/TemporaLabs/client-sdk.git && cd client-sdk
   (cd typescript && npm ci)
   (cd python && python3.13 -m venv .venv && . .venv/bin/activate && python -m pip install ".[dev]")
   ```

3. **Configure.** Nothing to configure. The tests make no network calls and need no key.
4. **Run.** Regenerate a client after `spec/` changes: `npm run generate` in `typescript/`, and
   `python scripts/generate.py` in `python/`. Never edit `generated/` by hand.
5. **Test.**

   ```bash
   (cd typescript && npm run check)
   (cd python && . .venv/bin/activate && ruff check . && ruff format --check . && mypy src tests \
     && python scripts/generate.py --check && pytest)
   node scripts/check-copies.mjs
   ```

   `npm run check` covers the TypeScript checks, tests, generated code, package build and public-text scan. In
   Python, reinstall (`pip install .`) after a change under `src/`, since the tests import the installed package.
   Every commit is signed off (`git commit -s`); see [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

- [Getting started](docs/getting-started.md) · [Sign-in](docs/sign-in.md) · [Requests and steps](docs/requests-and-steps.md)
- [Errors](docs/errors.md) · [Versioning](docs/versioning.md) · [Changelog](CHANGELOG.md)
- [How the clients are made](docs/how-it-is-made.md) and [One call traced](docs/one-call-traced.md)

## The repository

| Folder | Holds |
|---|---|
| `spec/` | The API document and tool list, and `spec/SOURCE`, their API version and sha256 |
| `typescript/` | The npm package: its generator, hand-written client, tests and build |
| `python/` | The Python package: its generator, hand-written client and tests |
| `cases/` | Test fixtures both packages read |
| `scripts/` | Checks that cover the whole repository: the document's source, the license copies, the public-text scan |

## Security and contributing

Report a vulnerability privately, as [SECURITY.md](SECURITY.md) says, not in a public issue. Feedback and pull
requests are welcome: [CONTRIBUTING.md](CONTRIBUTING.md) says how the clients are made and what to run first.

## License

[Apache-2.0](LICENSE). Keep [LICENSE](LICENSE) and [NOTICE](NOTICE) when redistributing. The license does not grant
rights to Tempora Labs' names ("Tempora" and "Tempora Labs", as NOTICE lists them).
