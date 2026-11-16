# Changelog

All notable changes to `@temporalabs/client` and `temporalabs-client` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [v0.1.2] - 2026-11-16

### Added

- **Generated from API 0.1.4** (`API_VERSION` is `0.1.4`). New in the types and the tool list:
  - `fee` on a `send_transaction` step: the API's gas and fee estimate, advisory and outside the payload;
  - `gas: 'self'` on `deposit` and `withdraw` bodies, and the `gas-funds` gate, whose refusal
    (`insufficient_gas_funds`) carries `funds`;
  - `bundle` on a vault deposit with an approval: its steps as one EIP-5792 `wallet_sendCalls` batch, and the
    submit body `{ kind: 'bundle', id, status }`;
  - `basis` and `earnedUsd` on a position.
- **`checkBundle`** (`check_bundle` in Python) checks a vault deposit's `bundle` before it goes to the wallet: the
  steps must pass `checkSteps`, and the batch must be exactly those steps, byte for byte and in order, from the owner,
  on the vault's chain, all-or-nothing, with no field beyond the API's own. `cases/vault-bundle.json` holds the cases
  both clients must admit or refuse alike, with the same reason.

### Changed

- **The step checks are never looser than the API.** `checkStep`, `checkSteps`, `checkPortfolioDeposit` and
  `checkPortfolioWithdrawal` (and the Python `check_*` functions) now refuse:
  - a vault or portfolio on a chain the API does not serve. The served chains are exported as `SERVED_CHAINS`;
  - calldata that is not lower-case hex;
  - a mixed-case address whose EIP-55 checksum is wrong. All lower case and all upper case are still admitted.
- `SERVED_CHAINS` is frozen in TypeScript, so it cannot be widened at run time, a cast included; in Python it was
  already a tuple.
- `PAYLOAD_FIELDS` is read-only in both clients (frozen in TypeScript, each list too; a read-only mapping in
  Python), and so is the MCP client's protocol metadata. Python's `served_chain` reads the served chains bound at
  import, so rebinding the module's `SERVED_CHAINS` does not widen it.
- `cases/vault-steps.json` holds one-step deposits that both clients must admit or refuse alike.
- The README's install section gives the exact pinned install for both languages, including `uv add` for Python,
  and a one-line check that the install worked.

## [v0.1.1] - 2026-11-15

### Added

- **`temporalabs-client`, the Python client** (`python/`, imported as `temporalabs_client`), generated from the same
  `spec/` as the TypeScript client by its own generator, `python/scripts/generate.py`, which refuses the same
  documents. It makes the same calls with the same results: `create_client` and, in `temporalabs_client.mcp`,
  `create_mcp_client`, `tool_breaks`, `TOOLS` and `RELEASED`; `sign_in` and `with_owner_retry`; `check_step`,
  `check_steps`, `check_portfolio_deposit` and `check_portfolio_withdrawal`. Every call returns `Ok` or `Err` and
  never raises for an API or network problem; answers are pydantic models with the API's own field names. It needs
  Python 3.13 and depends on `httpx` and `pydantic` 2.14. It installs from this repository at a
  release tag; it is not on PyPI.
- **One verdict for both clients:** `cases/answers.json` lists answers to accept and to refuse for every named shape,
  every call and every product read, and the error each error body reads as. The test suites of both clients read
  it, so the two cannot drift apart on what they accept.
- `vault.shareSymbol` on a vault product: the vault's share ticker, as the API returns it.
- `depositAssets` on a product: the tokens it takes for a deposit, each with its chain, address and decimals.
- A product can be named by its id, its share ticker, its vault address, or that address with its chain
  (`eip155:<chain>:<address>`), wherever a call takes a product (`ProductRef`), and in the MCP `product` tool.
- **`next` on every request answer** (`deposit`, `withdraw`, `status`, `status_lookup`, `submit`, `cancel`): what to
  do now, one of `send`, `sign`, `sign_again`, `hand_back`, `wait`, `done`, `failed`, `cancelled` or `expired`, each
  with its own fields. A kind a newer API adds still reads, with `kind` as a plain string.
- `broadcast` on a step: what the wallet said of an attempt handed back without a hash (`unknown` or `declined`).
- `deposit.approval` on a quote: whether the deposit would first ask the wallet to approve, and for exactly how
  much, or null when the allowance could not be read.
- **`chains`**, the call and the MCP tool (`GET /v1/chains`): every chain a product is on, with its CAIP-2 id, short
  name, display name and block explorer.
- An amount to deposit, withdraw or quote can be given as a decimal `value` in the token's units (`100.5`) instead
  of `raw` (`AmountInput`). Amounts in answers also carry `value`, the same amount as a decimal string, for display.

### Changed

- **The MCP client names itself by its own package and version.** `clientInfo` was the npm package name with the
  API version; it is now each package's own name and version (`@temporalabs/client` or `temporalabs-client`, and
  `0.1.1`).
- **An MCP call never throws for what it was given.** An input that is not an object (`null`, a string), or a `path`
  or `query` that is not one, is read as empty instead of raising, and a string is never spread into the tool's
  arguments.
- **The client needs Node.js 22 or later** (`engines.node` is `>=22`, was `>=20.3`). Node.js 20 is past its end
  of life. The built files are unchanged.
- The package is built and type-checked with TypeScript 6.0.3, and its tests with `@types/node` 22.20.5. The
  built files are byte-identical to the TypeScript 7 build.
- `spec/` is the API 0.1.3 document as released, and `API_VERSION` is `0.1.3`.
- `vault.shareSymbol`, a request's `next` and a quote's `deposit.approval` are required, as the API document says,
  so this client reads such an answer from an API older than 0.1.3 as `unreadable_answer`. Use it with an API at
  0.1.3 or later.
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
