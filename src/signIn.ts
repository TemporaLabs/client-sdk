/** The owner sign-in as one call, and a wrapper that signs in again once when an owner call is refused for it. */
import type { ApiError } from './generated/types'
import type { Client } from './index'
import type { OutputOf, Result } from './internal'

/** What a sign-in returns: the owner token and when it stops working. */
export type SignedIn = OutputOf<'sign_in_verify'>

export type SignInOptions = {
  /** The wallet address that signs in. */
  owner: string
  /** Sent with the challenge request when given (a URI). */
  origin?: string
  /**
   * Has the owner sign `message` with their own wallet and returns the signature. The client never sees a wallet or a
   * key: this is the only place the owner signs. A rejection is a failed sign-in, not a throw.
   */
  signMessage: (message: string) => Promise<string>
  /**
   * Called with the challenge text before anything is signed. Return `true` (or a promise of `true`) to go on. Any other
   * value, nothing included, or a throw refuses it: no signature is asked for and nothing is verified.
   */
  check?: (message: string) => boolean | Promise<boolean>
  /**
   * Where the token works: `http` (the API's HTTP routes, and the default when this is left out), `mcp` (the API's MCP
   * endpoint) or `both`. Ask for `mcp` for a token used through `createMcpClient`, and `both` only when one process
   * calls both. A token is refused where it was not made to work, as `wallet_proof_required`.
   */
  audience?: 'http' | 'mcp' | 'both'
}

const failed = (code: string, message: string, outcome: 'failed' | 'unknown' = 'failed'): Result<never> => ({ ok: false, status: 0, error: { code, message, outcome } as ApiError })
const reason = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'no reason was given')

/**
 * Runs the sign-in: asks for a challenge, has the owner sign it, verifies it. The answer is a `Result` and nothing is
 * thrown. An error from either call comes back unchanged; the three that are this function's own are
 * `challenge_refused` (the `check` said no), `signing_failed` (the owner did not sign) and `unsupported_token_type`
 * (the token is not a Bearer token, which is the only kind the client sends). Each of the three means nothing was
 * verified, and each carries `status: 0`, which is not an HTTP status: the call never reached the API. It reads the
 * challenge text only to pass it to `check` and `signMessage`.
 */
export async function signIn(client: Pick<Client, 'sign_in_challenge' | 'sign_in_verify'>, options: SignInOptions): Promise<Result<SignedIn>> {
  const { owner, origin, signMessage, check, audience } = options
  const challenge = await client.sign_in_challenge({ body: { owner, ...(origin !== undefined ? { origin } : {}) } })
  if (!challenge.ok) return challenge
  const { message, nonce } = challenge.body
  if (check) {
    let verdict: unknown
    try {
      verdict = await check(message)
    } catch (e) {
      return failed('challenge_refused', `The sign-in challenge was refused before signing: ${reason(e)}. Nothing was signed.`)
    }
    // Only `true` goes on: a check that forgets to return, or returns a match (null on a mismatch), refuses.
    if (verdict !== true) return failed('challenge_refused', 'The sign-in challenge was refused before signing. Nothing was signed.')
  }
  let signature: string
  try {
    signature = await signMessage(message)
  } catch (e) {
    return failed('signing_failed', `The owner did not sign the challenge: ${reason(e)}. Nothing was verified.`)
  }
  const verified = await client.sign_in_verify({ body: { owner, nonce, signature, ...(audience !== undefined ? { audience } : {}) } })
  if (!verified.ok) return verified
  // The client sends every owner token as Bearer, so a token of another type could not be used.
  if (verified.body.tokenType !== 'Bearer') return failed('unsupported_token_type', `The token type ${JSON.stringify(verified.body.tokenType)} is not Bearer, the only kind this client sends. The token was not kept.`)
  return verified
}

export type OwnerRetry = {
  /** The token in hand, if any. Without one, the wrapper signs in before the first call. */
  token?: string
  /** Signs in and returns the new token, for example `() => signIn(client, options)`. */
  signIn: () => Promise<Result<SignedIn>>
  /** Called with each new sign-in, so the caller can keep the token. */
  onSignIn?: (signedIn: SignedIn) => void
}

/**
 * Runs one owner call with a token, and when the answer is `wallet_proof_required`, signs in once more and runs it
 * once more. That code means the token was missing, unknown, expired, signed out or not this caller's, and the call was
 * not run, so repeating it cannot do a write twice. It never repeats a call for any other answer (signing in again does
 * not fix a bad client key or a malformed header), never after an `unknown` outcome (a write that may have gone
 * through), and never a third time: the second answer is returned as it is. A token it has just obtained is not
 * replaced, so a call refused with a fresh token is not retried. A failed sign-in comes back as the result.
 *
 * It does not throw for what the caller's functions do: a throw from `signIn`, `onSignIn` or `call` comes back as a
 * `callback_failed` result. That result is `unknown` when `call` threw (it may have been sent) and `failed` otherwise.
 * Two calls that each meet `wallet_proof_required` at the same moment each sign in; share one sign-in yourself if the
 * owner must not be asked twice.
 */
export async function withOwnerRetry<T>(retry: OwnerRetry, call: (token: string) => Promise<Result<T>>): Promise<Result<T>> {
  let token = retry.token
  let fresh = false
  const thrown = (what: string, e: unknown, outcome: 'failed' | 'unknown') => failed('callback_failed', `${what} threw: ${reason(e)}.`, outcome)
  const renew = async (): Promise<Result<never> | undefined> => {
    let s: Result<SignedIn>
    try {
      s = await retry.signIn()
    } catch (e) {
      return thrown('The sign-in function', e, 'failed')
    }
    if (!s.ok) return s
    token = s.body.token
    fresh = true
    try {
      retry.onSignIn?.(s.body)
    } catch (e) {
      return thrown('onSignIn', e, 'failed')
    }
    return undefined
  }
  const run = async (): Promise<Result<T>> => {
    try {
      return await call(token!)
    } catch (e) {
      return thrown('The call', e, 'unknown')
    }
  }
  if (token === undefined) {
    const refused = await renew()
    if (refused) return refused
  }
  const first = await run()
  if (first.ok || first.error.code !== 'wallet_proof_required' || first.error.outcome === 'unknown' || fresh) return first
  const refused = await renew()
  if (refused) return refused
  return run()
}
