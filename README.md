# Tempora API clients

**The typed clients for the Tempora API, in TypeScript and Python.** Built by Tempora Labs and contributors.

[![ci typescript](https://github.com/TemporaLabs/client-sdk/actions/workflows/ci-typescript.yml/badge.svg?branch=main)](https://github.com/TemporaLabs/client-sdk/actions/workflows/ci-typescript.yml)
[![ci python](https://github.com/TemporaLabs/client-sdk/actions/workflows/ci-python.yml/badge.svg?branch=main)](https://github.com/TemporaLabs/client-sdk/actions/workflows/ci-python.yml)

The clients let an application read Tempora Labs' products, sign a wallet owner in, and take that owner's deposits
and withdrawals into its vaults and portfolios, over the API's HTTP routes or its MCP endpoint.

| Package | Install | Read |
|---|---|---|
| `@temporalabs/client` (TypeScript, Node.js 22 or later) | `npm install @temporalabs/client` | [typescript/README.md](typescript/README.md) |
| `temporalabs-client` (Python 3.11 or later) | from this repository at a release tag: see [python/README.md](python/README.md#install) | [python/README.md](python/README.md) |

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
