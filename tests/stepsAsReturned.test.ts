// The checks take a request's steps exactly as the client returns them: `request.steps`, typed as the exported `Step`,
// with no cast. This file is part of the typecheck (`npm run typecheck`), so a check that does not accept `Step` fails
// it. At run time a step of a kind a check does not take is refused, as before.
import { checkPortfolioDeposit, checkPortfolioWithdrawal, checkStep, checkSteps, type Step, type VaultIntent } from '../src/index'

const CHAIN = 'eip155:8453'
const VAULT = '0x5555555555555555555555555555555555555555'
const ASSET = '0x6666666666666666666666666666666666666666'
const OWNER = '0x00000000000000000000000000000000000000a1'
const APPROVE = '0x095ea7b3000000000000000000000000555555555555555555555555555555555555555500000000000000000000000000000000000000000000000000000000001e8480'
const DEPOSIT = '0x6e553f6500000000000000000000000000000000000000000000000000000000001e848000000000000000000000000000000000000000000000000000000000000000a1'
const generation = { generation: 1, expiresAt: '2026-11-14T00:10:00.000Z' }

const tx = (stepId: string, purpose: string, to: string, data: string): Step => ({
  stepId,
  chainId: CHAIN,
  state: 'ready',
  checks: [],
  kind: 'send_transaction',
  purpose,
  payload: { ...generation, to, data, value: '0' },
})
const intent: VaultIntent = { action: 'deposit', vault: { chain: CHAIN, vaultAddress: VAULT, assetAddress: ASSET }, owner: OWNER, assets: '2000000' }

describe('the checks take request.steps as the client types them', () => {
  it('checkSteps and checkStep admit a vault deposit typed as Step[]', () => {
    const steps: readonly Step[] = [tx('s1', 'approve', ASSET, APPROVE), tx('s2', 'deposit', VAULT, DEPOSIT)]
    expect(checkSteps(steps, intent)).toEqual({ ok: true, pending: [] })
    expect(checkStep(steps[0]!, intent, 'approve')).toEqual({ ok: true, call: 'approve' })
  })

  it('a step of another kind still compiles, and is refused at run time', () => {
    const solana: Step = { stepId: 's1', chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', state: 'ready', checks: [], kind: 'send_solana_transaction', payload: { ...generation, transaction: 'AA==' } }
    const later: Step = { stepId: 's2', kind: 'sign_with_passkey', state: 'ready' }
    expect(checkSteps([solana], intent)).toMatchObject({ ok: false, step: 0 })
    expect(checkStep(later, intent)).toMatchObject({ ok: false })
    expect(checkPortfolioDeposit([solana], { chain: CHAIN, tokenAddress: ASSET, smartAccount: VAULT, amount: '1' })).toMatchObject({ ok: false })
    expect(checkPortfolioWithdrawal([later], { owner: OWNER, smartAccount: VAULT, portfolioId: 'P1', chain: CHAIN, settlementAssetId: `${CHAIN}/erc20:${ASSET}`, amount: { kind: 'all' }, holdings: {}, now: 0 })).toMatchObject({ ok: false })
  })
})
