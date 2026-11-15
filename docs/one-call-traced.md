# One call traced

A worked example: a server withdraws everything an owner holds in one product.

```ts
const client = createClient({ baseUrl: 'https://api.example', clientKey: 'ck', ownerToken: 'tok' })
const r = await client.withdraw({ body: { product: 'example-product', amount: { kind: 'all' } } })
```

Everything below happens in `typescript/src/index.ts`, with the helpers it shares with the MCP client in `typescript/src/internal.ts`
(the answer check, the origin refusal, the option checks), using values from `typescript/src/generated/spec.ts`.

## 1. Compile time: the input is checked against the document

`client.withdraw` exists because `withdraw` is a key of `Operations` in `typescript/src/generated/types.ts`. Its
input type is `InputOf<'withdraw'>`: the call takes no path and no query, and its body is required, so the
input is exactly `{ body: WithdrawBody }`. `amount: { kind: 'everything' }` would not compile, because
`Amount` is a union of the five amount shapes the document names. The answer type is
`Result<OutputOf<'withdraw'>>`, a `Result` around the `Request` shape.

## 2. The method

`createClient` made `withdraw` by calling `call(opts, 'withdraw', OPERATIONS.withdraw)`. The table entry
is the generated `{ method: 'POST', path: '/v1/withdrawals', auth: 'owner', response: { $ref: '#/$defs/Request' } }`.

## 3. Before anything is sent

Each of these returns a `Result` with `status: 0` and sends nothing:

1. **Dot segments.** A path value of `.` or `..`, even percent-encoded, would move a URL to another route
   on the same origin, so it is `invalid_path_value`. `withdraw` has no path values; `status` and `submit`
   do.
2. **The URL.** The path template is filled with each value through `encodeURIComponent`, then resolved
   against `baseUrl`. The template is absolute, so any path in `baseUrl` is dropped. Query values are set
   one by one, and an `undefined` one is left out.
3. **The origin.** If the final URL's origin is not `baseUrl`'s, the call is `wrong_origin`. This runs
   before any header exists, so the client key cannot leave the configured origin.

## 4. The request

The headers are:

- `accept: application/json`;
- the client key, when one is given, under `CLIENT_KEY_HEADER` (a generated constant, read from the
  document's `clientKey` scheme);
- `authorization: Bearer <token>`, because `auth` is `owner`, using the call's own `ownerToken` first and
  then the client's.

A body adds `content-type: application/json`.

The signal is `AbortSignal.timeout(timeoutMs)`, joined with the caller's own `signal` through
`AbortSignal.any` when one is given. `redirect: 'error'` makes `fetch` fail on a redirect instead of
following it, because a followed redirect would carry the client key to wherever it points.

## 5. No answer

If `fetch` throws (the network failed, the timeout or the caller's signal fired, or a redirect arrived),
the call is `network_error`. Its outcome comes from the method: `withdraw` is a POST, a write that may
have reached the API, so the outcome is `unknown` and the caller must read the request's status before
trying again. A GET that ends the same way is `failed`, since a read changed nothing. This one rule is why
the generator refuses any write method other than POST.

## 6. An answer

The `x-trace-id` header becomes `traceId`. The body is parsed as JSON; a body that is not JSON (or is cut
off by the timeout) becomes `undefined` and fails the check below.

**A 2xx answer** is checked against the call's answer schema. `validator` turns the schema into a zod
validator with `z.fromJSONSchema`, passing the generated `DEFS` as `$defs` so every `$ref` resolves, and
caches it per schema, so each is built once. A match is `{ ok: true, status, body, traceId }`. A
mismatch is `unreadable_answer`, with the same method rule as step 5: `unknown` here.

`product_read` is the one call with a shape per read. Its `outputs` map is looked up by the `read` path
value, as the map's own key only (`Object.hasOwn`), so `constructor` or a read the document does not list
has no schema and is `unreadable_answer`.

**Any other status** is checked against `ERROR_BODY`. A readable error is passed on as the API sent it,
with one more rule from the document: a code in `UNKNOWN_CODES` must come with outcome `unknown`. Any other
pairing, or an error body that does not match, is `unreadable_answer`.

## What the caller gets

Every path above ends in a `Result`; none throws. Configuration is checked earlier: `createClient` throws a
`TypeError` for a `baseUrl` that is not an absolute URL, so a client that was made never throws on a call.

The tests that pin each step are in `typescript/tests/client.test.ts`: the URL and headers, the owner token, the
answer checks, `product_read`, the outcome rule, the origin, path values and redirects.
