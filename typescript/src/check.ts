/**
 * The check before signing, for a vault's steps: what this client puts in front of the owner's wallet at all.
 *
 * Each step is decoded from its own calldata and compared with what the caller knows independently of the step: the
 * product's vault record (`product.vault`: its chain, vault and asset addresses, read from the API before the request),
 * the owner's own address, and the amount the owner asked for. Nothing the step says about itself (`purpose`, `checks`)
 * is trusted. Only these calls are admitted:
 *
 *   - `approve(vault, n)` on the vault's asset, for exactly the deposit's amount, never more;
 *   - `deposit(assets, receiver)` on the vault, for exactly the amount asked, receiver = the owner;
 *   - `withdraw(assets, receiver, owner)` on the vault, for exactly the assets asked, receiver = owner = the owner;
 *   - `redeem(shares, receiver, owner)` on the vault, for exactly the shares asked, receiver = owner = the owner. For
 *     "all", the shares are not checked (any above zero): only the receiver, the owner and the direction are. A caller
 *     that knows the owner's share balance should ask for those shares instead.
 *
 * The vault record is the anchor: a caller that holds its own record of the vault (a pinned configuration) should pass
 * that one. Passing the product record read from the same API that builds the steps checks the steps against that
 * API's own record: it catches a wrong step, never a wrong record. No amount of zero is admitted.
 *
 * The vault's chain must be an EVM chain the API serves (`SERVED_CHAINS`). Every address must be all lower case, all
 * upper case, or mixed case with a correct EIP-55 checksum.
 *
 * Every step is a `send_transaction` on the vault's chain carrying no value, and its calldata must be exactly the
 * canonical encoding of what it decodes to: lower-case hex, no trailing bytes, no bits set above an address's 20
 * bytes. A request is `[approve, deposit]`, `[deposit]` or one withdrawal, in that order. Nothing here calls the
 * network or signs.
 */
import { decodeCall, type Word } from './abi/calldata'
import { UINT256_DIGITS, isAddress, same, servedChain } from './evm'

/** The vault as the product record names it (`product.vault`). */
export type VaultOnChain = { chain: string; vaultAddress: string; assetAddress: string }

/** What the owner asked for, in the terms of the vault record. Amounts are raw integers as decimal strings. */
export type VaultIntent =
  | { action: 'deposit'; vault: VaultOnChain; owner: string; assets: string }
  | { action: 'withdraw'; vault: VaultOnChain; owner: string; amount: { kind: 'assets'; raw: string } | { kind: 'shares'; raw: string } | { kind: 'all' } }

/**
 * The parts of a step this check reads. Any release's step type fits it, including the client's own `Step`, so
 * `request.steps` is passed as it is; a step of a kind this check does not take is refused when it runs.
 */
export type StepToCheck = { readonly kind: string; readonly chainId?: unknown; readonly payload?: unknown }

/**
 * The payload fields the API defines for each step kind. A payload carrying any other field is refused: a caller that
 * hands the payload to a wallet would hand that field over too (an EIP-7702 authorization list, another chain, gas, a
 * sender), and no check here reads it.
 */
export const PAYLOAD_FIELDS = {
  send_transaction: ['generation', 'expiresAt', 'to', 'data', 'value'],
  sign_message: ['generation', 'expiresAt', 'bytes'],
  sign_typed_data: ['generation', 'expiresAt', 'typedData'],
} as const

/** The payload as a plain object holding only the fields `kind` defines, or null. An own `__proto__` key is a field like any other, so it is refused. */
export function payloadOf(payload: unknown, kind: keyof typeof PAYLOAD_FIELDS): Record<string, unknown> | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const allowed: readonly string[] = PAYLOAD_FIELDS[kind]
  return Object.keys(payload).every((k) => allowed.includes(k)) ? (payload as Record<string, unknown>) : null
}

export type VaultCall = 'approve' | 'deposit' | 'withdraw' | 'redeem'
export type StepCheck = { ok: true; call: VaultCall } | { ok: false; reason: string }
/**
 * `pending` lists the steps with nothing to sign yet. Once each has its payload, check the whole set again with
 * `checkSteps`, or check that step with `checkStep`, passing the call its position takes: on its own, a step does not
 * know where it stands, so a valid call in the wrong place would pass.
 */
export type StepsCheck = { ok: true; pending: number[] } | { ok: false; step: number | null; reason: string }

const SELECTORS: Readonly<Record<string, VaultCall>> = {
  '0x095ea7b3': 'approve', // approve(address,uint256)
  '0x6e553f65': 'deposit', // deposit(uint256,address)
  '0xb460af94': 'withdraw', // withdraw(uint256,address,address)
  '0xba087652': 'redeem', // redeem(uint256,address,address)
}
/** Each call's argument words, in order: an address or a uint256. */
const ARGS: Readonly<Record<VaultCall, readonly Word[]>> = {
  approve: ['address', 'uint'],
  deposit: ['uint', 'address'],
  withdraw: ['uint', 'address', 'address'],
  redeem: ['uint', 'address', 'address'],
}
const CALLS = Object.fromEntries(Object.entries(SELECTORS).map(([selector, call]) => [selector, ARGS[call]]))
// A raw amount is a uint256: at most 78 digits; a longer one is refused as malformed.
const RAW = new RegExp(`^(0|[1-9][0-9]{0,${UINT256_DIGITS - 1}})$`)
/** An approval this large is unlimited in effect, whatever the intent says: never admitted. */
const UNLIMITED_APPROVAL = 2n ** 128n

const refuse = (reason: string): { ok: false; reason: string } => ({ ok: false, reason })

type Decoded = { call: VaultCall; words: (bigint | string)[] }

/** The call and its arguments, or why the calldata is not exactly one of the four calls' canonical encodings. */
function decode(data: string): Decoded | string {
  const d = decodeCall(data, CALLS)
  if (d.ok) return { call: SELECTORS[d.selector]!, words: d.words }
  if (d.refused === 'encoding') return 'the calldata is not a valid encoding'
  if (d.refused === 'selector') return 'the calldata is not a vault call this client knows'
  return `the calldata is not the canonical encoding of ${SELECTORS[d.selector!]}`
}

/** Why an intent is outside its documented shape, read from plain JS or JSON as well as typed code; or nothing. */
function intentProblem(intent: VaultIntent): string | undefined {
  const i = intent as { action?: unknown; amount?: { kind?: unknown } }
  if (i.action !== 'deposit' && i.action !== 'withdraw') return `the intent's action ${JSON.stringify(i.action)} is not deposit or withdraw`
  if (i.action === 'withdraw' && !AMOUNT_KINDS.includes(i.amount?.kind as string)) return `the withdrawal's amount kind ${JSON.stringify(i.amount?.kind)} is not assets, shares or all`
  // Checked here, so every check (checkSteps too, for a step with nothing to sign yet) reads a complete record.
  const v = (intent as { vault?: unknown }).vault as { vaultAddress?: unknown; assetAddress?: unknown; chain?: unknown } | null | undefined
  if (typeof v !== 'object' || v === null || !isAddress(v.vaultAddress) || !isAddress(v.assetAddress) || typeof v.chain !== 'string' || !v.chain) return 'the vault record is not complete'
  if (servedChain(v.chain) === null) return `the vault's chain ${JSON.stringify(v.chain)} is not an EVM chain the API serves`
  return undefined
}
const AMOUNT_KINDS = ['assets', 'shares', 'all']

/**
 * One step, checked against the owner's intent. `expected`, when given, is the call this step's position takes in the
 * request (for a deposit's first of two steps, `approve`): any other call is refused, however valid on its own.
 */
export function checkStep(step: StepToCheck, intent: VaultIntent, expected?: VaultCall): StepCheck {
  const problem = intentProblem(intent)
  if (problem) return refuse(problem)
  const { vault, owner } = intent
  if (!isAddress(owner)) return refuse('the owner is not an address')
  // An amount of nothing is never asked for: refused before any step is read, so no zero-amount call is admitted.
  const asked = intent.action === 'deposit' ? intent.assets : intent.amount.kind === 'all' ? null : intent.amount.raw
  if (asked !== null && (!RAW.test(asked) || BigInt(asked) === 0n)) return refuse('the amount asked for is zero or not a raw amount')
  if (step.kind !== 'send_transaction') return refuse(`a step of kind ${step.kind} is not a vault transaction`)
  if (step.chainId !== vault.chain) return refuse(`the step is on chain ${String(step.chainId)}, not the vault's chain ${vault.chain}`)
  if (step.payload === undefined) return refuse('the step has nothing to sign yet')
  const p = payloadOf(step.payload, 'send_transaction')
  if (!p) return refuse(`the step's payload is not an object of only ${PAYLOAD_FIELDS.send_transaction.join(', ')}`)
  if (typeof p.to !== 'string' || typeof p.data !== 'string' || typeof p.value !== 'string') return refuse('the step has nothing to sign yet')
  if (p.value !== '0') return refuse('the step sends value; a vault call carries none')
  if (!isAddress(p.to)) return refuse('the step is not sent to an address')
  const d = decode(p.data)
  if (typeof d === 'string') return refuse(d)
  if (expected !== undefined && d.call !== expected) return refuse(`a ${d.call} is not the call this step's position takes: ${expected}`)
  const [a, b, c] = d.words
  const exact = (raw: string, n: bigint | string | undefined) => RAW.test(raw) && typeof n === 'bigint' && n === BigInt(raw)

  switch (d.call) {
    case 'approve':
      if (intent.action !== 'deposit') return refuse('an approval is not what was asked for')
      if (!same(p.to, vault.assetAddress)) return refuse("the approval is not sent to the vault's asset")
      if (typeof a !== 'string' || !same(a, vault.vaultAddress)) return refuse('the approval names a spender other than the vault')
      if (typeof b === 'bigint' && b >= UNLIMITED_APPROVAL) return refuse('the approval is unlimited in effect (2^128 or more)')
      if (!exact(intent.assets, b)) return refuse("the approval's amount is not exactly the deposit's")
      return { ok: true, call: 'approve' }
    case 'deposit':
      if (intent.action !== 'deposit') return refuse('a deposit is not what was asked for')
      if (!same(p.to, vault.vaultAddress)) return refuse('the deposit is not sent to the vault')
      if (!exact(intent.assets, a)) return refuse("the deposit's amount is not exactly the one asked for")
      if (typeof b !== 'string' || !same(b, owner)) return refuse("the deposit's receiver is not the owner")
      return { ok: true, call: 'deposit' }
    case 'withdraw':
    case 'redeem': {
      if (intent.action !== 'withdraw') return refuse(`a ${d.call} is not what was asked for`)
      const wanted = intent.amount.kind === 'assets' ? 'withdraw' : 'redeem'
      if (d.call !== wanted) return refuse(`a ${d.call} is not what was asked for: the amount was given in ${intent.amount.kind}`)
      if (!same(p.to, vault.vaultAddress)) return refuse(`the ${d.call} is not sent to the vault`)
      if (typeof b !== 'string' || !same(b, owner)) return refuse(`the ${d.call}'s receiver is not the owner`)
      if (typeof c !== 'string' || !same(c, owner)) return refuse(`the ${d.call}'s owner is not the owner`)
      if (intent.amount.kind === 'assets' && !exact(intent.amount.raw, a)) return refuse("the withdrawal's amount is not exactly the one asked for")
      if (intent.amount.kind === 'shares' && !exact(intent.amount.raw, a)) return refuse('the redeem is not for exactly the shares asked for')
      if (intent.amount.kind === 'all' && !(typeof a === 'bigint' && a > 0n)) return refuse('the redeem is for no shares')
      return { ok: true, call: d.call }
    }
  }
}

/** The order a request's calls may come in: one step at most of each, in this sequence. */
const SHAPES: Readonly<Record<VaultIntent['action'], readonly VaultCall[][]>> = {
  deposit: [['approve', 'deposit'], ['deposit']],
  withdraw: [['withdraw'], ['redeem']],
}

/**
 * Every step of a request: each one that has something to sign is checked by `checkStep`, and the steps together must be
 * one of the shapes above. A step with nothing to sign yet (a deposit waiting on its approval) is checked by its kind and
 * chain only, and takes its place in the shape. `step` names the first step refused, or null for the request as a whole.
 */
export function checkSteps(steps: readonly StepToCheck[], intent: VaultIntent): StepsCheck {
  const problem = intentProblem(intent)
  if (problem) return { ok: false, step: null, reason: problem }
  const shapes = SHAPES[intent.action]
  const longest = Math.max(...shapes.map((s) => s.length))
  // Too many steps names the first one past the longest shape; too few (none) names the request.
  if (!shapes.some((s) => s.length === steps.length)) return { ok: false, step: steps.length > longest ? longest : null, reason: `a ${intent.action} request has ${steps.length} step(s), which is not a shape this client admits` }
  const calls: (VaultCall | null)[] = []
  for (const [i, s] of steps.entries()) {
    if (s.payload === undefined) {
      if (s.kind !== 'send_transaction') return { ok: false, step: i, reason: `a step of kind ${s.kind} is not a vault transaction` }
      if (s.chainId !== intent.vault.chain) return { ok: false, step: i, reason: `the step is on chain ${String(s.chainId)}, not the vault's chain ${intent.vault.chain}` }
      calls.push(null)
      continue
    }
    const r = checkStep(s, intent)
    if (!r.ok) return { ok: false, step: i, reason: r.reason }
    calls.push(r.call)
  }
  const fits = (shape: readonly VaultCall[]) => shape.length === calls.length && calls.every((c, i) => c === null || c === shape[i])
  if (shapes.some(fits)) return { ok: true, pending: calls.flatMap((c, i) => (c === null ? [i] : [])) }
  // The first step that fits no shape of this length.
  const candidates = shapes.filter((s) => s.length === calls.length)
  const at = calls.findIndex((c, i) => c !== null && candidates.every((s) => s[i] !== c))
  return { ok: false, step: at === -1 ? null : at, reason: `the steps are not in an order this client admits for a ${intent.action}` }
}
