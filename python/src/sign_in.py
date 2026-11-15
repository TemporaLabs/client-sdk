"""The owner sign-in as one call, and a wrapper that signs in again once when an owner call is refused
for it."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any, Literal, Protocol, TypeVar

from . import _internal as internal
from ._result import Err, Result
from .generated import models

__all__ = ["SignInClient", "SignedIn", "sign_in", "with_owner_retry"]

# What a sign-in returns: the owner token and when it stops working.
SignedIn = models.SignInVerifyAnswer
T = TypeVar("T")


class SignInClient(Protocol):
    """The two calls a sign-in makes, as `create_client` returns them."""

    def sign_in_challenge(
        self, *, body: Any, owner_token: str | None = None
    ) -> Result[models.SignInChallengeAnswer]: ...
    def sign_in_verify(
        self, *, body: Any, owner_token: str | None = None
    ) -> Result[models.SignInVerifyAnswer]: ...


def _failed(code: str, message: str, outcome: Literal["failed", "unknown"] = "failed") -> Err:
    return Err(status=0, error=internal.api_error(code, message, outcome))


def _reason(e: BaseException) -> str:
    return str(e) or "no reason was given"


def sign_in(
    client: SignInClient,
    *,
    owner: str,
    sign_message: Callable[[str], str],
    check: Callable[[str], Any] | None = None,
    origin: str | None = None,
    audience: Literal["http", "mcp", "both"] | None = None,
) -> Result[SignedIn]:
    """Runs the sign-in: asks for a challenge, has the owner sign it, verifies it. Nothing is raised.

    `sign_message` has the owner sign the challenge text with their own wallet and returns the signature: the
    client never sees a wallet or a key. `check` is called with the challenge text before anything is signed;
    only a return of `True` goes on, and anything else, nothing included, or a raise refuses it. `origin` (a
    URI) is sent with the challenge request when given. `audience` is where the token works: `http` (the
    default when left out), `mcp` or `both`; a token is refused where it was not made to work, as
    `wallet_proof_required`.

    An error from either call comes back unchanged. The three codes that are this function's own are
    `challenge_refused` (the check said no), `signing_failed` (the owner did not sign) and
    `unsupported_token_type` (the token is not a Bearer token, the only kind the client sends). Each means
    nothing was verified, and each has `status` 0: the call never reached the API.
    """
    challenge = client.sign_in_challenge(
        body={"owner": owner, **({"origin": origin} if origin is not None else {})}
    )
    if not challenge.ok:
        return challenge
    message: str = challenge.body.message
    nonce: str = challenge.body.nonce
    if check is not None:
        try:
            verdict = check(message)
        except Exception as e:
            return _failed(
                "challenge_refused",
                f"The sign-in challenge was refused before signing: {_reason(e)}. Nothing was signed.",
            )
        # Only `True` goes on: a check that forgets to return, or returns a match (None on a mismatch),
        # refuses.
        if verdict is not True:
            return _failed(
                "challenge_refused", "The sign-in challenge was refused before signing. Nothing was signed."
            )
    try:
        signature = sign_message(message)
    except Exception as e:
        return _failed(
            "signing_failed", f"The owner did not sign the challenge: {_reason(e)}. Nothing was verified."
        )
    verified = client.sign_in_verify(
        body={
            "owner": owner,
            "nonce": nonce,
            "signature": signature,
            **({"audience": audience} if audience is not None else {}),
        }
    )
    if not verified.ok:
        return verified
    # The client sends every owner token as Bearer, so a token of another type could not be used.
    if verified.body.tokenType != "Bearer":
        return _failed(
            "unsupported_token_type",
            f"The token type {json.dumps(verified.body.tokenType)} is not Bearer, "
            "the only kind this client sends. "
            "The token was not kept.",
        )
    return verified


def with_owner_retry(
    call: Callable[[str], Result[T]],
    *,
    sign_in: Callable[[], Result[SignedIn]],
    token: str | None = None,
    on_sign_in: Callable[[SignedIn], object] | None = None,
) -> Result[T]:
    """Runs one owner call with a token, and when the answer is `wallet_proof_required`, signs in once more
    and runs it once more.

    That code means the token was missing, unknown, expired, signed out or not this caller's, and the call was
    not run, so repeating it cannot do a write twice. It never repeats a call for any other answer, never
    after an `unknown` outcome (a write that may have gone through), and never a third time. A token it has
    just obtained is not replaced, so a call refused with a fresh token is not retried. A failed sign-in comes
    back as the result. Without `token`, it signs in before the first call; `on_sign_in` is called with each
    new sign-in, so the caller can keep the token.

    It does not raise for what the caller's functions do: a raise from `sign_in`, `on_sign_in` or `call` comes
    back as a `callback_failed` result, `unknown` when `call` raised (it may have been sent) and `failed`
    otherwise.
    """
    state: dict[str, Any] = {"token": token, "fresh": False}

    def thrown(what: str, e: BaseException, outcome: Literal["failed", "unknown"]) -> Err:
        return _failed("callback_failed", f"{what} threw: {_reason(e)}.", outcome)

    def renew() -> Err | None:
        try:
            s = sign_in()
        except Exception as e:
            return thrown("The sign-in function", e, "failed")
        if not s.ok:
            return s
        state["token"] = s.body.token
        state["fresh"] = True
        try:
            if on_sign_in is not None:
                on_sign_in(s.body)
        except Exception as e:
            return thrown("on_sign_in", e, "failed")
        return None

    def run() -> Result[T]:
        try:
            return call(state["token"])
        except Exception as e:
            return thrown("The call", e, "unknown")

    if state["token"] is None:
        refused = renew()
        if refused is not None:
            return refused
    first = run()
    if (
        first.ok
        or first.error.code != "wallet_proof_required"
        or first.error.outcome == "unknown"
        or state["fresh"]
    ):
        return first
    refused = renew()
    if refused is not None:
        return refused
    return run()
