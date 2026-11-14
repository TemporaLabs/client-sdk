// The checks before signing for a portfolio's steps. The withdrawal authorization is the provider's EIP-712 struct in the
// shape the API returns at 0.1.2; the transfer calldata was encoded by an
// independent ABI encoder (viem's encodeFunctionData), so the decoder is never checked against itself.
import { checkPortfolioDeposit, checkPortfolioWithdrawal, type PortfolioDepositIntent, type PortfolioWithdrawalIntent } from '../src/checkPortfolio'

const OWNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const SA = '0x7777777777777777777777777777777777777777'
const OTHER = '0x4444444444444444444444444444444444444444'
const USDT_ADDR = '0x55d398326f99059fF775485246999027B3197955'
const USDT = `eip155:56/erc20:${USDT_ADDR}`
const TOKEN = 'eip155:56/erc20:0x1234567890123456789012345678901234567890'
const CHAIN = 'eip155:56'
const NOW = 1_793_977_000_000
const EXPIRES = 1_793_977_800

const TRANSFER_FIELDS = [
  { name: 'portfolioId', type: 'string' },
  { name: 'recipientAccountId', type: 'string' },
  { name: 'assets', type: 'WithdrawalAsset[]' },
  { name: 'nonce', type: 'bytes32' },
  { name: 'expiresAt', type: 'uint256' },
]
const SALE_FIELDS = [...TRANSFER_FIELDS, { name: 'liquidate', type: 'bool' }, { name: 'settlementAssetId', type: 'string' }]
const ASSET_FIELDS = [
  { name: 'assetId', type: 'string' },
  { name: 'amountRaw', type: 'string' },
]
const NONCE = `0x${'00'.repeat(32)}`

type Json = Record<string, any>
const transferAuth = (over: Json = {}, message: Json = {}): Json => ({
  domain: { name: 'Glider Withdrawal Authorization', version: '1', chainId: 56, verifyingContract: SA },
  types: { Withdrawal: TRANSFER_FIELDS, WithdrawalAsset: ASSET_FIELDS },
  primaryType: 'Withdrawal',
  message: { portfolioId: 'P1', recipientAccountId: `eip155:56:${OWNER}`, assets: [{ assetId: USDT, amountRaw: '25000000000000000000' }], nonce: NONCE, expiresAt: EXPIRES, ...message },
  ...over,
})
const saleAuth = (message: Json = {}): Json => ({
  domain: { name: 'Glider Withdrawal Authorization', version: '2', chainId: 56, verifyingContract: SA },
  types: { Withdrawal: SALE_FIELDS, WithdrawalAsset: ASSET_FIELDS },
  primaryType: 'Withdrawal',
  message: { portfolioId: 'P1', recipientAccountId: `eip155:56:${OWNER}`, assets: [{ assetId: TOKEN, amountRaw: '400' }], nonce: NONCE, expiresAt: EXPIRES, liquidate: true, settlementAssetId: USDT, ...message },
})
const planOf = (a: Json) => ({ liquidate: a.message.liquidate === true, assets: a.message.assets })
const batch = (a: Json, plan: Json = planOf(a)) => ({ kind: 'sign_typed_data', chainId: CHAIN, plan, payload: { typedData: a } })

const withdraw: PortfolioWithdrawalIntent = {
  owner: OWNER,
  smartAccount: SA,
  portfolioId: 'P1',
  chain: CHAIN,
  settlementAssetId: USDT,
  amount: { kind: 'all' },
  holdings: { [USDT]: '25000000000000000000', [TOKEN]: '400' },
  now: NOW,
}
const reasonOf = (r: { ok: boolean; reason?: string }) => (r.ok ? 'ok' : r.reason)

describe('checkPortfolioWithdrawal', () => {
  it('admits a plain transfer of the idle USDT and a sale settling in USDT, each paying the owner from the smart account', () => {
    expect(checkPortfolioWithdrawal([batch(transferAuth()), batch(saleAuth())], withdraw)).toEqual({
      ok: true,
      kinds: ['transfer', 'sale'],
      totals: [
        { assetId: USDT, amount: '25000000000000000000', held: '25000000000000000000' },
        { assetId: TOKEN, amount: '400', held: '400' },
      ],
      expiresAt: new Date(EXPIRES * 1000),
      pending: [],
    })
  })

  it('compares ids by their parsed form, so letter case does not matter', () => {
    const lower = transferAuth({}, { recipientAccountId: `eip155:56:${OWNER.toLowerCase()}`, assets: [{ assetId: USDT.toLowerCase(), amountRaw: '25000000000000000000' }] })
    expect(checkPortfolioWithdrawal([batch(lower)], withdraw).ok).toBe(true)
  })

  it.each([
    ['another primary type', transferAuth({ primaryType: 'Transfer' }), /form/],
    ['another domain name', transferAuth({ domain: { name: 'X', version: '1', chainId: 56, verifyingContract: SA } }), /form/],
    ['a sale signed as version 1', transferAuth({ domain: { name: 'Glider Withdrawal Authorization', version: '1', chainId: 56, verifyingContract: SA } }, { liquidate: true, settlementAssetId: USDT }), /form/],
    ['an extra domain field', transferAuth({ domain: { name: 'Glider Withdrawal Authorization', version: '1', chainId: 56, verifyingContract: SA, salt: NONCE } }), /form/],
    ['the struct fields reordered (same set)', transferAuth({ types: { Withdrawal: [TRANSFER_FIELDS[1], TRANSFER_FIELDS[0], ...TRANSFER_FIELDS.slice(2)], WithdrawalAsset: ASSET_FIELDS } }), /form/],
    ['the asset fields reordered', transferAuth({ types: { Withdrawal: TRANSFER_FIELDS, WithdrawalAsset: [ASSET_FIELDS[1], ASSET_FIELDS[0]] } }), /form/],
    ['a field shown but not signed', transferAuth({}, { note: 'x' }), /form/],
    ['an extra type', transferAuth({ types: { Withdrawal: TRANSFER_FIELDS, WithdrawalAsset: ASSET_FIELDS, Other: [] } }), /form/],
    ['a domain type out of the standard order', transferAuth({ types: { Withdrawal: TRANSFER_FIELDS, WithdrawalAsset: ASSET_FIELDS, EIP712Domain: [{ name: 'version', type: 'string' }, { name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }] } }), /form/],
    ['another chain', transferAuth({ domain: { name: 'Glider Withdrawal Authorization', version: '1', chainId: 1, verifyingContract: SA } }), /chain/],
    ['another debit account', transferAuth({ domain: { name: 'Glider Withdrawal Authorization', version: '1', chainId: 56, verifyingContract: OTHER } }), /smart account/],
    ['another portfolio', transferAuth({}, { portfolioId: 'P2' }), /portfolio/],
    ['another recipient', transferAuth({}, { recipientAccountId: `eip155:56:${OTHER}` }), /pay/],
    ['a recipient on another chain', transferAuth({}, { recipientAccountId: `eip155:1:${OWNER}` }), /pay/],
    ['a recipient chain with a leading zero', transferAuth({}, { recipientAccountId: `eip155:056:${OWNER}` }), /pay/],
    ['an asset chain with a leading zero', transferAuth({}, { assets: [{ assetId: `eip155:056/erc20:${USDT_ADDR}`, amountRaw: '1' }] }), /asset/],
    ['a transfer of something other than the settlement asset', transferAuth({}, { assets: [{ assetId: TOKEN, amountRaw: '1' }] }), /without selling/],
    ['an amount that is not whole units', transferAuth({}, { assets: [{ assetId: USDT, amountRaw: '1.5' }] }), /asset/],
    ['a zero amount', transferAuth({}, { assets: [{ assetId: USDT, amountRaw: '0' }] }), /asset/],
    ['the same asset twice', transferAuth({}, { assets: [{ assetId: USDT, amountRaw: '1' }, { assetId: USDT.toLowerCase(), amountRaw: '1' }] }), /twice/],
    ['an asset entry with an extra key', transferAuth({}, { assets: [{ assetId: USDT, amountRaw: '1', to: OTHER }] }), /form/],
    ['an expired authorization', transferAuth({}, { expiresAt: Math.floor(NOW / 1000) - 1 }), /expired/],
    ['an authorization valid for too long', transferAuth({}, { expiresAt: Math.floor(NOW / 1000) + 3601 }), /valid for more/],
    ['a bad nonce', transferAuth({}, { nonce: '0x01' }), /form/],
  ] as const)('refuses %s', (_, auth, reason) => {
    expect(reasonOf(checkPortfolioWithdrawal([batch(auth)], withdraw))).toMatch(reason)
  })

  it('refuses a version that does not match the kind, when everything else is that kind exactly', () => {
    const sale = saleAuth()
    expect(reasonOf(checkPortfolioWithdrawal([batch({ ...sale, domain: { ...sale.domain, version: '1' } })], withdraw))).toMatch(/form/)
    const transfer = transferAuth()
    expect(reasonOf(checkPortfolioWithdrawal([batch({ ...transfer, domain: { ...transfer.domain, version: '2' } })], withdraw))).toMatch(/form/)
  })

  it('refuses a sale settling in another asset', () => {
    expect(reasonOf(checkPortfolioWithdrawal([batch(saleAuth({ settlementAssetId: TOKEN }))], withdraw))).toMatch(/settles/)
  })

  it("holds each batch to the API's own plan: kind, every asset at exactly its amount, none added or left out", () => {
    const a = saleAuth()
    expect(reasonOf(checkPortfolioWithdrawal([batch(a, { liquidate: false, assets: a.message.assets })], withdraw))).toMatch(/plan/)
    expect(reasonOf(checkPortfolioWithdrawal([batch(a, { liquidate: true, assets: [{ assetId: TOKEN, amountRaw: '399' }] })], withdraw))).toMatch(/plan/)
    expect(reasonOf(checkPortfolioWithdrawal([batch(a, { liquidate: true, assets: [] })], withdraw))).toMatch(/plan/)
    expect(reasonOf(checkPortfolioWithdrawal([batch(a, { liquidate: true, assets: [...a.message.assets, { assetId: USDT, amountRaw: '1' }] })], withdraw))).toMatch(/plan/)
  })

  it('refuses a batch with no plan: the API attaches one to every batch, and without it only the holdings bound is left', () => {
    const a = saleAuth()
    expect(reasonOf(checkPortfolioWithdrawal([{ kind: 'sign_typed_data', chainId: CHAIN, payload: { typedData: a } }], withdraw))).toMatch(/plan/)
  })

  it('bounds the totals over every batch by the holdings passed in, and the fraction asked', () => {
    // Two batches each within the holding, together above it.
    const half = (n: string) => saleAuth({ assets: [{ assetId: TOKEN, amountRaw: n }] })
    expect(reasonOf(checkPortfolioWithdrawal([batch(half('300')), batch(half('300'))], withdraw))).toMatch(/more than/)
    expect(reasonOf(checkPortfolioWithdrawal([batch(half('300'))], { ...withdraw, amount: { kind: 'fraction', value: '0.5' } }))).toMatch(/more than/)
    expect(checkPortfolioWithdrawal([batch(half('200'))], { ...withdraw, amount: { kind: 'fraction', value: '0.5' } }).ok).toBe(true)
    // An asset the account does not hold.
    expect(reasonOf(checkPortfolioWithdrawal([batch(half('1'))], { ...withdraw, holdings: { [USDT]: '1' } }))).toMatch(/does not hold/)
  })

  it('refuses a bad intent rather than comparing against it', () => {
    for (const value of ['0', '1.5', '-0.1', 'half', '0.1234567890123456789']) {
      expect(reasonOf(checkPortfolioWithdrawal([batch(saleAuth())], { ...withdraw, amount: { kind: 'fraction', value } }))).toMatch(/fraction/)
    }
    expect(reasonOf(checkPortfolioWithdrawal([batch(saleAuth())], { ...withdraw, owner: 'nobody' }))).toMatch(/owner/)
    expect(reasonOf(checkPortfolioWithdrawal([batch(saleAuth())], { ...withdraw, chain: 'eip155:056' }))).toMatch(/chain/)
  })

  it('lists a batch with nothing to sign yet as pending, checks its kind, and refuses an empty withdrawal', () => {
    expect(checkPortfolioWithdrawal([batch(transferAuth()), { kind: 'sign_typed_data', chainId: CHAIN }], withdraw)).toMatchObject({ ok: true, pending: [1] })
    expect(checkPortfolioWithdrawal([{ kind: 'send_transaction', chainId: CHAIN }], withdraw)).toMatchObject({ ok: false, step: 0 })
    expect(checkPortfolioWithdrawal([], withdraw)).toMatchObject({ ok: false, step: null })
  })
})

const TRANSFER = '0xa9059cbb00000000000000000000000077777777777777777777777777777777777777770000000000000000000000000000000000000000000000015af1d78b58c40000'
const TRANSFER_OTHER = '0xa9059cbb00000000000000000000000044444444444444444444444444444444444444440000000000000000000000000000000000000000000000015af1d78b58c40000'
const ENROL = { kind: 'sign_message', chainId: CHAIN, purpose: 'enrol', payload: { bytes: `0x${'ab'.repeat(32)}` } }
const send = (to: string, data: string, over: Json = {}) => ({ kind: 'send_transaction', chainId: CHAIN, payload: { to, data, value: '0' }, ...over })
const deposit: PortfolioDepositIntent = { chain: CHAIN, tokenAddress: USDT_ADDR, smartAccount: SA, amount: '25000000000000000000' }

describe('checkPortfolioDeposit', () => {
  it('admits [enrol, transfer] and [transfer]: a 32-byte enrol hash, then exactly transfer(smart account, amount) on the token', () => {
    expect(checkPortfolioDeposit([ENROL, send(USDT_ADDR, TRANSFER)], deposit)).toEqual({ ok: true, pending: [] })
    expect(checkPortfolioDeposit([send(USDT_ADDR, TRANSFER)], deposit)).toEqual({ ok: true, pending: [] })
    // The transfer waits on the enrol: it has nothing to send yet.
    expect(checkPortfolioDeposit([ENROL, { kind: 'send_transaction', chainId: CHAIN }], deposit)).toEqual({ ok: true, pending: [1] })
  })

  it.each([
    ['a transfer to anything but the smart account', [send(USDT_ADDR, TRANSFER_OTHER)], /smart account/],
    ['a transfer of another amount', [send(USDT_ADDR, TRANSFER)], /amount/, { amount: '1' }],
    ['a transfer on another token contract', [send(OTHER, TRANSFER)], /token/],
    ['a transfer carrying value', [send(USDT_ADDR, TRANSFER, { payload: { to: USDT_ADDR, data: TRANSFER, value: '1' } })], /value/],
    ['a transfer on another chain', [send(USDT_ADDR, TRANSFER, { chainId: 'eip155:1' })], /chain/],
    ['trailing calldata', [send(USDT_ADDR, `${TRANSFER}00`)], /encoding/],
    ['a dirty address word', [send(USDT_ADDR, `${TRANSFER.slice(0, 10)}01${TRANSFER.slice(12)}`)], /encoding/],
    ['another function', [send(USDT_ADDR, `0x095ea7b3${TRANSFER.slice(10)}`)], /transfer/],
    ['an enrol hash that is not 32 bytes', [{ ...ENROL, payload: { bytes: '0xabcd' } }, send(USDT_ADDR, TRANSFER)], /32 bytes/],
    ['an enrol step with another purpose', [{ ...ENROL, purpose: 'approve' }, send(USDT_ADDR, TRANSFER)], /enrol/],
    ['an enrol step on another chain', [{ ...ENROL, chainId: 'eip155:1' }, send(USDT_ADDR, TRANSFER)], /chain/],
    ['an enrol step after the transfer', [send(USDT_ADDR, TRANSFER), ENROL], /order/],
    ['two transfers', [send(USDT_ADDR, TRANSFER), send(USDT_ADDR, TRANSFER)], /order|steps/],
    ['no steps', [], /steps/],
  ] as const)('refuses %s', (_, steps, reason, over: Json = {}) => {
    expect(reasonOf(checkPortfolioDeposit(steps as never, { ...deposit, ...over }))).toMatch(reason)
  })

  it('admits an enrol-only request when no amount was asked, and nothing else then', () => {
    const { amount: _none, ...enrolOnly } = deposit
    expect(checkPortfolioDeposit([ENROL], enrolOnly)).toEqual({ ok: true, pending: [] })
    expect(reasonOf(checkPortfolioDeposit([ENROL, send(USDT_ADDR, TRANSFER)], enrolOnly))).toMatch(/steps/)
  })

  it('refuses an intent for a zero amount or a smart account that is not an address', () => {
    expect(reasonOf(checkPortfolioDeposit([send(USDT_ADDR, TRANSFER)], { ...deposit, amount: '0' }))).toMatch(/zero/)
    expect(reasonOf(checkPortfolioDeposit([send(USDT_ADDR, TRANSFER)], { ...deposit, smartAccount: '0x12' }))).toMatch(/smart account/)
  })
})

describe('checkPortfolioWithdrawal: the plan matches the signed batch both ways', () => {
  const both = { ...withdraw, holdings: { [USDT]: '1000', [TOKEN]: '400' } }
  const signed = saleAuth({ assets: [{ assetId: TOKEN, amountRaw: '400' }, { assetId: USDT, amountRaw: '1000' }] })
  it('admits a plan that names exactly the signed assets', () => {
    expect(checkPortfolioWithdrawal([batch(signed)], both).ok).toBe(true)
  })
  it('refuses a plan that names one asset twice, so the counts agree while a signed asset is never planned', () => {
    const plan = { liquidate: true, assets: [{ assetId: TOKEN, amountRaw: '400' }, { assetId: TOKEN, amountRaw: '400' }] }
    expect(reasonOf(checkPortfolioWithdrawal([batch(signed, plan)], both))).toMatch(/plan/)
  })
  it('refuses a plan that names the signed asset twice at the same amount, which would collapse to one entry', () => {
    const one = saleAuth()
    const plan = { liquidate: true, assets: [{ assetId: TOKEN, amountRaw: '400' }, { assetId: TOKEN, amountRaw: '400' }] }
    expect(reasonOf(checkPortfolioWithdrawal([batch(one, plan)], withdraw))).toMatch(/plan/)
  })
  it('treats the same asset in another letter case as a repeat', () => {
    const plan = { liquidate: true, assets: [{ assetId: USDT, amountRaw: '1000' }, { assetId: USDT.toLowerCase(), amountRaw: '1000' }] }
    expect(reasonOf(checkPortfolioWithdrawal([batch(signed, plan)], both))).toMatch(/plan/)
  })
})

describe('checkPortfolioWithdrawal: the clock and the lifetime must be numbers it can compare', () => {
  it.each([
    ['now is NaN', { now: Number.NaN }],
    ['now is missing', { now: undefined }],
    ['now is Infinity', { now: Number.POSITIVE_INFINITY }],
    ['the lifetime is NaN', { maxLifetimeSeconds: Number.NaN }],
    ['the lifetime is Infinity', { maxLifetimeSeconds: Number.POSITIVE_INFINITY }],
    ['the lifetime is zero', { maxLifetimeSeconds: 0 }],
    ['the lifetime is negative', { maxLifetimeSeconds: -1 }],
  ])('refuses the request as a whole when %s', (_, over) => {
    const r = checkPortfolioWithdrawal([batch(saleAuth())], { ...withdraw, ...(over as object) } as PortfolioWithdrawalIntent)
    expect(r).toMatchObject({ ok: false, step: null })
    expect(reasonOf(r)).toMatch(/now|lifetime/)
  })
  it('still refuses an expiry long past the lifetime, and one already passed', () => {
    expect(reasonOf(checkPortfolioWithdrawal([batch(saleAuth({ expiresAt: 9_000_000_000 }))], withdraw))).toMatch(/more than/)
    expect(reasonOf(checkPortfolioWithdrawal([batch(saleAuth({ expiresAt: 1 }))], withdraw))).toMatch(/expired/)
  })
})

describe('the transfer decoder, byte by byte', () => {
  it('refuses a transfer whose words are not hex, as not a call to transfer', () => {
    const data = `${TRANSFER.slice(0, 74)}${'g'.repeat(64)}`
    expect(reasonOf(checkPortfolioDeposit([send(USDT_ADDR, data)], deposit))).toBe('the transfer is not a call to transfer(address,uint256)')
  })

  it('refuses another call to the token, as not a call to transfer', () => {
    const approve = TRANSFER.replace('0xa9059cbb', '0x095ea7b3')
    expect(reasonOf(checkPortfolioDeposit([send(USDT_ADDR, approve)], deposit))).toBe('the transfer is not a call to transfer(address,uint256)')
  })

  it('reads the selector whatever its case', () => {
    expect(checkPortfolioDeposit([send(USDT_ADDR, TRANSFER.replace('0xa9059cbb', '0xA9059CBB'))], deposit)).toEqual({ ok: true, pending: [] })
  })
})

describe('a withdrawal batch counts toward the totals whatever its state', () => {
  const half = (n: string) => saleAuth({ assets: [{ assetId: TOKEN, amountRaw: n }] })
  const halfOf400 = { ...withdraw, amount: { kind: 'fraction' as const, value: '0.5' } }
  const pendingWithPlan = (n: string) => ({ kind: 'sign_typed_data', chainId: CHAIN, plan: { liquidate: true, assets: [{ assetId: TOKEN, amountRaw: n }] } })

  it('a batch with no payload yet still counts its plan, so two halves are refused in either order', () => {
    expect(checkPortfolioWithdrawal([batch(half('200')), batch(half('200'))], halfOf400).ok).toBe(false)
    expect(checkPortfolioWithdrawal([pendingWithPlan('200'), batch(half('200'))], halfOf400).ok).toBe(false)
    expect(checkPortfolioWithdrawal([batch(half('200')), pendingWithPlan('200')], halfOf400).ok).toBe(false)
    expect(checkPortfolioWithdrawal([pendingWithPlan('100'), batch(half('100'))], halfOf400)).toMatchObject({ ok: true, pending: [0] })
  })

  it('a pending batch whose plan cannot be read is refused', () => {
    const unreadable = { kind: 'sign_typed_data', chainId: CHAIN, plan: { liquidate: true, assets: [{ assetId: 'nope', amountRaw: '1' }] } }
    expect(checkPortfolioWithdrawal([unreadable, batch(half('100'))], halfOf400).ok).toBe(false)
  })

  it('a withdrawal with nothing to sign yet is not ok', () => {
    expect(checkPortfolioWithdrawal([{ kind: 'sign_typed_data', chainId: CHAIN }], withdraw)).toMatchObject({ ok: false, step: null })
    expect(checkPortfolioWithdrawal([pendingWithPlan('1')], withdraw)).toMatchObject({ ok: false, step: null })
  })
})

describe('a portfolio step carries only the payload fields the API defines', () => {
  const extras = { authorizationList: [], chainId: '0x38', gas: '0x5208', maxFeePerGas: '0x1', from: OWNER, nonce: '0x0' }
  it.each(Object.entries(extras))('refuses a deposit transfer whose payload carries %s', (key, value) => {
    const t = send(USDT_ADDR, TRANSFER)
    expect(checkPortfolioDeposit([{ ...t, payload: { ...t.payload, [key]: value } }], deposit)).toMatchObject({ ok: false, step: 0, reason: expect.stringMatching(/payload/) })
  })
  it('refuses an enrol signature whose payload carries anything beside generation, expiresAt and bytes', () => {
    expect(checkPortfolioDeposit([{ ...ENROL, payload: { ...ENROL.payload, to: OTHER } }, send(USDT_ADDR, TRANSFER)], deposit)).toMatchObject({ ok: false, step: 0, reason: expect.stringMatching(/payload/) })
  })
  it('admits generation and expiresAt beside the fields each kind reads', () => {
    const g = { generation: 1, expiresAt: '2026-11-14T00:00:00.000Z' }
    const t = send(USDT_ADDR, TRANSFER)
    expect(checkPortfolioDeposit([{ ...ENROL, payload: { ...ENROL.payload, ...g } }, { ...t, payload: { ...t.payload, ...g } }], deposit)).toEqual({ ok: true, pending: [] })
    const b = batch(saleAuth())
    expect(checkPortfolioWithdrawal([{ ...b, payload: { ...b.payload, ...g } }], withdraw).ok).toBe(true)
  })
  it.each([['gas', '0x5208'], ['to', OTHER]])('refuses a withdrawal batch whose payload carries %s', (key, value) => {
    const b = batch(saleAuth())
    expect(checkPortfolioWithdrawal([{ ...b, payload: { ...b.payload, [key]: value } }], withdraw)).toMatchObject({ ok: false, step: 0, reason: expect.stringMatching(/payload/) })
  })
  it.each([['salt'], ['signature'], ['account']])('refuses typed data with a top-level %s beside domain, types, primaryType and message', (key) => {
    const a = saleAuth()
    expect(checkPortfolioWithdrawal([batch({ ...a, [key]: '0x00' })], withdraw)).toMatchObject({ ok: false, step: 0 })
  })
})
