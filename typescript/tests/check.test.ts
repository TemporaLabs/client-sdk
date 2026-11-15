// The check before signing, for a vault's steps: each step's calldata is decoded and refused unless it is exactly what
// the owner asked for, against the product's own vault record. The calldata here was encoded by an independent ABI
// encoder (viem's encodeFunctionData), so the decoder is never checked against itself.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { checkStep, checkSteps, type VaultIntent } from '../src/check'

const VAULT = '0x1111111111111111111111111111111111111111'
const ASSET = '0x2222222222222222222222222222222222222222'
const OWNER = '0x3333333333333333333333333333333333333333'
const CHAIN = 'eip155:8453'
const vault = { chain: CHAIN, vaultAddress: VAULT, assetAddress: ASSET }

const DATA = {
  approve: '0x095ea7b3000000000000000000000000111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000000000001e8480',
  approveOther: '0x095ea7b3000000000000000000000000444444444444444444444444444444444444444400000000000000000000000000000000000000000000000000000000001e8480',
  approveMax: '0x095ea7b30000000000000000000000001111111111111111111111111111111111111111ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  deposit: '0x6e553f6500000000000000000000000000000000000000000000000000000000001e84800000000000000000000000003333333333333333333333333333333333333333',
  depositOther: '0x6e553f6500000000000000000000000000000000000000000000000000000000001e84800000000000000000000000004444444444444444444444444444444444444444',
  withdraw: '0xb460af94000000000000000000000000000000000000000000000000000000000016e36000000000000000000000000033333333333333333333333333333333333333330000000000000000000000003333333333333333333333333333333333333333',
  withdrawOther: '0xb460af94000000000000000000000000000000000000000000000000000000000016e36000000000000000000000000044444444444444444444444444444444444444440000000000000000000000003333333333333333333333333333333333333333',
  redeem: '0xba08765200000000000000000000000000000000000000000000000000000000000003e800000000000000000000000033333333333333333333333333333333333333330000000000000000000000003333333333333333333333333333333333333333',
  redeemOwnerOther: '0xba08765200000000000000000000000000000000000000000000000000000000000003e800000000000000000000000033333333333333333333333333333333333333330000000000000000000000004444444444444444444444444444444444444444',
} as const

const step = (to: string, data: string, over: Record<string, unknown> = {}) => ({ kind: 'send_transaction', chainId: CHAIN, payload: { to, data, value: '0' }, ...over })
const deposit: VaultIntent = { action: 'deposit', vault, owner: OWNER, assets: '2000000' }
const withdrawAssets: VaultIntent = { action: 'withdraw', vault, owner: OWNER, amount: { kind: 'assets', raw: '1500000' } }
const redeemShares: VaultIntent = { action: 'withdraw', vault, owner: OWNER, amount: { kind: 'shares', raw: '1000' } }
const redeemAll: VaultIntent = { action: 'withdraw', vault, owner: OWNER, amount: { kind: 'all' } }
const reasonOf = (r: { ok: boolean; reason?: string }) => (r.ok ? 'ok' : r.reason)

describe('checkStep: what each vault call must be', () => {
  it('admits an exact approval of the vault on the asset, and the deposit to the owner', () => {
    expect(checkStep(step(ASSET, DATA.approve), deposit)).toEqual({ ok: true, call: 'approve' })
    expect(checkStep(step(VAULT, DATA.deposit), deposit)).toEqual({ ok: true, call: 'deposit' })
  })

  it('admits a withdrawal by assets, by shares, and of every share, each paying and owned by the owner', () => {
    expect(checkStep(step(VAULT, DATA.withdraw), withdrawAssets)).toEqual({ ok: true, call: 'withdraw' })
    expect(checkStep(step(VAULT, DATA.redeem), redeemShares)).toEqual({ ok: true, call: 'redeem' })
    expect(checkStep(step(VAULT, DATA.redeem), redeemAll)).toEqual({ ok: true, call: 'redeem' })
  })

  it('compares addresses whatever their case', () => {
    expect(checkStep(step(ASSET.toUpperCase().replace('0X', '0x'), DATA.approve), { ...deposit, owner: OWNER.toUpperCase().replace('0X', '0x') }).ok).toBe(true)
  })

  it.each([
    ['an approval of anything but the vault', step(ASSET, DATA.approveOther), deposit, /spender/],
    ['an unlimited approval', step(ASSET, DATA.approveMax), deposit, /unlimited/],
    ['an approval sent to anything but the asset', step(VAULT, DATA.approve), deposit, /sent to/],
    ['a deposit for another receiver', step(VAULT, DATA.depositOther), deposit, /receiver/],
    ['a deposit of another amount', step(VAULT, DATA.deposit), { ...deposit, assets: '2000001' }, /amount/],
    ['a deposit sent to anything but the vault', step(ASSET, DATA.deposit), deposit, /sent to/],
    ['a withdrawal paying another receiver', step(VAULT, DATA.withdrawOther), withdrawAssets, /receiver/],
    ['a withdrawal of another amount', step(VAULT, DATA.withdraw), { ...withdrawAssets, amount: { kind: 'assets', raw: '1' } }, /amount/],
    ['a redeem of another owner\'s shares', step(VAULT, DATA.redeemOwnerOther), redeemShares, /owner/],
    ['a redeem of other shares', step(VAULT, DATA.redeem), { ...redeemShares, amount: { kind: 'shares', raw: '999' } }, /shares/],
    // The amounts match (1000 and 1500000 either way), so only the kind of amount tells these apart.
    ['a redeem when assets were asked for', step(VAULT, DATA.redeem), { ...withdrawAssets, amount: { kind: 'assets', raw: '1000' } }, /given in assets/],
    ['a withdraw when shares were asked for', step(VAULT, DATA.withdraw), { ...redeemShares, amount: { kind: 'shares', raw: '1500000' } }, /given in shares/],
    ['a deposit call in a withdrawal', step(VAULT, DATA.deposit), withdrawAssets, /not .*asked/],
    ['a withdrawal call in a deposit', step(VAULT, DATA.withdraw), deposit, /not .*asked/],
  ] as const)('refuses %s', (_, s, intent, reason) => {
    expect(reasonOf(checkStep(s, intent))).toMatch(reason)
  })

  it('refuses a step that carries value, names another chain, is not a transaction, or has nothing to sign', () => {
    expect(reasonOf(checkStep(step(VAULT, DATA.deposit, { payload: { to: VAULT, data: DATA.deposit, value: '1' } }), deposit))).toMatch(/value/)
    expect(reasonOf(checkStep(step(VAULT, DATA.deposit, { chainId: 'eip155:1' }), deposit))).toMatch(/chain/)
    expect(reasonOf(checkStep(step(VAULT, DATA.deposit, { kind: 'sign_typed_data' }), deposit))).toMatch(/kind/)
    expect(reasonOf(checkStep({ kind: 'send_transaction', chainId: CHAIN }, deposit))).toMatch(/nothing to sign/)
  })

  it('refuses calldata that is not exactly the canonical encoding', () => {
    expect(reasonOf(checkStep(step(VAULT, `${DATA.deposit}00`), deposit))).toMatch(/encoding/)
    expect(reasonOf(checkStep(step(VAULT, DATA.deposit.slice(0, -2)), deposit))).toMatch(/encoding/)
    // A receiver word with a bit set above the 20 address bytes decodes to the owner in a lax decoder.
    const dirty = `${DATA.deposit.slice(0, 74)}01${DATA.deposit.slice(76)}`
    expect(reasonOf(checkStep(step(VAULT, dirty), deposit))).toMatch(/encoding/)
    expect(reasonOf(checkStep(step(VAULT, '0xdeadbeef'), deposit))).toMatch(/not a vault call/)
    expect(reasonOf(checkStep(step(VAULT, 'not hex'), deposit))).toMatch(/encoding/)
  })

  it('refuses a vault record or an owner that is not an address, rather than comparing against it', () => {
    expect(reasonOf(checkStep(step(VAULT, DATA.deposit), { ...deposit, owner: 'nobody' }))).toMatch(/owner/)
    expect(reasonOf(checkStep(step(VAULT, DATA.deposit), { ...deposit, vault: { ...vault, vaultAddress: '0x12' } }))).toMatch(/vault record/)
  })

  it('refuses an approval of 2^128 or more even when the intent asks for that amount: never unlimited', () => {
    expect(reasonOf(checkStep(step(ASSET, DATA.approveMax), { ...deposit, assets: (2n ** 256n - 1n).toString() }))).toMatch(/unlimited/)
  })

  it('refuses an intent for a zero amount, whatever the step says', () => {
    const zeroApprove = `${DATA.approve.slice(0, 74)}${'0'.repeat(64)}`
    expect(reasonOf(checkStep(step(ASSET, zeroApprove), { ...deposit, assets: '0' }))).toMatch(/zero/)
    const zeroWithdraw = `${DATA.withdraw.slice(0, 10)}${'0'.repeat(64)}${DATA.withdraw.slice(74)}`
    expect(reasonOf(checkStep(step(VAULT, zeroWithdraw), { ...withdrawAssets, amount: { kind: 'assets', raw: '0' } }))).toMatch(/zero/)
    const zeroRedeem = `${DATA.redeem.slice(0, 10)}${'0'.repeat(64)}${DATA.redeem.slice(74)}`
    expect(reasonOf(checkStep(step(VAULT, zeroRedeem), { ...redeemShares, amount: { kind: 'shares', raw: '0' } }))).toMatch(/zero/)
  })

  it('refuses an "all" withdrawal of no shares', () => {
    const none = `${DATA.redeem.slice(0, 10)}${'0'.repeat(64)}${DATA.redeem.slice(74)}`
    expect(reasonOf(checkStep(step(VAULT, none), redeemAll))).toMatch(/shares/)
  })
})

describe('checkSteps: the request as a whole', () => {
  it('admits [approve, deposit], [deposit] and one withdrawal', () => {
    expect(checkSteps([step(ASSET, DATA.approve), step(VAULT, DATA.deposit)], deposit)).toEqual({ ok: true, pending: [] })
    expect(checkSteps([step(VAULT, DATA.deposit)], deposit)).toEqual({ ok: true, pending: [] })
    expect(checkSteps([step(VAULT, DATA.withdraw)], withdrawAssets)).toEqual({ ok: true, pending: [] })
  })

  it('checks a step that has nothing to sign yet only by its kind and chain, so a waiting deposit after the approval passes', () => {
    expect(checkSteps([step(ASSET, DATA.approve), { kind: 'send_transaction', chainId: CHAIN }], deposit)).toEqual({ ok: true, pending: [1] })
  })

  it('refuses a reordered, repeated or extra step, and names it', () => {
    expect(checkSteps([step(VAULT, DATA.deposit), step(ASSET, DATA.approve)], deposit)).toMatchObject({ ok: false, step: 0 })
    expect(checkSteps([step(ASSET, DATA.approve), step(ASSET, DATA.approve)], deposit)).toMatchObject({ ok: false, step: 1 })
    expect(checkSteps([step(VAULT, DATA.withdraw), step(VAULT, DATA.withdraw)], withdrawAssets)).toMatchObject({ ok: false, step: 1 })
    expect(checkSteps([], deposit)).toMatchObject({ ok: false })
    expect(checkSteps([step(ASSET, DATA.approve), step(VAULT, DATA.depositOther)], deposit)).toMatchObject({ ok: false, step: 1, reason: expect.stringMatching(/receiver/) })
  })
})

// Steps in the shape the API returns at 0.1.2, with placeholder addresses, each as its step's payload: what a client
// receives must pass, unchanged.
describe("the API's own vault steps pass", () => {
  const fx = JSON.parse(readFileSync(join(__dirname, '..', '..', 'cases', 'vault-steps.json'), 'utf8')) as {
    vault: { chain: string; vaultAddress: string; assetAddress: string }
    owner: string
    deposit: { to: string; data: string; value: string }[]
    depositNoApprove: { to: string; data: string; value: string }[]
    withdraw: { to: string; data: string; value: string }
    redeem: { to: string; data: string; value: string }
  }
  const asStep = (payload: { to: string; data: string; value: string }) => ({ kind: 'send_transaction', chainId: fx.vault.chain, payload })
  it('a deposit with its approval, a deposit without one, a withdrawal by assets and a redeem by shares', () => {
    const intent = { action: 'deposit' as const, vault: fx.vault, owner: fx.owner, assets: '2000000' }
    expect(checkSteps(fx.deposit.map(asStep), intent)).toEqual({ ok: true, pending: [] })
    expect(checkSteps(fx.depositNoApprove.map(asStep), intent)).toEqual({ ok: true, pending: [] })
    expect(checkSteps([asStep(fx.withdraw)], { action: 'withdraw', vault: fx.vault, owner: fx.owner, amount: { kind: 'assets', raw: '1500000' } })).toEqual({ ok: true, pending: [] })
    expect(checkSteps([asStep(fx.redeem)], { action: 'withdraw', vault: fx.vault, owner: fx.owner, amount: { kind: 'shares', raw: '1000' } })).toEqual({ ok: true, pending: [] })
  })
})

describe('checkStep with the call its position takes', () => {
  it('admits the call that position takes', () => {
    expect(checkStep(step(ASSET, DATA.approve), deposit, 'approve')).toEqual({ ok: true, call: 'approve' })
    expect(checkStep(step(VAULT, DATA.deposit), deposit, 'deposit')).toEqual({ ok: true, call: 'deposit' })
  })
  it('refuses a step that is a valid call but not the one its position takes: a pending first step that turns out a deposit', () => {
    // [pending, deposit] fits [approve, deposit]; when the pending step arrives as a second deposit it is still refused.
    expect(checkSteps([{ kind: 'send_transaction', chainId: CHAIN }, step(VAULT, DATA.deposit)], deposit)).toEqual({ ok: true, pending: [0] })
    expect(reasonOf(checkStep(step(VAULT, DATA.deposit), deposit, 'approve'))).toMatch(/approve/)
  })
})

describe('the calldata decoder, byte by byte', () => {
  const OWNER_WORD = `000000000000000000000000${OWNER.slice(2)}`
  it.each([
    ['a character that is not hex', `0x6e553f6g${'0'.repeat(128)}`],
    ['an odd number of hex digits', `${DATA.deposit}0`],
    ['fewer bytes than a selector', '0x6e553f'],
    ['nothing at all', '0x'],
  ])('refuses %s as not a valid encoding', (_n, data) => {
    expect(reasonOf(checkStep(step(VAULT, data), deposit))).toBe('the calldata is not a valid encoding')
  })

  it('names the call whose encoding is not canonical', () => {
    expect(reasonOf(checkStep(step(VAULT, `${DATA.deposit}00`), deposit))).toBe('the calldata is not the canonical encoding of deposit')
    expect(reasonOf(checkStep(step(VAULT, DATA.withdraw.slice(0, -2)), withdrawAssets))).toBe('the calldata is not the canonical encoding of withdraw')
  })

  it('reads the selector whatever its case', () => {
    expect(checkStep(step(VAULT, DATA.deposit.replace('0x6e553f65', '0x6E553F65')), deposit)).toEqual({ ok: true, call: 'deposit' })
  })

  it('reads every byte of an amount word, the top one included', () => {
    const assets = 2n ** 255n + 1n
    const data = `0x6e553f65${assets.toString(16).padStart(64, '0')}${OWNER_WORD}`
    expect(checkStep(step(VAULT, data), { ...deposit, assets: assets.toString() })).toEqual({ ok: true, call: 'deposit' })
    expect(reasonOf(checkStep(step(VAULT, data), { ...deposit, assets: '1' }))).not.toBe('ok')
  })
})

describe('an intent outside the documented shape is refused, never read loosely', () => {
  const REDEEM_MANY = `0xba087652${(10n ** 30n).toString(16).padStart(64, '0')}${'0'.repeat(24)}${OWNER.slice(2)}${'0'.repeat(24)}${OWNER.slice(2)}`
  it.each([['SHARES'], ['shares '], ['Assets'], ['']])('a withdrawal amount of kind %j admits no step', (kind) => {
    const intent = { action: 'withdraw', vault, owner: OWNER, amount: { kind, raw: '1000' } } as unknown as VaultIntent
    expect(checkStep(step(VAULT, REDEEM_MANY), intent).ok).toBe(false)
    expect(checkStep(step(VAULT, DATA.withdraw), intent).ok).toBe(false)
    expect(checkSteps([step(VAULT, REDEEM_MANY)], intent).ok).toBe(false)
  })

  it.each([['Deposit'], ['withdrawal'], ['']])('an action of %j is refused, not thrown', (action) => {
    const intent = { ...deposit, action } as unknown as VaultIntent
    expect(checkStep(step(VAULT, DATA.deposit), intent).ok).toBe(false)
    expect(checkSteps([step(VAULT, DATA.deposit)], intent).ok).toBe(false)
  })

  it('a withdrawal with no amount is refused, not thrown', () => {
    const intent = { action: 'withdraw', vault, owner: OWNER } as unknown as VaultIntent
    expect(checkStep(step(VAULT, DATA.withdraw), intent).ok).toBe(false)
    expect(checkSteps([step(VAULT, DATA.withdraw)], intent).ok).toBe(false)
  })
})

describe('a vault step carries only the payload fields the API defines', () => {
  // Fields a wallet would act on if the payload were forwarded to it: an EIP-7702 authorization list, another chain,
  // gas settings, another sender. The API's send_transaction payload is generation, expiresAt, to, data and value.
  const extras = { authorizationList: [], chainId: '0x1', gas: '0x5208', maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x1', from: OWNER, nonce: '0x0', type: '0x4', accessList: [] }
  it.each(Object.entries(extras))('refuses a payload carrying %s', (key, value) => {
    const s = step(ASSET, DATA.approve)
    const extra = { ...s, payload: { ...s.payload, [key]: value } }
    expect(reasonOf(checkStep(extra, deposit))).toMatch(/payload/)
    expect(checkSteps([extra, step(VAULT, DATA.deposit)], deposit)).toMatchObject({ ok: false, step: 0, reason: expect.stringMatching(/payload/) })
  })
  it('admits the fields the API sends: generation and expiresAt beside to, data and value', () => {
    const s = step(ASSET, DATA.approve)
    expect(checkStep({ ...s, payload: { ...s.payload, generation: 1, expiresAt: '2026-11-14T00:00:00.000Z' } }, deposit)).toEqual({ ok: true, call: 'approve' })
  })
  it('refuses a payload that is not an object, and an own __proto__ key', () => {
    expect(checkStep({ kind: 'send_transaction', chainId: CHAIN, payload: 'x' as never }, deposit).ok).toBe(false)
    const s = step(ASSET, DATA.approve)
    const poisoned = { ...s, payload: JSON.parse(JSON.stringify({ ...s.payload }).replace('{', '{"__proto__":{},')) as never }
    expect(reasonOf(checkStep(poisoned, deposit))).toMatch(/payload/)
  })
})
