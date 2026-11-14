# Sign-in

Owner calls act for one wallet owner. They need an owner token, which the owner gets by signing a
challenge with their own wallet. Your server runs the two sign-in calls with its client key. An owner's own
application runs them with no key ([below](#without-a-client-key)). Only the signature comes from the owner's
wallet. The owner's private key never reaches your server or the API.

## The short way

`signIn` runs the three steps below for you. You give it the owner and a function that has the owner sign the
message; it returns the token. It never throws: a refusal at any step is an error result, as for every call.

```ts
import { createClient, signIn, withOwnerRetry } from '@temporalabs/client'

// Your own code that has the owner sign a message in their wallet, and returns the signature.
declare function askOwnerToSign(owner: string, message: string): Promise<string>
// Reads an environment variable and fails when it is unset (defined in Getting started).
declare function requireEnv(name: string): string

const client = createClient({ baseUrl: 'https://<api origin>', clientKey: requireEnv('TEMPORALABS_CLIENT_KEY') })
const owner = '0x1111111111111111111111111111111111111111'
const SITE = 'https://app.example.com'
const options = {
  owner,
  origin: SITE,
  signMessage: (message: string) => askOwnerToSign(owner, message),
  // Called with the challenge text before anything is signed. Return true to go on; anything else, or a throw, refuses it. Check it against
  // what you expect, never against values read from the challenge itself: your site, this owner, an expiry minutes away.
  check: (message: string) => {
    const lines = message.split('\n')
    // Read the fields only from the block after the last blank line, so a statement line cannot pose as one.
    const fields = lines.slice(lines.lastIndexOf('') + 1)
    const field = (key: string) => fields.find((l) => l.startsWith(`${key}: `))?.slice(key.length + 2)
    const expires = Date.parse(field('Expiration Time') ?? '')
    return lines[0] === `${new URL(SITE).host} wants you to sign in with your Ethereum account:`
      && lines[1]?.toLowerCase() === owner.toLowerCase()
      && field('URI') === SITE
      && expires > Date.now() && expires - Date.now() <= 10 * 60_000
  },
}

const signedIn = await signIn(client, options)
if (!signedIn.ok) throw new Error(`${signedIn.error.code}: ${signedIn.error.message}`)
let token = signedIn.body.token

// An owner call that signs in once more, and repeats once, when the token is refused with `wallet_proof_required`.
const positions = await withOwnerRetry(
  { token, signIn: () => signIn(client, options), onSignIn: (s) => { token = s.token } },
  (t) => client.positions({}, { ownerToken: t }),
)
```

- `signIn` returns a `Result` whose `body` is `{ token, tokenType, expiresAt }`. A token whose type is not `Bearer` is refused, because the client
  only sends Bearer tokens.
- The errors it adds itself are `challenge_refused` (your `check` said no; nothing was signed), `signing_failed` (the
  owner did not sign; nothing was verified) and `unsupported_token_type`. An error from the API comes back unchanged.
- `withOwnerRetry` repeats a call only for `wallet_proof_required`, and only once. It never repeats a call whose
  outcome is `unknown`, and a call refused with a token it has just obtained is not repeated. With no token it signs in
  first.
  The repeat relies on the API's word that `wallet_proof_required` means the call was not run.
- Always pass a `check`. Without one, `signIn` asks the owner to sign whatever challenge text the API sends.
- `wallet_proof_required` is what the API answers for a missing token, or one that is unknown, expired, signed out or not
  this caller's. The call was not run, so one repeat cannot do a write twice. A malformed `Authorization` header, or a
  client key that is sent but wrong, is answered `unauthenticated`. Signing in again does not fix that, so it is not
  retried.
- The three errors added here, and `callback_failed` from `withOwnerRetry`, carry `status: 0`. That is not an HTTP
  status; it means the call never reached the API.
- `withOwnerRetry` does not throw for what your functions do: a throw from `signIn`, `onSignIn` or the call comes back as
  `callback_failed`, which is `unknown` when the call itself threw.
- Two calls that meet `wallet_proof_required` at the same moment each sign in, so the owner may be asked to sign twice.
  Share one sign-in between them yourself if that matters.
- Both functions need the client's two sign-in calls, made with a client key or [without one](#without-a-client-key).
- Neither stores the token: `onSignIn` is where you keep it.

## Without a client key

This needs Tempora API 0.1.2 or later; an API 0.1.1 server refuses a sign-in with no key as `unauthenticated`.

A wallet owner using their own application, such as a command-line tool on their own machine, can sign in with no
client key. Make the client without `clientKey`, call `signIn` without an `origin`, and use the token on a client made
the same way.

The challenge text is six plain lines:

1. the fixed first line `Tempora sign-in`;
2. `Host: <the API's host>`;
3. `Client: ...`;
4. `Owner: <the owner, checksummed>`;
5. `Nonce: ...`;
6. one line with `Issued:` and `Expires:` times.

Before anything is signed, your `check` should confirm the host is the API you meant to call, the owner is the
wallet you are signing in, and the expiry is a few minutes away.

Sign-ins without a key are limited per network address. Past the limit, `signIn` returns `rate_limited` with
`retryAfter` in seconds.

A token from this sign-in works only on calls made without a client key. A token from a sign-in with a key works
only with that key. Sent the other way, either is refused with `wallet_proof_required`.

```ts
const API_HOST = '<api host>' // a constant in your application, never read from the challenge
const own = createClient({ baseUrl: `https://${API_HOST}` })
const signedIn = await signIn(own, {
  owner,
  signMessage: (message: string) => askOwnerToSign(owner, message),
  check: (message: string) => {
    const lines = message.split('\n')
    const expires = Date.parse(lines[5]?.split('Expires: ')[1] ?? '')
    return lines.length === 6 && lines[0] === 'Tempora sign-in' && lines[1] === `Host: ${API_HOST}`
      && lines[3]?.toLowerCase() === `owner: ${owner.toLowerCase()}`
      && expires > Date.now() && expires - Date.now() <= 10 * 60_000
  },
})
```

This check is the minimum: the message names your API, this owner, and an expiry that has not passed and is not far
off. A stricter one can also confirm the `Client:` line, the nonce's shape, and that `Issued:` is not in the future and
at most five minutes before `Expires:`.

## The flow

1. **Ask for a challenge.** `sign_in_challenge({ body: { owner, origin? } })`. `owner` is the wallet
   address; `origin` is optional and is a URI (the API document does not describe it further). The answer
   is `{ message, nonce, expiresAt }`.
2. **The owner signs `message` in their own wallet**, before `expiresAt`. The signature is `0x` followed by
   at least 65 bytes of hex.
3. **Verify.** `sign_in_verify({ body: { owner, nonce, signature } })`, with the same `owner` and the
   `nonce` from step 1. The answer is `{ token, tokenType, expiresAt }`. The document types `tokenType` as `"Bearer"` or
   another string; the client always sends the token as `Bearer <token>`.
4. **Use the token** as `ownerToken`, on the client or per call, until its `expiresAt`. Then sign in again.

```ts
import { createClient } from '@temporalabs/client'

// Your own code that has the owner sign a message in their wallet, and returns the signature.
declare function askOwnerToSign(owner: string, message: string): Promise<string>

const client = createClient({ baseUrl: 'https://<api origin>', clientKey: requireEnv('TEMPORALABS_CLIENT_KEY') })
const owner = '0x1111111111111111111111111111111111111111'

const challenge = await client.sign_in_challenge({ body: { owner, origin: 'https://app.example.com' } })
if (!challenge.ok) throw new Error(`${challenge.error.code}: ${challenge.error.message}`)

const signature = await askOwnerToSign(owner, challenge.body.message)

const verified = await client.sign_in_verify({ body: { owner, nonce: challenge.body.nonce, signature } })
if (!verified.ok) throw new Error(`${verified.error.code}: ${verified.error.message}`)

const { token, expiresAt } = verified.body
console.log('signed in until', expiresAt)

// Per call:
const positions = await client.positions({}, { ownerToken: token })
// Or on a client of its own for this owner:
const asOwner = createClient({ baseUrl: 'https://<api origin>', clientKey: requireEnv('TEMPORALABS_CLIENT_KEY'), ownerToken: token })
const account = await asOwner.account({ path: { product: 'example-product' } })
if (positions.ok && account.ok) console.log(positions.body.positions.length, account.body.standing.state)
```

The token is sent as `Authorization: Bearer <token>`, and only on owner calls: the public reads and the
two sign-in calls never carry it. A token passed to a call is used instead of the client's. The client
sends an owner call even when it has no token; the call then goes without an `Authorization` header.

Treat the owner token like the client key: it acts for the owner until it expires or is revoked. Keep it
on your server.

## Calls that need the token

`account`, `account_performance`, `positions`, `quote`, `sign_out`, and the request calls in
[Requests and steps](requests-and-steps.md): `deposit`, `withdraw`, `submit`, `status`, `status_lookup`
and `cancel`.

```ts
import { createClient } from '@temporalabs/client'

declare const token: string
const client = createClient({ baseUrl: 'https://<api origin>', clientKey: requireEnv('TEMPORALABS_CLIENT_KEY'), ownerToken: token })

const account = await client.account({ path: { product: 'example-product' } })
if (account.ok) {
  // enrolled is null when the portfolio could not be read, which is not the same as "not enrolled".
  console.log(account.body.account.enrolled)
  for (const g of account.body.gates) if (g.status !== 'pass') console.log(g.id, g.status, g.reason, g.satisfy)
}

const performance = await client.account_performance({ path: { product: 'example-product' } })
// The body itself may be null.
if (performance.ok && performance.body !== null) console.log(performance.body.days.length)
```

## A token for the MCP endpoint

A token works only on the endpoints it was made for. `signIn` takes `audience`:

| `audience` | the token works on |
|---|---|
| left out, or `'http'` | the HTTP API only |
| `'mcp'` | the API's MCP endpoint only (`createMcpClient`) |
| `'both'` | both, for one process that calls both |

A token sent to an endpoint it was not made for is refused as `wallet_proof_required`, the same code as an expired
one, so `withOwnerRetry` signs in again. Give that sign-in the right `audience`, or it repeats the refusal.

Signing in is not an MCP tool, and no call that returns a token is. So even a program that only calls the MCP
endpoint signs in through `createClient`, keyless or with its key, and hands the token to `createMcpClient`:

```ts
const signedIn = await signIn(client, { owner, signMessage, check, audience: 'mcp' })
if (signedIn.ok) {
  const tempora = createMcpClient({ url: 'https://<mcp origin>/mcp', ownerToken: signedIn.body.token })
}
```

**An MCP host lists tools once, when it connects.** The endpoint lists the owner tools only to a connection that carries
an owner token it accepts, and announces no later change. A host that signs in after connecting keeps seeing the
public tools until it reconnects. Connect with the token already in the `Authorization` header (`ownerToken`
above), or reconnect after signing in.

## Sign out

`sign_out({})` revokes the owner token it is sent with. The answer is `{ revoked: true }`.

```ts
import { createClient } from '@temporalabs/client'

declare const token: string
const client = createClient({ baseUrl: 'https://<api origin>', clientKey: requireEnv('TEMPORALABS_CLIENT_KEY') })

const out = await client.sign_out({}, { ownerToken: token })
if (out.ok) console.log('revoked', out.body.revoked)
```

## When sign-in is refused

The API document's error codes include these, whose names point at sign-in and the owner token:
`unauthenticated`, `wallet_proof_required`, `challenge_invalid`, `challenge_other_site`,
`signed_by_other_wallet`, `signature_not_owner` and `unknown_origin`. Each comes with a `message` and an
`outcome`; see [Errors](errors.md).

The API document lists these codes but does not describe when each one is returned. From the API itself,
`wallet_proof_required` is a missing, unknown, expired or signed-out token, and `unauthenticated` is a malformed
`Authorization` header or a missing or wrong client key. The document does not say how long a challenge or a token
lasts: read `expiresAt` on each answer rather than assuming a duration.
