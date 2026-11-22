# Tempora API clients

**The typed clients for the Tempora API, in TypeScript and Python.** Built by Tempora Labs and contributors.

[![ci typescript](https://github.com/TemporaLabs/client-sdk/actions/workflows/ci-typescript.yml/badge.svg?branch=main)](https://github.com/TemporaLabs/client-sdk/actions/workflows/ci-typescript.yml)
[![ci python](https://github.com/TemporaLabs/client-sdk/actions/workflows/ci-python.yml/badge.svg?branch=main)](https://github.com/TemporaLabs/client-sdk/actions/workflows/ci-python.yml)

The clients let an application read Tempora Labs' products, sign a wallet owner in, and take that owner's deposits
and withdrawals into its vaults and portfolios, over the API's HTTP routes or its MCP endpoint.

> **Pre-1.0.** A minor version (`0.2.0`) may change a client's interface; see [versioning](docs/versioning.md).
> Deposits and withdrawals move real funds: check every step before the owner signs it.

## Install

| | TypeScript | Python |
|---|---|---|
| Package | `@temporalabs/client` | `temporalabs-client` (imported as `temporalabs_client`) |
| Needs | Node.js 26 or later; an ES module | Python 3.14 or later |
| Runtime dependencies | `zod`; no install scripts | `httpx`, `pydantic` |
| Published to | npm | this repository, at a release tag (not on PyPI) |
| Package guide | [typescript/README.md](typescript/README.md) | [python/README.md](python/README.md) |

Pin an exact version in both languages.

### TypeScript

```bash
npm install --save-exact @temporalabs/client@0.2.0
```

The package has two entry points: `@temporalabs/client` for the HTTP API and `@temporalabs/client/mcp` for the MCP
endpoint. Check the install:

```bash
node -e "import('@temporalabs/client').then((m) => console.log(m.API_VERSION))"   # prints 0.2.0
```

### Python

Install from this repository at the release tag. With pip:

```bash
pip install "temporalabs-client @ git+https://github.com/TemporaLabs/client-sdk.git@v0.2.0#subdirectory=python"
```

With uv:

```bash
uv add "temporalabs-client @ git+https://github.com/TemporaLabs/client-sdk.git@v0.2.0#subdirectory=python"
```

In a `requirements.txt`, or under `dependencies` in a `pyproject.toml`, use the same quoted string. Keep the
`@v0.2.0` tag: without it, pip installs whatever `main` holds at the time. The MCP client is in
`temporalabs_client.mcp`. Check the install:

```bash
python -c "import temporalabs_client as t; print(t.__version__, t.API_VERSION)"     # prints 0.2.0 0.2.0
```

## Quick start

### Configure

- **API address:** `https://api.temporalabs.com`. The MCP endpoint is `https://api.temporalabs.com/mcp`.
- **Client key:** Tempora Labs issues one to each business it works with. Pass it as `clientKey` (TypeScript) or
  `client_key` (Python), read from the environment, for example `TEMPORALABS_CLIENT_KEY`. Keep it on a server.
- **No client key:** a wallet owner's own application leaves the key out. Product reads need no sign-in; owner
  calls need an owner token from [sign-in](docs/sign-in.md).

### Make a first call

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

### Go further

1. [Getting started](docs/getting-started.md): every client option, the product reads, and the Python spelling of
   each TypeScript call.
2. [Sign-in](docs/sign-in.md): get an owner token from the owner's wallet signature.
3. [Requests and steps](docs/requests-and-steps.md): deposits and withdrawals, and the checks to run before the
   owner signs.

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
- **The client never signs.** A deposit or a withdrawal comes back as steps for the owner's own wallet. The checks
  before signing compare each step's bytes with what the owner asked for. They may refuse what the API would allow,
  never the reverse: a chain the API does not serve (`SERVED_CHAINS`), a mixed-case address with a wrong EIP-55
  checksum, and calldata that is not lower-case hex are all refused.

## Documentation

| Guide | Read it for |
|---|---|
| [Getting started](docs/getting-started.md) | Creating a client, the product reads, Python next to TypeScript |
| [Sign-in](docs/sign-in.md) | Owner tokens, with or without a client key, over HTTP and MCP |
| [Requests and steps](docs/requests-and-steps.md) | Deposits and withdrawals, and checking each step before it is signed |
| [Errors](docs/errors.md) | Every error code, its outcome, and what to do next |
| [Versioning](docs/versioning.md) | Which API version each client release speaks, and what may change |
| [How the clients are made](docs/how-it-is-made.md) | The generators, the hand-written parts, and how they fit |
| [One call traced](docs/one-call-traced.md) | One call followed from your code to the answer and back |
| [Changelog](CHANGELOG.md) | What changed in each release |

## The repository

| Folder | Holds |
|---|---|
| `spec/` | The API document and tool list, and `spec/SOURCE`, their API version and sha256 |
| `typescript/` | The npm package: its generator, hand-written client, tests and build |
| `python/` | The Python package: its generator, hand-written client and tests |
| `cases/` | Test fixtures both packages read |
| `scripts/` | Checks that cover the whole repository: the document's source, the license copies, the public-text scan |

## Contributing

You need Node.js 26 or later (`typescript/.nvmrc` names it), Python 3.14 or later and git. The tests make no network calls
and need no key.

```bash
git clone https://github.com/TemporaLabs/client-sdk.git && cd client-sdk
(cd typescript && npm ci && npm run check)
(cd python && python3.14 -m venv .venv && . .venv/bin/activate && python -m pip install ".[dev]" \
  && ruff check . && ruff format --check . && mypy src tests && python scripts/generate.py --check && pytest)
node scripts/check-copies.mjs
```

Never edit a `generated/` folder by hand: after a change to `spec/`, run `npm run generate` in `typescript/` and
`python scripts/generate.py` in `python/`. The Python tests import the installed package, so reinstall
(`pip install .`) after a change under `python/src/`. Sign off every commit (`git commit -s`).
[CONTRIBUTING.md](CONTRIBUTING.md) has the rest.

## Security

Report a vulnerability privately, as [SECURITY.md](SECURITY.md) says, not in a public issue.

## License

[Apache-2.0](LICENSE). Keep [LICENSE](LICENSE) and [NOTICE](NOTICE) when redistributing. The license does not grant
rights to Tempora Labs' names ("Tempora" and "Tempora Labs", as NOTICE lists them).
