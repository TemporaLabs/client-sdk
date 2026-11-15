# Getting started

## Install

```sh
npm install @temporalabs/client
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
