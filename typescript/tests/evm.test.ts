// Keccak-256 and the EIP-55 address checksum the step checks rely on, against published vectors and an independent
// implementation's output (viem's keccak256) across the 136-byte block boundary.
import { isAddress, keccak256, servedChain, SERVED_CHAINS, toChecksum } from '../src/evm'

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

describe('keccak256', () => {
  it('gives the published digests', () => {
    expect(hex(keccak256(new Uint8Array()))).toBe('c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470')
    expect(hex(keccak256(new TextEncoder().encode('abc')))).toBe('4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45')
  })
  it.each([
    [135, '34367dc248bbd832f4e3e69dfaac2f92638bd0bbd18f2912ba4ef454919cf446'],
    [136, 'a6c4d403279fe3e0af03729caada8374b5ca54d8065329a3ebcaeb4b60aa386e'],
    [137, 'd869f639c7046b4929fc92a4d988a8b22c55fbadb802c0c66ebcd484f1915f39'],
    [200, '96ea54061def936c4be90b518992fdc6f12f535068a256229aca54267b4d084d'],
    [272, 'cf7fcd4f705ee749930d19ca84561a9bf62516bd90a471545fa2f49fdc7e63c8'],
    [1000, 'b6a4ac1f51884d71f30fa397a5e155de3099e11fc0edef5d08b646e621e19de9'],
  ])('agrees with an independent implementation on %i bytes of "a"', (n, want) => {
    expect(hex(keccak256(new Uint8Array(n).fill(0x61)))).toBe(want)
  })
})

describe('EIP-55', () => {
  // The examples in EIP-55 itself.
  const VECTORS = [
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
  ]
  it.each(VECTORS)('checksums %s as EIP-55 does, and admits it', (a) => {
    expect(toChecksum(a.slice(2).toLowerCase())).toBe(a)
    expect(isAddress(a)).toBe(true)
  })
  it.each(VECTORS)('admits %s in all lower and all upper case', (a) => {
    expect(isAddress(a.toLowerCase())).toBe(true)
    expect(isAddress('0x' + a.slice(2).toUpperCase())).toBe(true)
  })
  it.each(VECTORS)('refuses %s with any one letter in the wrong case', (a) => {
    for (let i = 2; i < a.length; i++) {
      const c = a[i]!
      if (c.toLowerCase() === c.toUpperCase()) continue
      const flipped = a.slice(0, i) + (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()) + a.slice(i + 1)
      if (flipped.slice(2) === flipped.slice(2).toLowerCase() || flipped.slice(2) === flipped.slice(2).toUpperCase()) continue
      expect(isAddress(flipped)).toBe(false)
    }
  })
  it.each([null, 7, '', '0x', '0X5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', '5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', '0x5aaeb6053f3e94c9b9a09f33669435e7ef1bea', '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaedd', '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaeg'])('refuses %j', (v) => {
    expect(isAddress(v)).toBe(false)
  })
})

describe('servedChain', () => {
  it('cannot be widened at run time, a cast included', () => {
    expect(Object.isFrozen(SERVED_CHAINS)).toBe(true)
    expect(() => (SERVED_CHAINS as string[]).push('999')).toThrow(TypeError)
    expect(servedChain('eip155:999')).toBeNull()
  })
  it.each(SERVED_CHAINS)('reads eip155:%s', (id) => expect(servedChain(`eip155:${id}`)).toBe(id))
  it.each(['eip155:999999999', 'eip155:08453', 'eip155:0', 'eip155:', 'eip155', 'solana:mainnet', 'garbage', ' eip155:8453', 'eip155:8453\n', 8453, null])('refuses %j', (v) => {
    expect(servedChain(v)).toBeNull()
  })
})
