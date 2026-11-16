/**
 * EVM facts the step checks share: which chains a step may be on, and what counts as an address.
 *
 * The checks may be stricter than the API, never looser: a chain the API does not serve, or an address whose
 * mixed-case checksum is wrong, is refused before anything reaches a wallet.
 */

/**
 * The EVM chains the API serves (`GET /v1/chains`, API 0.1.3), by chain id. A step or a vault on any other chain is
 * refused. A chain the API adds later is refused until a client release adds it here: stricter, never looser.
 * Frozen, so a caller cannot widen the list at run time, a cast included.
 */
export const SERVED_CHAINS: readonly string[] = Object.freeze(['1', '56', '143', '4663', '8453', '42161'])

const CHAIN = /^eip155:([1-9][0-9]*)$/

/** The chain id of an `eip155:<id>` chain the API serves, or null for any other value. */
export function servedChain(value: unknown): string | null {
  const m = typeof value === 'string' ? CHAIN.exec(value) : null
  return m && SERVED_CHAINS.includes(m[1]!) ? m[1]! : null
}

const ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/

/**
 * Whether `value` is an address: `0x` and 40 hex digits, all lower case, all upper case, or mixed case with a correct
 * EIP-55 checksum. A mixed-case address with a wrong checksum is most likely mistyped, and is refused.
 */
export function isAddress(value: unknown): value is string {
  if (typeof value !== 'string' || !ADDRESS_SHAPE.test(value)) return false
  const hex = value.slice(2)
  if (hex === hex.toLowerCase() || hex === hex.toUpperCase()) return true
  return value === toChecksum(hex)
}

/** The EIP-55 form of 40 hex digits. */
export function toChecksum(hex: string): string {
  const lower = hex.toLowerCase()
  const hash = keccak256(new TextEncoder().encode(lower))
  let out = '0x'
  for (let i = 0; i < lower.length; i++) {
    const nibble = (hash[i >> 1]! >> (i % 2 === 0 ? 4 : 0)) & 0xf
    out += nibble >= 8 ? lower[i]!.toUpperCase() : lower[i]!
  }
  return out
}

// Keccak-256 (the original Keccak padding, as Ethereum uses; not SHA3-256), over 64-bit lanes held as BigInt.
const MASK = (1n << 64n) - 1n
const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
]
const ROTATIONS = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14]
const RATE = 136

const rotl = (x: bigint, n: number) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK)

function permute(s: bigint[]): void {
  for (const rc of ROUND_CONSTANTS) {
    const c = [0, 1, 2, 3, 4].map((x) => s[x]! ^ s[x + 5]! ^ s[x + 10]! ^ s[x + 15]! ^ s[x + 20]!)
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5]! ^ rotl(c[(x + 1) % 5]!, 1)
      for (let y = 0; y < 25; y += 5) s[y + x] = s[y + x]! ^ d
    }
    const b: bigint[] = new Array(25)
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y]!, ROTATIONS[x + 5 * y]!)
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) s[x + 5 * y] = b[x + 5 * y]! ^ (~b[((x + 1) % 5) + 5 * y]! & MASK & b[((x + 2) % 5) + 5 * y]!)
    s[0] = s[0]! ^ rc
  }
}

/** Keccak-256 of `data`, as 32 bytes. */
export function keccak256(data: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.ceil((data.length + 1) / RATE) * RATE)
  padded.set(data)
  padded[data.length] = padded[data.length]! ^ 0x01
  padded[padded.length - 1] = padded[padded.length - 1]! ^ 0x80
  const s: bigint[] = new Array(25).fill(0n)
  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n
      for (let j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + j]!)
      s[i] = s[i]! ^ lane
    }
    permute(s)
  }
  const out = new Uint8Array(32)
  for (let i = 0; i < 4; i++) for (let j = 0; j < 8; j++) out[i * 8 + j] = Number((s[i]! >> BigInt(8 * j)) & 0xffn)
  return out
}
