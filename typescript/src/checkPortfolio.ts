/**
 * The checks before signing for a portfolio's steps: what this client puts in front of the owner's wallet for a
 * portfolio withdrawal or deposit. Like `checkStep` for a vault, each one reads the step's own bytes and compares them with
 * what the caller knows; nothing a step says about itself is trusted. Nothing here calls the network or signs.
 *
 * **A withdrawal** is one or more EIP-712 authorizations, the provider's `Withdrawal` struct. Admitted, and nothing else:
 *   - the struct exactly: its domain name and version (`1` for a plain transfer, `2` for a sale), its field lists IN
 *     ORDER (a reordered struct hashes differently), no field shown that is not signed and none signed that is not read;
 *   - on the portfolio's chain, debiting the owner's smart account (`verifyingContract`), paying the owner's own wallet
 *     (`recipientAccountId`), for the named portfolio;
 *   - a sale settles in the settlement asset; a plain transfer moves only that asset;
 *   - each amount a whole number of units above zero, each asset named once, each entry exactly `{ assetId, amountRaw }`;
 *   - expiring in the future, and no later than `maxLifetimeSeconds` from now (the provider gives ten minutes); `now`
 *     and the lifetime must be finite numbers, the lifetime above zero, or nothing is admitted;
 *   - each batch exactly the plan the API attached to its step (same kind, every asset at exactly its amount, every
 *     signed asset planned, none planned twice);
 *   - each asset's total over every batch at most the asked fraction (or all) of what the caller says the smart account
 *     holds, which the caller reads from the API's `positions`. An asset not held is refused.
 * Every chain, account and asset id is read with one strict parser: `eip155:<reference>` with no leading zero, and a
 * 20-byte address compared in any letter case, refused when mixed case with a wrong EIP-55 checksum. The portfolio's
 * chain must be an EVM chain the API serves (`SERVED_CHAINS`).
 *
 * **A deposit** is the enrol signature (only when not yet enrolled), then the transfer of the deposit token to the
 * smart account the API names for this owner. Admitted: `[enrol, transfer]`, `[transfer]`, or `[enrol]` when no amount
 * was asked. The transfer is exactly `transfer(smartAccount, amount)` on the token, on the portfolio's chain, with no
 * value, in its canonical encoding.
 *
 * ⚠️ **The enrol signature is blind.** Its payload is a 32-byte hash the provider builds, and the provider does not publish
 * how. This check confirms its kind, purpose, chain and length, and nothing about what it commits to. `personal_sign`'s
 * prefix means the signature cannot be replayed as a transaction, but many smart accounts accept a `personal_sign` over a
 * 32-byte hash as an ERC-1271 signature, so a blind hash may still count as an off-chain approval. What the hash enrols
 * is guarded only by the API, which refuses an enrolment whose agent is not on its allow list before the hash is offered
 * for signing.
 */
import { decodeCall } from './abi/calldata'
import { CHAIN, isAddress, same, servedChain } from './evm'
import { PAYLOAD_FIELDS, payloadOf } from './check'

/** What the owner asked to withdraw from a portfolio, and what the caller knows independently of the steps. */
export type PortfolioWithdrawalIntent = {
  /** The connected wallet: the only recipient there is. */
  owner: string
  /** The smart account the API names for this owner's portfolio (the request's `smartAccount`). */
  smartAccount: string
  /** The portfolio the owner chose. */
  portfolioId: string
  /** The portfolio's chain, as `eip155:<reference>`. */
  chain: string
  /** The asset a sale settles in, and the only one a plain transfer may move. */
  settlementAssetId: string
  /** All of each holding, or a fraction of each, as a decimal above 0 and at most 1 with up to 18 places. */
  amount: { kind: 'all' } | { kind: 'fraction'; value: string }
  /** What the smart account holds, raw units by asset id, as the caller read it from `positions`. */
  holdings: Readonly<Record<string, string>>
  /** Now, in milliseconds since the epoch. */
  now: number
  /** The longest an authorization may stay valid from now. One hour when left out. */
  maxLifetimeSeconds?: number
}

/** What the owner asked to deposit into a portfolio. */
export type PortfolioDepositIntent = {
  /** The portfolio's chain, as `eip155:<reference>`. */
  chain: string
  /** The deposit token's contract on that chain. */
  tokenAddress: string
  /** The smart account the API names for this owner (the request's `smartAccount`). */
  smartAccount: string
  /** The raw amount asked for. Left out for an enrol-only request. */
  amount?: string
}

/**
 * The parts of a step these checks read. Any release's step type fits it, including the client's own `Step`, so
 * `request.steps` is passed as it is; a step of a kind a check does not take is refused when it runs.
 */
export type PortfolioStepToCheck = {
  readonly kind: string
  readonly chainId?: unknown
  readonly purpose?: unknown
  readonly plan?: unknown
  readonly payload?: unknown
}
const TYPED_DATA_FIELDS = ['domain', 'types', 'primaryType', 'message'] as const
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export type PortfolioWithdrawalCheck =
  | { ok: true; kinds: ('transfer' | 'sale')[]; totals: { assetId: string; amount: string; held: string }[]; expiresAt: Date; pending: number[] }
  | { ok: false; step: number | null; reason: string }
export type PortfolioDepositCheck = { ok: true; pending: number[] } | { ok: false; step: number | null; reason: string }

const DOMAIN_NAME = 'Glider Withdrawal Authorization'
const FIELDS = {
  transfer: [
    ['portfolioId', 'string'],
    ['recipientAccountId', 'string'],
    ['assets', 'WithdrawalAsset[]'],
    ['nonce', 'bytes32'],
    ['expiresAt', 'uint256'],
  ],
  sale: [
    ['portfolioId', 'string'],
    ['recipientAccountId', 'string'],
    ['assets', 'WithdrawalAsset[]'],
    ['nonce', 'bytes32'],
    ['expiresAt', 'uint256'],
    ['liquidate', 'bool'],
    ['settlementAssetId', 'string'],
  ],
} as const
const ASSET_FIELDS = [
  ['assetId', 'string'],
  ['amountRaw', 'string'],
] as const
// EIP-712's own order for the domain fields it uses.
const DOMAIN_FIELDS = [
  ['name', 'string'],
  ['version', 'string'],
  ['chainId', 'uint256'],
  ['verifyingContract', 'address'],
] as const
const DEFAULT_LIFETIME_S = 3_600
const MS_PER_S = 1_000
const FRACTION_PLACES = 18

// A raw amount is a uint256: at most 78 digits. Anything longer can never match a chain value, so it is refused
// as malformed, and no client spends unbounded time converting it.
const RAW_POSITIVE = /^[1-9][0-9]{0,77}$/
const DIGITS = /^[0-9]{1,78}$/
const BYTES32 = /^0x[0-9a-fA-F]{64}$/
const ACCOUNT = /^eip155:([1-9][0-9]*):(0x[0-9a-fA-F]{40})$/
const ASSET = /^eip155:([1-9][0-9]*)\/erc20:(0x[0-9a-fA-F]{40})$/

/** `eip155:<ref>/erc20:<address>` as one comparable string, or null. One parser for every asset id. */
const assetKey = (v: unknown): string | null => {
  const m = typeof v === 'string' ? ASSET.exec(v) : null
  return m && isAddress(m[2]) ? `eip155:${m[1]}/erc20:${m[2]!.toLowerCase()}` : null
}
const chainRef = (v: unknown): string | null => (typeof v === 'string' ? (CHAIN.exec(v)?.[1] ?? null) : null)
const keysAre = (o: object, want: readonly string[]) => {
  const k = Object.keys(o)
  return k.length === want.length && want.every((w) => k.includes(w))
}
/** The struct's fields exactly as listed, in order, or false. */
const fieldsAre = (list: unknown, want: readonly (readonly [string, string])[]) =>
  Array.isArray(list) &&
  list.length === want.length &&
  list.every((f, i) => f !== null && typeof f === 'object' && keysAre(f, ['name', 'type']) && f.name === want[i]![0] && f.type === want[i]![1])

/** `all`, or the fraction as `num / den`; null for anything else. */
function fractionOf(a: PortfolioWithdrawalIntent['amount']): { num: bigint; den: bigint } | null {
  if (a.kind === 'all') return { num: 1n, den: 1n }
  const m = new RegExp(`^(0|1)(?:\\.(\\d{1,${FRACTION_PLACES}}))?$`).exec(a.value)
  if (!m) return null
  const den = 10n ** BigInt(FRACTION_PLACES)
  const num = BigInt(m[1]!) * den + BigInt((m[2] ?? '').padEnd(FRACTION_PLACES, '0'))
  return num === 0n || num > den ? null : { num, den }
}

/** Every step of a portfolio withdrawal, together: each batch's authorization, then the totals against the holdings. */
export function checkPortfolioWithdrawal(steps: readonly PortfolioStepToCheck[], intent: PortfolioWithdrawalIntent): PortfolioWithdrawalCheck {
  const whole = (reason: string) => ({ ok: false as const, step: null, reason })
  if (!isAddress(intent.owner)) return whole('the owner is not an address')
  if (!isAddress(intent.smartAccount)) return whole('the smart account is not an address')
  const ref = servedChain(intent.chain)
  if (!ref) return whole(`the chain ${JSON.stringify(intent.chain)} is not an EVM chain the API serves`)
  const settlement = assetKey(intent.settlementAssetId)
  if (!settlement) return whole('the settlement asset is not an asset id')
  const fraction = fractionOf(intent.amount)
  if (!fraction) return whole('the fraction asked for is not a decimal above 0 and at most 1')
  if (steps.length === 0) return whole('a withdrawal with no steps has nothing to check')
  // Every comparison with NaN is false, so a clock or a lifetime that is not a finite number would admit any expiry.
  if (typeof intent.now !== 'number' || !Number.isFinite(intent.now)) return whole('now is not a finite number of milliseconds')
  const lifetimeS = intent.maxLifetimeSeconds ?? DEFAULT_LIFETIME_S
  if (typeof lifetimeS !== 'number' || !Number.isFinite(lifetimeS) || lifetimeS <= 0) return whole('the longest lifetime is not a finite number of seconds above zero')
  const nowS = intent.now / MS_PER_S

  const kinds: ('transfer' | 'sale')[] = []
  const pending: number[] = []
  const totals = new Map<string, { assetId: string; amount: bigint }>()
  let earliest = Infinity

  for (const [i, s] of steps.entries()) {
    const refuse = (reason: string) => ({ ok: false as const, step: i, reason })
    const notTheForm = refuse("it is not in the form the provider's withdrawal authorization takes")
    if (s.kind !== 'sign_typed_data') return refuse(`a step of kind ${s.kind} is not a withdrawal authorization`)
    if (chainRef(s.chainId) !== ref) return refuse(`the step is on chain ${String(s.chainId)}, not ${intent.chain}`)
    if (s.payload === undefined) {
      // A batch with nothing to sign yet still counts its plan toward the totals, so checking a request in turns, as its
      // batches arrive, cannot admit more than checking it whole.
      if (s.plan !== undefined) {
        const plan = readPlan(s.plan)
        if (!plan) return refuse('its plan cannot be read')
        addTo(totals, plan)
      }
      pending.push(i)
      continue
    }
    const payload = payloadOf(s.payload, 'sign_typed_data')
    if (!payload) return refuse(`its payload is not an object of only ${PAYLOAD_FIELDS.sign_typed_data.join(', ')}`)
    // Exactly the four EIP-712 fields: anything else beside them would reach the wallet unread.
    if (!isRecord(payload.typedData) || !keysAre(payload.typedData, TYPED_DATA_FIELDS)) return notTheForm
    const a = payload.typedData as { domain?: Record<string, unknown>; types?: Record<string, unknown>; primaryType?: unknown; message?: Record<string, unknown> }
    const domain = a.domain ?? {}
    const types = a.types ?? {}
    const m = a.message ?? {}
    const sale = m['liquidate'] === true
    const shape = sale ? 'sale' : 'transfer'

    if (a.primaryType !== 'Withdrawal' || domain['name'] !== DOMAIN_NAME || domain['version'] !== (sale ? '2' : '1')) return notTheForm
    if (!keysAre(domain, DOMAIN_FIELDS.map((f) => f[0]))) return notTheForm
    if (Object.keys(types).some((t) => t !== 'Withdrawal' && t !== 'WithdrawalAsset' && t !== 'EIP712Domain')) return notTheForm
    // A domain type, if present, replaces the one the signature uses: the standard four, in EIP-712's order.
    if (types['EIP712Domain'] !== undefined && !fieldsAre(types['EIP712Domain'], DOMAIN_FIELDS)) return notTheForm
    if (!fieldsAre(types['Withdrawal'], FIELDS[shape]) || !fieldsAre(types['WithdrawalAsset'], ASSET_FIELDS)) return notTheForm
    if (!keysAre(m, FIELDS[shape].map((f) => f[0]))) return notTheForm

    if (typeof domain['chainId'] !== 'number' || String(domain['chainId']) !== ref) return refuse(`it is for chain ${String(domain['chainId'])}, not ${intent.chain}`)
    if (typeof domain['verifyingContract'] !== 'string' || !isAddress(domain['verifyingContract']) || !same(domain['verifyingContract'], intent.smartAccount)) {
      return refuse(`it would take funds from ${String(domain['verifyingContract'])}, not the smart account ${intent.smartAccount}`)
    }
    if (m['portfolioId'] !== intent.portfolioId) return refuse('it is for another portfolio')
    const to = typeof m['recipientAccountId'] === 'string' ? ACCOUNT.exec(m['recipientAccountId']) : null
    if (!to || to[1] !== ref || !isAddress(to[2]) || !same(to[2]!, intent.owner)) return refuse(`it would pay ${String(m['recipientAccountId'])}, not the owner ${intent.owner} on ${intent.chain}`)
    if (sale && assetKey(m['settlementAssetId']) !== settlement) return refuse(`it settles in ${String(m['settlementAssetId'])}, not ${intent.settlementAssetId}`)
    if (typeof m['nonce'] !== 'string' || !BYTES32.test(m['nonce'])) return notTheForm

    const raw = m['expiresAt']
    const expiry = typeof raw === 'number' ? raw : typeof raw === 'string' && DIGITS.test(raw) ? Number(raw) : NaN
    if (!Number.isSafeInteger(expiry) || expiry <= 0) return notTheForm
    if (expiry <= nowS) return refuse('it has expired')
    if (expiry > nowS + lifetimeS) return refuse(`it stays valid for more than ${lifetimeS} seconds`)
    earliest = Math.min(earliest, expiry)

    const assets = Array.isArray(m['assets']) ? (m['assets'] as unknown[]) : []
    if (assets.length === 0) return refuse('it names no asset')
    const signed = new Map<string, { assetId: string; amount: bigint }>()
    for (const x of assets) {
      if (x === null || typeof x !== 'object') return notTheForm
      const e = x as { assetId?: unknown; amountRaw?: unknown }
      const key = assetKey(e.assetId)
      if (!key || ref !== key.split(/[:/]/)[1] || typeof e.amountRaw !== 'string' || !RAW_POSITIVE.test(e.amountRaw)) {
        return refuse(`it names an asset that is not a token on ${intent.chain}, or an amount that is not a whole number of units above zero`)
      }
      if (!keysAre(e, ASSET_FIELDS.map((f) => f[0]))) return notTheForm
      if (signed.has(key)) return refuse('it names the same asset twice')
      if (!sale && key !== settlement) return refuse('it would move a holding other than the settlement asset without selling it')
      signed.set(key, { assetId: e.assetId as string, amount: BigInt(e.amountRaw) })
    }

    // The API's own plan for this batch: what it asked the provider for. The signed batch must be exactly that, both ways:
    // every planned asset signed at its amount, every signed asset planned, and no asset planned twice. A batch with no
    // plan is refused (the API attaches one to every batch; without it only the holdings bound would be left).
    {
      const plan = readPlan(s.plan)
      const matches =
        isRecord(s.plan) &&
        s.plan.liquidate === sale &&
        plan !== null &&
        plan.size === signed.size &&
        [...plan].every(([k, p]) => signed.get(k)?.amount === p.amount) &&
        [...signed.keys()].every((k) => plan.has(k))
      if (!matches) return refuse("it is not the plan the API attached to this step: another kind, another amount, an asset added or left out, or one named twice")
    }

    kinds.push(shape)
    addTo(totals, signed)
  }
  if (pending.length === steps.length) return whole('none of the withdrawal steps has anything to sign yet')

  // The bound: each asset's total over every batch, against what the caller says the smart account holds.
  const held = new Map<string, bigint>()
  for (const [id, raw] of Object.entries(intent.holdings)) {
    const k = assetKey(id)
    if (k && DIGITS.test(raw)) held.set(k, BigInt(raw))
  }
  const out: { assetId: string; amount: string; held: string }[] = []
  for (const [k, t] of totals) {
    const h = held.get(k) ?? 0n
    if (h === 0n) return whole(`the withdrawal names ${t.assetId}, which the smart account does not hold`)
    const allowed = (h * fraction.num) / fraction.den
    if (t.amount > allowed) return whole(`the withdrawal asks for ${t.amount} units of ${t.assetId}, more than ${intent.amount.kind === 'all' ? 'the account holds' : 'the fraction asked of what it holds'} (${allowed} of ${h})`)
    out.push({ assetId: t.assetId, amount: t.amount.toString(), held: h.toString() })
  }
  return { ok: true, kinds, totals: out, expiresAt: new Date((earliest === Infinity ? 0 : earliest) * MS_PER_S), pending }
}

const TRANSFER_SELECTOR = '0xa9059cbb' // transfer(address,uint256)
const TRANSFER = { [TRANSFER_SELECTOR]: ['address', 'uint'] } as const
const ENROL_PURPOSE = 'enrol'

type Amounts = Map<string, { assetId: string; amount: bigint }>
const addTo = (totals: Amounts, more: Amounts) => {
  for (const [k, v] of more) totals.set(k, { assetId: totals.get(k)?.assetId ?? v.assetId, amount: (totals.get(k)?.amount ?? 0n) + v.amount })
}
/** A batch's plan as each asset's amount, or null when it is not a list of distinct assets with whole-unit amounts. */
function readPlan(plan: unknown): Amounts | null {
  if (!isRecord(plan) || !Array.isArray(plan.assets)) return null
  const out: Amounts = new Map()
  for (const p of plan.assets as { assetId?: unknown; amountRaw?: unknown }[]) {
    const k = assetKey(p?.assetId)
    if (k === null || out.has(k) || typeof p.amountRaw !== 'string' || !DIGITS.test(p.amountRaw)) return null
    out.set(k, { assetId: p.assetId as string, amount: BigInt(p.amountRaw) })
  }
  return out
}

/** A portfolio deposit's steps: the enrol signature when there is one, then the transfer. */
export function checkPortfolioDeposit(steps: readonly PortfolioStepToCheck[], intent: PortfolioDepositIntent): PortfolioDepositCheck {
  const whole = (reason: string) => ({ ok: false as const, step: null, reason })
  const ref = servedChain(intent.chain)
  if (!ref) return whole(`the chain ${JSON.stringify(intent.chain)} is not an EVM chain the API serves`)
  if (!isAddress(intent.smartAccount)) return whole('the smart account is not an address')
  if (!isAddress(intent.tokenAddress)) return whole('the token is not an address')
  if (intent.amount !== undefined && !RAW_POSITIVE.test(intent.amount)) return whole('the amount asked for is zero or not a raw amount')

  const want: ('enrol' | 'transfer')[][] = intent.amount === undefined ? [['enrol']] : [['enrol', 'transfer'], ['transfer']]
  if (!want.some((w) => w.length === steps.length)) return whole(`a portfolio deposit${intent.amount === undefined ? ' with no amount' : ''} with ${steps.length} steps is not a shape this client admits`)
  const shape = want.find((w) => w.length === steps.length)!
  const pending: number[] = []

  for (const [i, s] of steps.entries()) {
    const refuse = (reason: string) => ({ ok: false as const, step: i, reason })
    const role = shape[i]!
    const isEnrol = s.kind === 'sign_message'
    if ((role === 'enrol') !== isEnrol) return refuse('the steps are not in the order a portfolio deposit takes: the enrol signature, then the transfer')
    if (chainRef(s.chainId) !== ref) return refuse(`the step is on chain ${String(s.chainId)}, not ${intent.chain}`)
    if (role === 'enrol') {
      if (s.purpose !== ENROL_PURPOSE) return refuse(`a signature with purpose ${String(s.purpose)} is not the enrol signature`)
      if (s.payload === undefined) {
        pending.push(i)
        continue
      }
      const enrol = payloadOf(s.payload, 'sign_message')
      if (!enrol) return refuse(`the enrol signature's payload is not an object of only ${PAYLOAD_FIELDS.sign_message.join(', ')}`)
      if (typeof enrol.bytes !== 'string' || !BYTES32.test(enrol.bytes)) return refuse('the enrol signature is not exactly 32 bytes')
      continue
    }
    if (s.kind !== 'send_transaction') return refuse(`a step of kind ${s.kind} is not the deposit transfer`)
    if (s.payload === undefined) {
      pending.push(i)
      continue
    }
    const p = payloadOf(s.payload, 'send_transaction')
    if (!p) return refuse(`the transfer's payload is not an object of only ${PAYLOAD_FIELDS.send_transaction.join(', ')}`)
    if (typeof p.to !== 'string' || typeof p.data !== 'string' || typeof p.value !== 'string') return refuse('the transfer has nothing to send')
    if (p.value !== '0') return refuse('the transfer sends value; a token transfer carries none')
    if (!isAddress(p.to) || !same(p.to, intent.tokenAddress)) return refuse("the transfer is not sent to the deposit token's contract")
    const d = decodeCall(p.data, TRANSFER)
    if (!d.ok && d.refused !== 'canonical') return refuse('the transfer is not a call to transfer(address,uint256)')
    if (!d.ok) return refuse('the calldata is not the canonical encoding of transfer')
    const [recipient, amount] = d.words as [string, bigint]
    if (!same(recipient, intent.smartAccount)) return refuse(`the transfer pays ${recipient}, not the smart account ${intent.smartAccount}`)
    if (intent.amount === undefined || amount !== BigInt(intent.amount)) return refuse("the transfer's amount is not exactly the one asked for")
  }
  return { ok: true, pending }
}
