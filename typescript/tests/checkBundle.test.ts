import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BUNDLE_FIELDS, checkBundle, type BundleToCheck, type VaultOnChain } from '../src/check'

// A vault deposit's steps offered as one wallet_sendCalls batch, from cases/vault-bundle.json, which the Python tests
// read too: the batch must be exactly the checked steps, from the owner, on the vault's chain, all-or-nothing.
const fx = JSON.parse(readFileSync(join(__dirname, '..', '..', 'cases', 'vault-bundle.json'), 'utf8')) as {
  vault: VaultOnChain
  owner: string
  assets: string
  cases: { case: string; admit: boolean; reason?: string; request: BundleToCheck }[]
}
const deposit = { action: 'deposit' as const, vault: fx.vault, owner: fx.owner, assets: fx.assets }

describe('checkBundle', () => {
  it.each(fx.cases.map((c) => [c.case, c] as const))('%s', (_name, c) => {
    expect(checkBundle(c.request, deposit)).toEqual(c.admit ? { ok: true } : { ok: false, reason: c.reason })
  })
  it('refuses a bundle for a withdrawal', () => {
    const admitted = fx.cases.find((c) => c.admit)!.request
    const r = checkBundle(admitted, { action: 'withdraw', vault: fx.vault, owner: fx.owner, amount: { kind: 'all' } })
    expect(r).toEqual({ ok: false, reason: 'a bundle is offered only for a deposit' })
  })
  it('refuses a bundle for an amount other than the one asked for', () => {
    const admitted = fx.cases.find((c) => c.admit)!.request
    expect(checkBundle(admitted, { ...deposit, assets: '2000001' }).ok).toBe(false)
  })
  it('keeps its field lists read-only', () => {
    expect(Object.isFrozen(BUNDLE_FIELDS)).toBe(true)
    expect(Object.isFrozen(BUNDLE_FIELDS.sendCalls)).toBe(true)
    expect(() => (BUNDLE_FIELDS.sendCalls as unknown as string[]).push('capabilities')).toThrow()
  })
})
