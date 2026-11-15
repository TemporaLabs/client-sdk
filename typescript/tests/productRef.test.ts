// A vault answers with its share ticker, and a product can be named four ways: its id, its share ticker, its vault
// address, or that address with its chain (CAIP-10). These pin both, as the API document describes them.
import { check } from '../src/internal'
import { createClient } from '../src/index'

const ADDRESS = '0x' + 'aB'.repeat(20)
const ref = (name: string) => ({ $ref: `#/$defs/${name}` })
const VAULT = { standard: 'erc4626', shareSymbol: 'tlExampleUSDC', chain: 'eip155:8453', vaultAddress: ADDRESS, assetAddress: ADDRESS, assetDecimals: 6, shareDecimals: 18 }

describe('a vault product', () => {
  it("carries its share ticker, and an answer without one does not match the vault's shape", () => {
    expect(check(ref('VaultIdentity'), VAULT)).toMatchObject({ success: true, data: { shareSymbol: 'tlExampleUSDC' } })
    const { shareSymbol: _, ...without } = VAULT
    expect(check(ref('VaultIdentity'), without).success).toBe(false)
  })
})

describe('a product reference', () => {
  it.each([['example-product'], ['tlExampleUSDC'], [ADDRESS], [`eip155:8453:${ADDRESS}`]])('admits %s', (id) => {
    expect(check(ref('ProductRef'), id).success).toBe(true)
  })
  it.each([['Example Product'], ['Example-Product'], ['eip155:8453:0x12'], ['']])('refuses %j', (id) => {
    expect(check(ref('ProductRef'), id).success).toBe(false)
  })

  it('is sent in the path, encoded, for each of the four forms', async () => {
    const urls: string[] = []
    const fetch = (async (url: URL) => {
      urls.push(String(url))
      return new Response(null, { status: 404 })
    }) as unknown as typeof globalThis.fetch
    const client = createClient({ baseUrl: 'https://api.example', fetch })
    for (const id of ['example-product', 'tlExampleUSDC', ADDRESS, `eip155:8453:${ADDRESS}`]) await client.product({ path: { id } })
    expect(urls).toEqual([
      'https://api.example/v1/products/example-product',
      'https://api.example/v1/products/tlExampleUSDC',
      `https://api.example/v1/products/${ADDRESS}`,
      `https://api.example/v1/products/eip155%3A8453%3A${ADDRESS}`,
    ])
  })
})
