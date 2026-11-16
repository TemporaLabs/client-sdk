/** Hand decoding of contract calldata against a fixed list of calls. It refuses anything that is not exactly one of them, rather than guessing. */

/** A 32-byte argument word: an address (20 bytes, the rest zero) or a uint256. */
export type Word = 'address' | 'uint'

const SELECTOR_HEX = 8
const WORD_HEX = 64
const ADDRESS_HEX = 40
// Lower-case hex only: calldata the API prepares is lower case, and any other spelling is not that calldata.
const HEX_BYTES = /^0x([0-9a-f]{2})*$/

/**
 * The call's selector (lower case) and its argument words, or why not:
 * `encoding` — not whole lower-case hex bytes with a selector; `selector` — a selector not in `calls`;
 * `canonical` — a known selector whose arguments are not exactly their canonical encoding (a wrong length, or bits set
 * above an address's 20 bytes).
 */
export function decodeCall(
  data: string,
  calls: Readonly<Record<string, readonly Word[]>>,
): { ok: true; selector: string; words: (bigint | string)[] } | { ok: false; refused: 'encoding' | 'selector' | 'canonical'; selector?: string } {
  if (!HEX_BYTES.test(data) || data.length < 2 + SELECTOR_HEX) return { ok: false, refused: 'encoding' }
  const selector = data.slice(0, 2 + SELECTOR_HEX)
  const args = calls[selector]
  if (!args) return { ok: false, refused: 'selector', selector }
  const body = data.slice(2 + SELECTOR_HEX)
  if (body.length !== args.length * WORD_HEX) return { ok: false, refused: 'canonical', selector }
  const words: (bigint | string)[] = []
  for (let i = 0; i < args.length; i++) {
    const word = body.slice(i * WORD_HEX, (i + 1) * WORD_HEX)
    if (args[i] === 'address') {
      if (!/^0+$/.test(word.slice(0, WORD_HEX - ADDRESS_HEX))) return { ok: false, refused: 'canonical', selector }
      words.push(`0x${word.slice(WORD_HEX - ADDRESS_HEX)}`)
    } else {
      words.push(BigInt(`0x${word}`))
    }
  }
  return { ok: true, selector, words }
}
