# Errors

A call that does not succeed resolves to `{ ok: false, status, error, traceId? }`. It never throws for an
API or network problem. Every `error` has:

| Field | What it holds |
|---|---|
| `code` | What went wrong, as a string. The known codes are listed below; a newer API may send others. |
| `message` | A human-readable explanation. |
| `outcome` | `refused`, `failed` or `unknown`: whether anything happened. |
| optional | `traceId`, `gates` (see [Gates](requests-and-steps.md#gates)), `requestId`, `submissionId`. |

`status` is the HTTP status of the answer, or `0` when the client sent nothing, got no answer, or got a
redirect.

## The outcome decides what you do next

| `outcome` | What happened | What to do |
|---|---|---|
| `refused` | Nothing happened. The API said no to this call as it was. | Do not send it again unchanged. Read `code`, `message` and any `gates`, and change the input or meet the gate first. The exception is `rate_limited` (below): the same call may succeed after the wait. |
| `failed` | Nothing happened. | It is safe to try again later. |
| `unknown` | It may have happened: a write may have gone through. | **Never send the write again.** Read the request's state with `status` or `status_lookup` and continue from there. If there is no request to read (a sign-in call, or a `deposit` that returned no `requestId`), see below. |

Branch on `outcome` first, and on `code` for detail. A code you do not know still comes with an outcome
you can act on.

```ts
import { createClient } from '@temporalabs/client'

// Reads an environment variable and fails when it is unset (defined in Getting started).
declare function requireEnv(name: string): string
declare const token: string
const client = createClient({ baseUrl: 'https://<api origin>', clientKey: requireEnv('TEMPORALABS_CLIENT_KEY'), ownerToken: token })

const r = await client.withdraw({ body: { product: 'example-product', amount: { kind: 'all' } } })
if (!r.ok) {
  switch (r.error.outcome) {
    case 'refused':
      console.error('refused:', r.error.code, r.error.message, r.error.gates)
      break
    case 'failed':
      console.error('nothing happened; try again later:', r.error.code)
      break
    case 'unknown':
      // Do not send the withdrawal again. Find out what happened first.
      if (r.error.requestId) {
        const s = await client.status({ path: { requestId: r.error.requestId } })
        if (s.ok) console.log('the request is', s.body.state)
      }
      break
  }
}
```

## Codes that are always `unknown`

`upstream_in_progress`, `upstream_unavailable`, `upstream_timeout` and `upstream_unreadable` may hide a
request that moved, so the API always sends them with outcome `unknown`. The API document lists them in
`x-unknown-codes`. If an answer pairs one of them with any other outcome, the client does not pass it on:
it reports `unreadable_answer` instead.

## The client's own codes

Some errors come from the client, not the API:

| `code` | When | `outcome` | `status` |
|---|---|---|---|
| `network_error` | No answer arrived: the network failed, the call timed out (`timeoutMs`; a timeout after the answer has started arriving reads as `unreadable_answer`), your `signal` aborted it, or the API answered with a redirect, which the client never follows. A call's own `ownerToken` that is not a valid header value (a line break, a control character) is not sent at all, and that call is `failed` whatever its method. | `unknown` on a write (`POST`), `failed` on a read (`GET`) | `0` |
| `unreadable_answer` | An answer arrived but did not match the API document's schema, or an error body could not be read. | `unknown` on a write, `failed` on a read | the answer's status |
| `wrong_origin` | The call's URL would have left `baseUrl`'s origin. Nothing was sent. | `failed` | `0` |
| `invalid_path_value` | A path value was missing, empty, not a string, `.` or `..`, or could not be written into a URL. Nothing was sent. | `failed` | `0` |
| `challenge_refused` | `signIn`'s `check` refused the challenge. Nothing was signed. | `failed` | `0` |
| `signing_failed` | The owner did not sign the challenge. Nothing was verified. | `failed` | `0` |
| `unsupported_token_type` | The API issued a token that is not a Bearer token, the only kind the client sends. | `failed` | `0` |
| `callback_failed` | A function given to `withOwnerRetry` threw. | `unknown` when the call itself threw (it may have been sent), `failed` otherwise | `0` |
| `unsupported_protocol` | The MCP endpoint no longer serves this client's protocol revision. Upgrade the package. | `failed` | the answer's status |

`wrong_origin` and `invalid_path_value` will happen again with the same input: fix the configuration or
the value rather than retrying.

The writes are `deposit`, `withdraw`, `submit`, `cancel`, `sign_in_challenge`, `sign_in_verify` and
`sign_out`. `quote` is sent as a `POST`, so a lost answer reads as `unknown`, but it moves nothing: ask again.
Every other call is a read.

## Rate limits

For `rate_limited`, wait before trying again. When the API says how long, the result carries `retryAfter`,
in whole seconds (at most one day), read from its `Retry-After` header. If the error's `gates` carry a `satisfy` of kind
`wait` with an `until`, wait until then.

## What is safe to try again

- **A read** (`products`, `product`, `product_read`, `products_route`, `account`, `account_performance`,
  `positions`, `status`, `status_lookup`): reading changes nothing, so it is safe to call again.
- **A write with outcome `failed`**: nothing happened; try again later.
- **A write with outcome `refused`**: change something first. The same call will be refused again.
- **A write with outcome `unknown`**: do not send it again. Read the request with `status` (by
  `requestId`, which the error may carry) or `status_lookup` (by `nonce`, `txHash` or `operationId`).
  - For a sign-in call, start sign-in again from a new challenge. A challenge is used once, so nothing is
    repeated.
  - For a `deposit` that returned no `requestId` and carried no `sent`, nothing has moved. Funds move only
    when your wallet sends a step and you submit it, so you can start the deposit again.
  - A `deposit` that carried `sent` reports a transfer your wallet already made. Look it up with
    `status_lookup` by that `txHash` before starting again.

## Every code in the API document

`invalid_input`, `invalid_wallet_view`, `invalid_nonce`, `unauthenticated`, `wallet_proof_required`,
`challenge_invalid`, `challenge_other_site`, `signed_by_other_wallet`, `signature_not_owner`,
`unknown_origin`, `gate_failed`, `not_invited`, `unknown_product`, `not_found`, `no_account`,
`already_enrolled`, `account_updating`, `transfer_claimed`, `upstream_refused`, `authorization_rejected`,
`authorization_other_account`, `pays_someone_else`, `transfer_mismatch`, `nothing_to_withdraw`,
`request_expired`, `rate_limited`, `enrolment_check_failed`, `internal_error`, `upstream_in_progress`,
`upstream_unavailable`, `upstream_unreadable`, `unexpected_answer`, `unknown_agent`, `live_key_missing`,
`upstream_not_sent`, `reasoning_unreadable`, `upstream_timeout`, `not_permitted`.

The document does not describe each code or say which calls return it. Three need a note:

- `upstream_not_sent` means nothing was sent, so try again (outcome `failed`).
- `transfer_mismatch` means the transfer did not land as confirmed (outcome `refused`, and the request is
  kept).
- A `not_found` for an `operationId` means none was found just now, not that the withdrawal is gone.
