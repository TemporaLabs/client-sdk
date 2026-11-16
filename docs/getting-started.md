# Getting started

The examples in these guides are TypeScript. The Python client makes the same calls with the same results; its
quick start is [below](#in-python).

## Install

```sh
npm install --save-exact @temporalabs/client@0.1.2
```

The client needs Node.js 22 or later (`engines` in `typescript/package.json`) and is an ES module. It has one runtime
dependency, `zod`, which npm installs with it, and no install scripts. Pin an exact version: before `1.0.0`
a minor version may change the client's interface (see [Versioning](versioning.md#version-numbers)).

## Create a client

```ts
import { createClient } from '@temporalabs/client'

// Fails loudly when the variable is unset or blank, so a server meant to send its key never runs without one.
function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value?.trim()) throw new Error(`${name} is not set`)
  return value
}

const client = createClient({
  baseUrl: 'https://<api origin>',
  clientKey: requireEnv('TEMPORALABS_CLIENT_KEY'),
})
```

| Option | Required | What it is |
|---|---|---|
| `baseUrl` | yes | The API's origin. The call paths are absolute and already carry `/v1`, so any path in `baseUrl` is dropped. |
| `clientKey` | no | Your client key, if you have one. Tempora Labs issues client keys to the businesses it works with. Sent on every call in the `Tempora-Client-Key` header (exported as `CLIENT_KEY_HEADER`). Left out, no such header is sent: the caller is a wallet owner using their own application ([sign-in without a client key](sign-in.md#without-a-client-key)). |
| `ownerToken` | no | An owner token from [sign-in](sign-in.md). Sent on owner calls unless a call passes its own. |
| `timeoutMs` | no | How long a call waits for an answer. Default 30000. |
| `fetch` | no | The `fetch` to use, for tests or a custom agent. Default: the global `fetch`. |

`createClient` checks its options once and throws a `TypeError` for a bad one:

- a `baseUrl` that is not an absolute `https` URL (plain `http` only for this machine: `localhost`, `127.0.0.1` or
  `[::1]`), or one that carries a user name or password;
- a `timeoutMs` that is not a whole, positive number of milliseconds;
- a `clientKey` that is empty or only spaces, or an `ownerToken` that is empty;
- a `clientKey` or `ownerToken` with a line break or another control character (a tab is allowed).

A client that was made never throws on a call.

An unset key is not an error to the client. `clientKey: process.env.TEMPORALABS_CLIENT_KEY` with the variable missing
makes a client with no key, which the API treats as a wallet owner's own application. A server that should always send
its key reads it with a check that fails when it is unset, as `requireEnv` above does. The examples in these guides use
it.

### The client key stays on your server

The client key is a server-side secret. Call the API from your server, never from a browser, and never
ship the key in front-end code. If your app has a browser front end, it talks to your server, and your
server holds the client and the key.

### Credentials go only to `baseUrl`'s origin

Before any header is attached, each call checks that its final URL is on the origin of `baseUrl`. If it
is not, nothing is sent and the call answers `wrong_origin` (outcome `failed`, status `0`). Redirects are
never followed, so a redirect cannot carry the client key elsewhere. A call answered with a redirect
ends as `network_error` (outcome `unknown` on a write, `failed` on a read). A path value of `.` or `..` is
refused the same way, as `invalid_path_value`.

## Every call returns a `Result`

A call never throws for an API or network problem. It resolves to a `Result`:

```ts
type Result<T> =
  | { ok: true; status: number; body: T; traceId?: string }
  | { ok: false; status: number; error: ApiError; traceId?: string; retryAfter?: number }
```

Check `ok`, then read `body` or `error`:

```ts
import { createClient } from '@temporalabs/client'

const client = createClient({ baseUrl: 'https://<api origin>', clientKey: requireEnv('TEMPORALABS_CLIENT_KEY') })

const r = await client.products({})
if (r.ok) {
  for (const p of r.body.products) console.log(p.id, p.status, p.minimum?.firstDepositUsd)
} else {
  console.error(r.error.code, r.error.outcome, r.traceId)
}
```

Every answer is checked against the API document's schema before you see it. An answer that does not
match is not passed through; it becomes the error `unreadable_answer`. `error.outcome` tells you whether
anything happened; see [Errors](errors.md).

`traceId` is the answer's `x-trace-id` header, when the API sent one. An error body may also carry its own
`error.traceId`. Keep them with your logs.

## Timeouts and cancelling a call

A call that gets no answer within `timeoutMs` ends with `network_error`. If the time runs out after the
answer started but while its body is still being read, the call ends with `unreadable_answer` and the
real status. You can also pass your own `AbortSignal` per call; aborting it ends the call the same way.

```ts
import { createClient } from '@temporalabs/client'

const client = createClient({ baseUrl: 'https://<api origin>', clientKey: requireEnv('TEMPORALABS_CLIENT_KEY'), timeoutMs: 10_000 })

const controller = new AbortController()
const r = await client.product({ path: { id: 'example-product' } }, { signal: controller.signal })
if (!r.ok && r.error.code === 'network_error') console.error('no answer', r.error.outcome)
```

A write (a `POST`) that ends without an answer may still have reached the API, so its outcome is
`unknown`; a read that ends without an answer is `failed`. See [Errors](errors.md).

## Public reads

`products`, `product`, `product_read` and `products_route` need no owner token (the client key is still
sent):

```ts
import { createClient } from '@temporalabs/client'

const client = createClient({ baseUrl: 'https://<api origin>', clientKey: requireEnv('TEMPORALABS_CLIENT_KEY') })

const product = await client.product({ path: { id: 'example-product' } })
if (product.ok) console.log(product.body.name, product.body.amountForms.deposit)

// One read of a product: tvl, market, tickers, reasoning or nav. tvl, market and tickers may be null.
const nav = await client.product_read({ path: { id: 'example-product', read: 'nav' } })
if (nav.ok && nav.body !== null && 'navUsd' in nav.body) console.log(nav.body.navUsd, nav.body.asOf)

// Which product an amount on a chain would go to; productId is null when none.
const route = await client.products_route({ query: { amount: '250', chain: 'eip155:56' } })
if (route.ok) console.log(route.body.productId, route.body.reason)
```

Each `product_read` answer is checked against the shape of the read you asked for. Its TypeScript type is
the union of all reads, so narrow it before use, as above.

Owner calls (`account`, `account_performance`, `positions`, and everything in
[Requests and steps](requests-and-steps.md)) need an owner token: see [Sign-in](sign-in.md).

## In Python

```sh
pip install "temporalabs-client @ git+https://github.com/TemporaLabs/client-sdk.git@v0.1.2#subdirectory=python"
```

It installs from this repository at a release tag; it is not on PyPI. Pin the tag, as above.

It needs Python 3.13; its runtime dependencies are `httpx` and `pydantic`. The client is synchronous.

```python
import os

from temporalabs_client import Ok, create_client


def require_env(name: str) -> str:
    """Fails loudly when the variable is unset or blank, so a server meant to send its key never runs without one."""
    value = os.environ.get(name, "")
    if not value.strip():
        raise RuntimeError(f"{name} is not set")
    return value


client = create_client("https://<api origin>", client_key=require_env("TEMPORALABS_CLIENT_KEY"), timeout_s=10)

r = client.products()
if isinstance(r, Ok):
    for p in r.body.products:
        print(p.id, p.status)
else:
    print(r.error.code, r.error.outcome, r.trace_id)

product = client.product(path={"id": "example-product"})
nav = client.product_read(path={"id": "example-product", "read": "nav"})
route = client.products_route(query={"amount": "250", "chain": "eip155:56"})
```

What differs from TypeScript is spelling, not behaviour:

| TypeScript | Python |
|---|---|
| `createClient({ baseUrl, clientKey, ownerToken, timeoutMs, fetch })` | `create_client(base_url, client_key=, owner_token=, timeout_s=, http=)`, where `http` is an `httpx.Client` |
| `client.product({ path: { id } }, { ownerToken })` | `client.product(path={"id": ...}, owner_token=...)` |
| `{ ok: true, status, body, traceId? }` | `Ok(status, body, trace_id)` |
| `{ ok: false, status, error, traceId?, retryAfter? }` | `Err(status, error, trace_id, retry_after)` |
| a `TypeError` from `createClient` | a `ValueError` (a bad value) or `TypeError` (a value of the wrong type) from `create_client` |
| `signIn`, `withOwnerRetry`, `checkSteps`, `checkPortfolioDeposit` | `sign_in`, `with_owner_retry`, `check_steps`, `check_portfolio_deposit` |
| `@temporalabs/client/mcp`: `createMcpClient`, `toolBreaks`, `listTools()` | `temporalabs_client.mcp`: `create_mcp_client`, `tool_breaks`, `list_tools()` |

An answer is a pydantic model with the API's own field names (`r.body.expiresAt`); the fields the API adds later
are in `model_extra`. A call has no `AbortSignal`: it ends at `timeout_s`, which bounds the whole call, body
included. Everything else on this page, the origin check, the refused redirects and the outcome of a lost
answer, holds as written.
