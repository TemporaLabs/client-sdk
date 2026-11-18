# Tempora API client

**The typed TypeScript client for the Tempora API.** Built by Tempora Labs and contributors.

[![ci](https://github.com/TemporaLabs/client-sdk/actions/workflows/ci-typescript.yml/badge.svg?branch=main)](https://github.com/TemporaLabs/client-sdk/actions/workflows/ci-typescript.yml)

`@temporalabs/client` lets an application read Tempora Labs' products, sign a wallet owner in, and take that
owner's deposits and withdrawals into its vaults and portfolios. It is generated from the API's own OpenAPI
document, so every call, input and answer is typed. Every call returns a result instead of throwing, and every
answer is checked against the API's schema before your code sees it.

**The client never signs; the owner's wallet does.** A deposit or a withdrawal comes back as steps for the
owner's wallet to sign or send. Before they reach the wallet, the client can check each step against what the
owner asked for. Your code then hands the signed result back.

> **Pre-1.0.** A minor version (`0.2.0`) may change the client's interface; see [versioning](https://github.com/TemporaLabs/client-sdk/blob/main/docs/versioning.md).
> Deposits and withdrawals move real funds: check every step before the owner signs it.

## Who it is for

- **A business's server, with a client key.** It calls the API for its users. The client key is a server-side
  secret: call the API from a server, never from a browser.
- **A wallet owner's own application, with no client key.** For example, a command-line tool on their own
  machine. The owner signs in with their wallet and acts for themselves.
- **A program that acts for a signed-in owner over MCP.** `@temporalabs/client/mcp` makes the same calls through
  the API's MCP endpoint, so an agent can use them without ever seeing the owner's token.

## Install

```bash
npm install --save-exact @temporalabs/client@0.1.3
```

Pin the exact version: before `1.0.0` a minor version may change the interface.

It needs Node.js 22 or later and is an ES module: load it with `import` (`require()` works only on Node.js versions that can load ES modules). It has one runtime dependency (zod) and no install scripts.
More in [Getting started](https://github.com/TemporaLabs/client-sdk/blob/main/docs/getting-started.md).

## A first call

```ts
import { createClient } from '@temporalabs/client'

// `requireEnv` fails when the variable is unset: see Getting started.
const client = createClient({ baseUrl: 'https://<api origin>', clientKey: requireEnv('TEMPORALABS_CLIENT_KEY') })
const r = await client.products({})
if (r.ok) console.log(r.body)
else console.error(r.error.code, r.error.outcome)
```

A call resolves to `{ ok: true, status, body }` or `{ ok: false, status, error }`, with the API's `traceId`
when it sent one. On an error, `error.outcome` says what happened:

- `refused` or `failed`: nothing happened.
- `unknown`: a write may have gone through, so check its status before trying again.

A bad option, such as a `baseUrl` that is not an absolute URL, throws a `TypeError` from `createClient`, so no
call throws for it. Reads of products (`products`, `product`, `product_read`, `products_route`) need no owner
token. Every call, its input and the error codes are listed in [`llms.txt`](https://github.com/TemporaLabs/client-sdk/blob/main/typescript/llms.txt).

## Sign in an owner

`signIn(client, { owner, signMessage, check })` runs the challenge, the owner's signature and the verify call,
and returns an owner token. `check` sees the challenge text before anything is signed, so you can refuse one
that does not name your site, this owner and an expiry minutes away. `withOwnerRetry` signs in again and
repeats a call once, and only once, when the token is refused as `wallet_proof_required`. Neither one takes a
wallet library or stores the token. See [Sign-in](https://github.com/TemporaLabs/client-sdk/blob/main/docs/sign-in.md).

## Deposits and withdrawals

`deposit` and `withdraw` answer with a request that lists its steps. Check the steps before the owner signs:

- `checkSteps` for a vault;
- `checkPortfolioDeposit` and `checkPortfolioWithdrawal` for a portfolio.

Each check reads every step's own bytes and refuses anything that is not exactly what the owner asked for. None
of them calls the network or signs. The owner's wallet signs or sends each step, `submit` hands it back, and
`status` follows the request. See [Requests and steps](https://github.com/TemporaLabs/client-sdk/blob/main/docs/requests-and-steps.md).

## The MCP version

```ts
import { createClient, signIn } from '@temporalabs/client'
import { createMcpClient } from '@temporalabs/client/mcp'

// Sign in over HTTP, with a token made for the MCP endpoint.
const client = createClient({ baseUrl: 'https://api.temporalabs.com' })
const signedIn = await signIn(client, { owner, signMessage, audience: 'mcp' })
if (signedIn.ok) {
  const tempora = createMcpClient({ url: 'https://api.temporalabs.com/mcp', ownerToken: signedIn.body.token })
  const r = await tempora.positions({})
}
```

- **Same calls:** the same names, inputs and results as `createClient`, except sign-in and sign-out, which are not
  MCP tools: sign in with `createClient` and hand the token over. Each call is one POST in the MCP
  2026-07-28 protocol, so no MCP library is needed.
- **The token:** it must be made for the MCP endpoint, with `signIn(client, { ..., audience: 'mcp' })`, or
  `'both'` when one process also calls the HTTP API.
- **A newer endpoint:** if the endpoint no longer serves this client's protocol revision, it answers
  `unsupported_protocol`. Upgrade the package.
- **Pinning the tools:** `TOOLS` is the API's published tool list and `RELEASED` the same list with its
  version. `toolBreaks(released, current)` lists what a newer list changed that a pinned consumer would
  notice: a tool or input removed, an input made required, an output schema dropped, a changed exposure. It does not
  compare a field's type, an enum's members or an output schema's content, so pin those with your own tests.

## Security

- **Credentials stay on your origin.** The client key and the owner token go only to the origin of `baseUrl`.
  Redirects are refused. A call whose URL would leave that origin sends nothing and answers `wrong_origin`.
- **The owner token** is sent only on owner calls, and over MCP on the tool list too. Over MCP it travels in a header, never in a tool's arguments.
- **Every answer is checked** against the API's schema. An answer that does not match is the error
  `unreadable_answer`, never a throw.
- **A small supply chain:** one runtime dependency and no install scripts.
- **The client-key header's name** is exported as `CLIENT_KEY_HEADER`. A build check that proves the key never
  reaches a browser bundle can import it (`import { CLIENT_KEY_HEADER } from '@temporalabs/client'`) and search
  the bundle for that name.
- **Private vulnerability reporting:** follow [SECURITY.md](https://github.com/TemporaLabs/client-sdk/blob/main/SECURITY.md), not a public issue.

## What the answer checks cover

Every answer is checked against the document's JSON Schemas: shapes, required fields, types, enums, patterns
and nullability. A check the API makes in code, and that a JSON Schema cannot carry, is named in the document
when the client needs it. `x-unknown-codes` lists the error codes whose outcome is always `unknown`, and any
other outcome for them is `unreadable_answer`.

Three consistency checks the API makes on its own answers are not repeated here:

- a market-hours gate's `until`;
- a batch's index below its count;
- the step kinds a newer API may add.

## Compatibility

`API_VERSION` names the Tempora API version the client was generated from; this release speaks API `0.1.5`.
Within an API version the API only adds: new optional inputs, new answer fields, new calls. The client keeps
answer fields it does not know yet. See [versioning](https://github.com/TemporaLabs/client-sdk/blob/main/docs/versioning.md).

## Documentation

- [Getting started](https://github.com/TemporaLabs/client-sdk/blob/main/docs/getting-started.md) · [Sign-in](https://github.com/TemporaLabs/client-sdk/blob/main/docs/sign-in.md) · [Requests and steps](https://github.com/TemporaLabs/client-sdk/blob/main/docs/requests-and-steps.md)
- [Errors](https://github.com/TemporaLabs/client-sdk/blob/main/docs/errors.md) · [Versioning](https://github.com/TemporaLabs/client-sdk/blob/main/docs/versioning.md) · [Changelog](https://github.com/TemporaLabs/client-sdk/blob/main/CHANGELOG.md)
- [How it is made](https://github.com/TemporaLabs/client-sdk/blob/main/docs/how-it-is-made.md) and [One call traced](https://github.com/TemporaLabs/client-sdk/blob/main/docs/one-call-traced.md): how the client is made
  from the API document, and one call end to end

## Contributing

Feedback and pull requests are welcome. Most of the client is generated from the API document. See
[CONTRIBUTING.md](https://github.com/TemporaLabs/client-sdk/blob/main/CONTRIBUTING.md) for how it is made and what `npm run check` runs before a pull request.

## License

[Apache-2.0](https://github.com/TemporaLabs/client-sdk/blob/main/LICENSE). Keep [LICENSE](https://github.com/TemporaLabs/client-sdk/blob/main/LICENSE) and [NOTICE](https://github.com/TemporaLabs/client-sdk/blob/main/NOTICE) when redistributing. The license does not
grant rights to Tempora Labs' names ("Tempora" and "Tempora Labs", as NOTICE lists them).
