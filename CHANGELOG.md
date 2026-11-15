# Changelog

All notable changes to `@temporalabs/client` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added

- `vault.shareSymbol` on a vault product: the vault's share ticker, as the API returns it.
- `depositAssets` on a product: the tokens it takes for a deposit, each with its chain, address and decimals.
- A product can be named by its id, its share ticker, its vault address, or that address with its chain
  (`eip155:<chain>:<address>`), wherever a call takes a product (`ProductRef`), and in the MCP `product` tool.

### Changed

- **The client needs Node.js 22 or later** (`engines.node` is `>=22`, was `>=20.3`). Node.js 20 is past its end
  of life. The built files are unchanged.
- The package is built and type-checked with TypeScript 6.0.3, and its tests with `@types/node` 22.20.5. The
  built files are byte-identical to the TypeScript 7 build.
- `spec/` is the API 0.1.2 document as released. The copy 0.1.0 shipped with was taken before the API's
  0.1.2 release and lacked the three additions above.
- `vault.shareSymbol` is required, as the API document says, so this client reads an answer from an API
  older than 0.1.2 that carries a vault product as `unreadable_answer` (`product`, `products`). Use it with an
  API at 0.1.2 or later.
- The repository holds one folder per language. The npm package moved to `typescript/`; the API document
  (`spec/`) and shared test fixtures (`cases/`) stay at the root. The published files are unchanged apart from
  `package.json` (`repository.directory`, script paths) and two README links that now point into `typescript/`.

## [v0.1.0] - 2026-11-15

The first public release of `@temporalabs/client`, the typed client for the Tempora API 0.1.2. Published to npm
as `@temporalabs/client` (see [Getting started](docs/getting-started.md#install)).

### Added

- **One package, generated from the API's own documents.** Its types, its answer checks, its MCP tool list and
  `llms.txt` are generated from a copy of the Tempora API 0.1.2 OpenAPI document (`spec/openapi.json`) and its MCP
  tool list (`spec/tools.json`), whose API version and sha256 are recorded in `spec/SOURCE`. `API_VERSION` exports
  the API version it was generated from, and `CLIENT_KEY_HEADER` the client-key header's name.
- **`createClient`:** one method per call. Every call returns a `Result` and never throws for an API or network
  problem: `{ ok: true, status, body, traceId? }` or `{ ok: false, status, error, traceId? }`. `error.outcome` is
  `refused`, `failed` or `unknown`, and an error may carry `retryAfter`, in seconds.
- **`@temporalabs/client/mcp`:** `createMcpClient`, the same calls and results over the API's MCP endpoint; `TOOLS` and
  `RELEASED`, the API's published tool list; `toolBreaks`, the additions-only rule for a pinned list.
- **Every answer is checked** against the document's schema before it is returned, each error body included. An
  answer that does not match is the error `unreadable_answer`. Answers may carry fields added later: a field the
  client does not know is left on the body, and open lists (request and step states, gate ids, error codes, step
  kinds) also accept any string.
- **Credentials go only to the configured origin.** Each call checks that its final URL is on the origin of `baseUrl`
  before any header is attached; if not, nothing is sent and the call answers `wrong_origin`. Redirects are never
  followed, a path value of `.` or `..` is `invalid_path_value`, and the owner token is sent only on owner calls.
  `createClient` and `createMcpClient` throw a `TypeError` for a plain `http` address to a host other than this machine
  (`localhost`, `127.0.0.1`, `[::1]`), and for a `clientKey` that is empty or only spaces.
- **A client key is optional.** Left out, no `Tempora-Client-Key` header is sent, and the caller is a wallet owner
  using their own application ([sign-in without a client key](docs/sign-in.md#without-a-client-key)).
- **`signIn`:** the owner sign-in as one call (challenge, the owner signs, verify). An optional `check` can refuse
  the challenge before anything is signed, and an `audience` (`http`, `mcp` or `both`) names where the token works.
  **`withOwnerRetry`** signs in once more and repeats an owner call once when the answer is `wallet_proof_required`,
  and never otherwise. Neither takes a wallet library or stores a token.
- **Checks before signing.** `checkStep` and `checkSteps` decode a vault's steps. They refuse any that is not exactly an
  approval of the vault for the deposit's amount, the deposit, or the withdrawal the owner asked for, paying the owner,
  on the vault's chain, with no value. `checkPortfolioWithdrawal` and `checkPortfolioDeposit` do the same for a
  portfolio's steps. None of them calls the network or signs.
- **Timeouts and cancelling.** `timeoutMs` (30 seconds by default) bounds each call, and each call takes an optional
  `signal`. A write (every write is a `POST`) whose answer is lost or unreadable may have gone through, so its outcome
  is `unknown`; a read that ends the same way is `failed`.
- **`llms.txt`**: every call, its input and who may make it, and the error codes, generated from the document.
- **Docs:** [Getting started](docs/getting-started.md), [Sign-in](docs/sign-in.md),
  [Requests and steps](docs/requests-and-steps.md), [Errors](docs/errors.md), [Versioning](docs/versioning.md) and
  the guides to [how the client is made](docs/how-it-is-made.md) and [one call traced](docs/one-call-traced.md).
- **Checks:** `npm run check` runs the source check, the generation check, the typecheck, the tests, the public-text
  scan and the package check.
