# Requests and steps

A deposit or a withdrawal is a **request**. The API answers `deposit` and `withdraw` with a `Request`
that lists the **steps** the owner's wallet has to sign or send. Your code has the owner's wallet sign
or send each step, then hands the result back with `submit`. Every request call needs an owner token
([Sign-in](sign-in.md)).

## The request

`deposit`, `withdraw`, `submit`, `status`, `status_lookup` and `cancel` all answer with a `Request`:

| Field | What it holds |
|---|---|
| `requestId` | `req_` followed by 10 to 40 letters and digits. |
| `action` | `deposit` or `withdraw`. |
| `state` | `requires_action`, `processing`, `held`, `completed`, `partial`, `failed` or `cancelled`. |
| `chose` | What the request is for: `product`, and when set, `chain`, `token` and `amount`. |
| `expiresAt` | A time. |
| `steps` | The steps, in order (below). |
| optional | `quote` (`raw`, `source`, `at`), `warning`, `split` (`fromIdleUsd`, `fromSaleUsd`, `remainingInvestedUsd`), `leftBehind` (each entry with a `reason`; the document does not define it further), `smartAccount`, and `operation` (below). |

`state` and the step states are open lists: a newer API may send a value not listed here, and the client
passes it through as a string. Handle values you do not know.

The API document lists these states but does not define each one.

## Start a request

```ts
import { createClient } from '@temporalabs/client'

// Reads an environment variable and fails when it is unset (defined in Getting started).
declare function requireEnv(name: string): string
declare const token: string
const client = createClient({ baseUrl: 'https://<api origin>', clientKey: requireEnv('TEMPORALABS_CLIENT_KEY'), ownerToken: token })

// A vault deposit is checked against a raw amount of its asset, so ask for one in `assets` (a portfolio
// deposit may be asked in `usd`). A vault deposit also carries `vaultTerms`, the `version` and `sha256` of the vault
// terms the owner was shown and accepted; the API refuses one without them.
const deposit = await client.deposit({
  body: {
    product: 'example-product',
    amount: { kind: 'assets', assetId: 'eip155:8453/erc20:0x0000000000000000000000000000000000000001', raw: '2000000' },
    vaultTerms: { version: '1', sha256: '0x0000000000000000000000000000000000000000000000000000000000000000' },
  },
})

const withdrawal = await client.withdraw({
  body: { product: 'example-product', amount: { kind: 'fraction', value: '0.500000' } },
})

if (deposit.ok) console.log(deposit.body.requestId, deposit.body.state, deposit.body.steps.length)
if (!withdrawal.ok) console.error(withdrawal.error.code, withdrawal.error.outcome, withdrawal.error.gates)
```

`deposit` takes `product`, and optionally `amount`, `chain`, `token`, `sent` and `gas`. `withdraw` takes
`product` and `amount`, and optionally `gas`. Send `gas: 'self'` when the owner's wallet pays its own gas: the
API then refuses the request at the `gas-funds` gate if the wallet's native balance cannot pay every step. Leave
it out for a sponsored or smart-account wallet. It changes nothing the wallet signs. An amount is one of:

| `kind` | Other fields |
|---|---|
| `usd` | `value`: dollars, up to two decimals, more than zero (`'250'`, `'99.50'`). |
| `fraction` | `value`: more than 0 and at most 1: `'1'`, or `0.` followed by 6 to 18 decimal places (`'0.500000'` is half; `'0.5'` is refused). |
| `all` | none |
| `assets` | `assetId` (CAIP-19) and `raw` (a positive integer in base units). |
| `shares` | `raw` (a positive integer). |

A product lists the forms it accepts for each action in `amountForms`, and its minimum in `minimum`
(`firstDepositUsd`, and `topUpUsd` when set). Read them with `product` before you build the amount.

## Steps

Each step has a `stepId` (`s` and up to three digits), a `kind`, a `state`, a `chainId` (CAIP-2) and a
list of `checks` (`what`, and optionally `equals` and `note`). It may carry `after` (another step's id)
and `handoff` (a URL). When it has something to sign or send, it carries a `payload` with a `generation`
(from 1) and its own `expiresAt`.

| `kind` | `payload` | What the owner's wallet does |
|---|---|---|
| `sign_message` | `bytes` (hex) | `personal_sign` of the raw bytes, never of their text: with viem, `signMessage({ message: { raw: bytes } })`. The step also has a `purpose`. |
| `sign_typed_data` | `typedData` (`domain`, `types`, `primaryType`, `message`) | Signs the EIP-712 typed data. The step also has `manifest` (`index` of `of`), `plan` (`liquidate`, `assets`) and optionally `operationId`. |
| `send_transaction` | `to`, `data`, `value` | Sends the transaction. The step may carry an `attemptId` and a `verification` (below). |
| `send_solana_transaction` | `transaction` (standard Base64) | Sends the Solana transaction. The step may carry an `attemptId`. |

A newer API may send a step kind not in this table. The client keeps it, with its `stepId`, `kind`,
`state` and any other fields; your code should leave such a step alone rather than guess at it.

Step states are `waiting`, `ready`, `sending`, `confirming`, `queued`, `landed`, `replaced`, `reverted`,
`mismatch`, `running`, `completed`, `failed` and `cancelled`. As with request states, the document lists
them without defining each.

A `send_transaction` step may carry `verification`, what the API's last look at the chain found. Its
fields are `hash`, `alsoMoved`, `nonce`, `head`, `message` and `lastLook` (`'unreadable'` when the latest
look could not read the chain); the document lists them without defining each.

A `send_transaction` step may also carry `fee`, the API's gas and fee estimate for it (`gasLimit`, `fees`,
`maxCost`, `nativeAsset` and more), marked `advisory: true`. It is for display. It sits beside the
`payload`, not in it, so the checks below do not read it and it is never handed to the wallet: the wallet
prices the transaction itself.

## Check a vault's steps before the owner signs

A product's `kind` says which check applies: `vault` takes `checkSteps` (below), and `portfolio` takes
`checkPortfolioWithdrawal` and `checkPortfolioDeposit` ([further down](#check-a-portfolios-steps-before-the-owner-signs)).

`checkSteps(steps, intent)` (and `checkStep` for one step) decodes each `send_transaction` step's own
calldata and refuses it unless it is exactly what the owner asked for. It never trusts what a step says
about itself (`purpose`, `checks`). A step whose `payload` has any field beyond the API's own (`to`, `data` and
`value`, with `generation` and `expiresAt`) is refused too, because a wallet would act on a field such as `gas`
or `authorizationList` that no check reads. Pass `request.steps` as the client returns it. The `intent` comes from what you know independently of the request:
the vault's record (`chain`, `vaultAddress`, `assetAddress`), the owner's own address, and the amount they
asked for, in raw units.

**Never looser than the API.** The checks may refuse what the API would allow, never the reverse. A vault or
portfolio must be on an EVM chain the API serves (`SERVED_CHAINS`, the chains `chains` lists at the API version this
client is built from); a chain the API adds later is refused until a client release adds it. Calldata must be
lower-case hex. Every address must be all lower case, all upper case, or mixed case with a correct
[EIP-55](https://eips.ethereum.org/EIPS/eip-55) checksum; a mixed-case address whose checksum is wrong is most likely
mistyped, and is refused.

**Which vault record.** If you hold your own record of the vault (a pinned configuration), pass that one,
and refuse a product whose `vault` differs from it before you ask for steps. Passing the `vault` read with
`product` from the same API that builds the steps checks the steps against that API's own record: it
catches a wrong step, never a wrong record.

```ts
import { checkSteps } from '@temporalabs/client'

const product = await client.product({ path: { id } })
if (!product.ok || !product.body.vault) throw new Error('not a vault')
const intent = { action: 'deposit' as const, vault: product.body.vault, owner, assets: '2000000' }
const verdict = checkSteps(request.steps, intent)
if (!verdict.ok) throw new Error(`not signing step ${verdict.step}: ${verdict.reason}`)
```

It admits only these calls, each on the vault's chain with no value and in its exact canonical encoding:

| Call | Sent to | Must be |
|---|---|---|
| `approve(spender, n)` | the vault's asset | spender = the vault; `n` = exactly the deposit's amount, and never 2^128 or more, whatever was asked |
| `deposit(assets, receiver)` | the vault | `assets` = the amount asked; receiver = the owner |
| `withdraw(assets, receiver, owner)` | the vault | asked in `assets`, for exactly that amount; receiver = owner = the owner |
| `redeem(shares, receiver, owner)` | the vault | asked in `shares` (exactly those) or `all`; receiver = owner = the owner. For `all` the share count is not checked, only the receiver, owner and direction: if you know the owner's balance, ask for those shares instead |

A request is `[approve, deposit]`, `[deposit]` or a single withdrawal, in that order. An amount of zero is
refused. A step with nothing to sign yet (the deposit waiting on its approval) is checked by its kind and
chain, and listed in the result's `pending`. Once it has its payload, run `checkSteps` over the whole set
again. Or check that step alone with `checkStep`, passing `expected`, the call its position takes (`approve`
for the first of a deposit's two steps). Without `expected`, a step does not know where it stands, so a
second deposit in the approval's place would pass. Check again before each signature. Nothing here calls the
network or signs.

Only amounts given in `assets` or `shares`, or `all`, can be checked exactly. A withdrawal asked as a
`fraction` or in `usd` has no exact amount to compare against, so it is not an intent this check takes.

## Check a vault deposit's bundle before the wallet batches it

A vault deposit with an approval may also carry `bundle`: its steps as one EIP-5792 `wallet_sendCalls` batch,
so the owner confirms once. It is an option. A request without one, or a wallet that cannot batch, sends the
steps one at a time.

`checkBundle(request, intent)` (`check_bundle` in Python) admits the bundle only when it is exactly the checked
steps. The steps must pass `checkSteps` with nothing pending. Then:

- `stepIds` lists every step's `stepId`, in order;
- `sendCalls.calls` has one call per step, each with that step's `to` and `data` byte for byte, and `value`
  `0x0`;
- `sendCalls.from` is the owner, `chainId` is the vault's chain as lower-case hex, `atomicRequired` is `true`
  (all or nothing: an approval never lands without its deposit), and `version` is `2.0.0`;
- no object carries a field beyond these (`capabilities`, for example), because `sendCalls` goes to the wallet as
  it is.

```ts
import { checkBundle } from '@temporalabs/client'

declare const provider: { request(args: { method: string; params: unknown[] }): Promise<{ id: string }> }

const verdict = checkBundle(request, intent)
if (verdict.ok && request.bundle) {
  const { id } = await provider.request({ method: 'wallet_sendCalls', params: [request.bundle.sendCalls] })
  // Poll wallet_getCallsStatus, then hand its answer back on the first step (Submit a step, below).
}
```

## Check a portfolio's steps before the owner signs

`checkPortfolioWithdrawal(steps, intent)` and `checkPortfolioDeposit(steps, intent)` do for a portfolio what
`checkSteps` does for a vault. They read each step's own bytes and compare them with what you know, and never
trust what a step says about itself. Nothing here calls the network or signs.

A portfolio holds the owner's funds in a smart account: a contract wallet on the portfolio's chain that the
provider opens for the owner when they enrol. A deposit pays into it, and a withdrawal authorizes payments out of it
to the owner's own wallet. The request names it as `smartAccount`.

**A withdrawal** is one or more `sign_typed_data` steps, each the provider's EIP-712 `Withdrawal` authorization.
The intent (`PortfolioWithdrawalIntent`) is:
- `owner`: the owner's wallet address;
- `smartAccount`: the request's `smartAccount`;
- `portfolioId`: the portfolio id;
- `chain`: the chain, as `eip155:<reference>`;
- `settlementAssetId`: the settlement asset, as a CAIP-19 id;
- `amount`: `{ kind: 'all' }` or `{ kind: 'fraction', value }`;
- `holdings`: what the smart account holds, as raw units by asset id: the `balances` of its row in `positions`, plus,
  before the first rebalance, the idle USDT read from the chain. The withdrawal check refuses an asset the account is not
  given as holding. A funded account that has not rebalanced yet lists its idle USDT in `idleUsd` only, with
  `balances: []`, so holdings built from `balances` alone are empty and the check refuses with "does not hold".
  `idleUsd` is a USD figure (1 USDT taken as 1 USD), not raw units: read the exact USDT balance of the smart account from
  the chain, put that in `holdings`, and check that it agrees with `idleUsd` to the cent. When `idleUsd` is null the API
  could not read the account, so its holdings are unknown: do not build a withdrawal on them;
- `now`: the current time in milliseconds since the epoch, required;
- `maxLifetimeSeconds`: optional, one hour when left out.

Admitted, and nothing else:
- the struct exactly, with its domain version (`1` for a transfer, `2` for a sale) and its field lists in order;
- debiting the smart account and paying the owner, on the chain, for the portfolio;
- a sale settling in the settlement asset, and a plain transfer moving only that asset;
- whole amounts above zero, each asset once;
- expiring in the future, within `maxLifetimeSeconds` (one hour unless you give one; the provider gives ten minutes);
- each batch exactly the `plan` on its step;
- a payload of only `typedData` (with `generation` and `expiresAt`), and typed data of only `domain`, `types`,
  `primaryType` and `message`;
- each asset's total over every batch at most the fraction asked of what the account holds.

**Hand the wallet typed data that declares its domain.** If a withdrawal's `typedData.types` has no
`EIP712Domain`, add it before signing: the domain's fields in EIP-712 order (`name`, `version`, `chainId`,
`verifyingContract`). Some wallet libraries derive it themselves; others sign a missing domain type as an empty
struct, and that signature then covers neither the chain nor the smart account. The check accepts the type
absent or exactly those four.

A step with nothing to sign yet is listed in the result's `pending`, and its plan still counts toward each asset's
total. A request whose every step is pending is not admitted. Once a step has its payload, run
`checkPortfolioWithdrawal` over every batch again, not over that batch alone: the bound on each asset's total holds
only across the whole set.

Every chain, account and asset id is read by one strict parser, with the chain and address rules above. Asset ids are ERC-20 (`eip155:<reference>/erc20:<address>`),
so a withdrawal that names a holding in any other form is refused as a whole. A batch with no `plan` is refused too: the
API attaches one to every batch.

**A deposit** is `[enrol, transfer]`, or `[transfer]` once enrolled, or `[enrol]` alone when no amount was asked.
The intent (`PortfolioDepositIntent`) is `chain`, `tokenAddress` (the deposit token's contract), `smartAccount`
(the request's), and `amount`, in the token's raw units (left out for an enrol-only request). The transfer must
be exactly `transfer(smartAccount, amount)` on the token, with no value, in its canonical encoding. Each payload holds
only the API's own fields: `bytes` for the enrol signature, `to`, `data` and `value` for the transfer, each with
`generation` and `expiresAt`.

The check pays whatever `smartAccount` you pass it. It comes from the API's answer, and the check cannot vouch
for it: like the vault check, it catches a wrong step, never a wrong record. If you hold your own record of the
owner's smart account, pass that one.

**The enrol signature is blind.** It is a 32-byte hash the provider builds, and the provider does not publish how. The
check confirms its kind, purpose, chain and length, but nothing about what it commits to. `personal_sign`'s prefix
means it cannot be replayed as a transaction. It can still count as an off-chain approval: many smart accounts
accept a `personal_sign` over a 32-byte hash as their signature (ERC-1271), so a blind hash could approve more
than enrolment. The API guards what it enrols. Before the hash is offered for signing,
it refuses an enrolment whose agent it does not recognise. Tell the owner it is a hash they cannot read,
signed to enrol in the portfolio they chose.

## Submit a step

`submit({ path: { requestId, stepId }, body })` hands a step's result back. The answer is the request as
it now stands. The body is one of:

| `kind` | Fields | For |
|---|---|---|
| `signature` | `signature` | A `sign_message` or `sign_typed_data` step. |
| `transaction` | `txHash`, `wallet` (`{ nonce, from, blockNumber }` or `null`) | A `send_transaction` step that was sent. |
| `attempt` | `attemptId`, `broadcast`: `unknown` or `declined` | A send step's attempt whose broadcast was declined, or is not known. |
| `refresh` | `expectedGeneration` | A step's payload, by the `generation` you hold. |
| `bundle` | `id`, `status` | A bundle sent with `wallet_sendCalls`: `id` is the batch id the wallet answered, `status` its raw `wallet_getCallsStatus` answer. Submitted on the bundle's first step. |

The API acts on a `bundle` body only once the status is final (`200`, `500` or `600`) and its receipts name
every step; anything else changes nothing, so keep polling and submit again. It still checks each step on its own
node.

The "For" column is guidance from the field names: the API document lists the body shapes but
not which step takes which. It does not say which body a `send_solana_transaction` step takes, nor
exactly what `refresh` returns beyond the request.

```ts
import { createClient } from '@temporalabs/client'
import type { Request, Step } from '@temporalabs/client'

// Your own wallet code, run by the owner.
declare const wallet: {
  switchChain(chainId: string): Promise<void>
  signRawBytes(bytes: string): Promise<string>
  signTypedData(typedData: unknown): Promise<string>
  sendTransaction(tx: { to: string; data: string; value: string }): Promise<string>
}
declare const token: string
declare let request: Request

const client = createClient({ baseUrl: 'https://<api origin>', clientKey: requireEnv('TEMPORALABS_CLIENT_KEY'), ownerToken: token })

type Known = 'sign_message' | 'sign_typed_data' | 'send_transaction'
const is = <K extends Known>(s: Step, kind: K): s is Extract<Step, { kind: K }> => s.kind === kind

// Check the steps before anything is signed (above): checkSteps for a vault, the two portfolio checks for a
// portfolio. Run the check again before each signature.
declare function checkBeforeSigning(steps: Request['steps']): { ok: true } | { ok: false; reason: string }
const verdict = checkBeforeSigning(request.steps)
if (!verdict.ok) throw new Error(`not signing: ${verdict.reason}`)
for (const step of request.steps) {
  if (step.state !== 'ready') continue
  const path = { requestId: request.requestId, stepId: step.stepId }
  if (typeof step.chainId !== 'string') continue // a step kind from a newer API
  await wallet.switchChain(step.chainId)
  let r
  if (is(step, 'sign_message') && step.payload) {
    r = await client.submit({ path, body: { kind: 'signature', signature: await wallet.signRawBytes(step.payload.bytes) } })
  } else if (is(step, 'sign_typed_data') && step.payload) {
    r = await client.submit({ path, body: { kind: 'signature', signature: await wallet.signTypedData(step.payload.typedData) } })
  } else if (is(step, 'send_transaction') && step.payload) {
    // Hand the wallet only the checked fields, never the whole payload.
    const { to, data, value } = step.payload
    const txHash = await wallet.sendTransaction({ to, data, value })
    r = await client.submit({ path, body: { kind: 'transaction', txHash, wallet: null } })
  } else {
    continue // a kind this code does not handle
  }
  if (r.ok) request = r.body
  else if (r.error.outcome === 'unknown') break // it may have landed: read status before doing anything else
  else console.error(r.error.code, r.error.message)
}
```

`submit` is a write. If its outcome is `unknown`, the API may have taken the step: never submit it again
blind. Read the request with `status` first ([Errors](errors.md)).

## Follow a request

`status({ path: { requestId } })` reads a request by its id. When you do not have the id,
`status_lookup` finds it by exactly one of `nonce`, `txHash` (both 32-byte hex) or `operationId`. The
types allow only one key per call.

```ts
import { createClient } from '@temporalabs/client'

declare const token: string
const client = createClient({ baseUrl: 'https://<api origin>', clientKey: requireEnv('TEMPORALABS_CLIENT_KEY'), ownerToken: token })

const byId = await client.status({ path: { requestId: 'req_0123456789abcdef' } })
const byHash = await client.status_lookup({
  query: { txHash: '0x0000000000000000000000000000000000000000000000000000000000000000' },
})
const byOperation = await client.status_lookup({ query: { operationId: 'op-123' } })

if (byId.ok) console.log(byId.body.state)
if (byHash.ok) console.log(byHash.body.requestId)
if (!byOperation.ok && byOperation.error.code === 'not_found') {
  // None found just now. That does not mean the withdrawal is gone: try again later.
}
```

### A withdrawal found by its operationId

A withdrawal request can be looked up by its `operationId` (a `sign_typed_data` step carries one), with
`status_lookup`. The answer may carry `operation: { id, state }`, where `state` is `running`, `completed`,
`failed` or `cancelled` (or a newer value), and no steps: `steps` is empty and its `expiresAt` bounds nothing,
since nothing is left to sign. Follow it by `operation.state`.

A `not_found` answer for an `operationId` means none was found for this owner just now, never that the
withdrawal is gone: an operation that has only just been accepted may not be listed yet.

## Cancel

`cancel({ path: { requestId } })` asks the API to cancel the request and answers with the request. It is
a write: on an `unknown` outcome, read `status` rather than sending it again.

```ts
import { createClient } from '@temporalabs/client'

declare const token: string
const client = createClient({ baseUrl: 'https://<api origin>', clientKey: requireEnv('TEMPORALABS_CLIENT_KEY'), ownerToken: token })

const r = await client.cancel({ path: { requestId: 'req_0123456789abcdef' } })
if (r.ok) console.log(r.body.state)
```

## Gates

A gate is a condition an owner or a request has to meet. Gate ids include `allowlist`, `wallet-check`,
`minimum`, `product-status`, `token`, `chain`, `enrolled`, `market-hours`, `stand-aside`, `holdings`,
`sizing`, `vault-live`, `vault-terms`, `allowance`, `rate-limit` and `gas-funds`, and a newer API may add more.
A `gas-funds` refusal (code `insufficient_gas_funds`) carries `funds`: the chain, the address, the native
balance and the amount `needed`. They
appear in three places:

- `product.gates`: the gate ids that apply to the product.
- `account.gates`: each gate's `status` for this owner (`pass`, `fail` or `pending`), with an optional
  `code`, `reason` and `satisfy`.
- `error.gates` on a refusal (for example `gate_failed`): the gates that stopped it, each with an `id`
  and an optional `reason` and `satisfy`.

`satisfy`, when present, says what would meet the gate:

| `kind` | Fields | What to do |
|---|---|---|
| `handoff` | `url` | Send the owner to the URL, if it is an `https` URL. Refuse any other scheme. |
| `wait` | `until` (optional) | Try again later; after `until`, when given. A `market-hours` gate that does not pass carries `wait` with `until`. |
| `adjust` | `field`, optional `min` and `max` | Change the named input, within `min` and `max` when given. |

Other kinds may come; each has at least a `kind`. When a gate carries no `satisfy`, its `reason` is the
explanation.

```ts
import type { ApiError } from '@temporalabs/client'

export function explain(error: ApiError): string[] {
  return (error.gates ?? []).map((g) => {
    const s = g.satisfy
    if (s?.kind === 'handoff' && 'url' in s) return `${g.id}: continue at ${String(s.url)}`
    if (s?.kind === 'wait') return `${g.id}: wait${'until' in s && s.until ? ` until ${String(s.until)}` : ''}`
    if (s?.kind === 'adjust' && 'field' in s) return `${g.id}: change ${String(s.field)}`
    return `${g.id}: ${g.reason ?? 'not met'}`
  })
}
```
