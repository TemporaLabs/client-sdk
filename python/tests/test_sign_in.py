"""Sign-in and the owner retry, ported from typescript/tests/signIn.test.ts."""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from temporalabs_client import Err, Ok, Result, create_client, models, sign_in, with_owner_retry
from temporalabs_client import _internal as internal

from conftest import answer, transport

CHALLENGE = {"message": "Sign in to the example.", "nonce": "n-1", "expiresAt": "2026-11-12T10:00:00Z"}
TOKEN = {"token": "tok-1", "tokenType": "Bearer", "expiresAt": "2026-11-12T22:00:00Z"}
OWNER = "0x1111111111111111111111111111111111111111"


def error(code: str, outcome: str = "refused", status: int = 401) -> httpx.Response:
    return answer(status, {"error": {"code": code, "message": f"{code}.", "outcome": outcome}})


def ok_flow(path: str) -> httpx.Response:
    return answer(200, CHALLENGE) if path.endswith("/challenge") else answer(200, TOKEN)


class Recorder:
    """Answers the two sign-in calls from a script of responses per path, and records them."""

    def __init__(self, respond: Callable[[str], httpx.Response]) -> None:
        self.seen: list[tuple[str, Any]] = []

        def handle(r: httpx.Request) -> httpx.Response:
            self.seen.append((r.url.path, json.loads(r.content) if r.content else None))
            return respond(r.url.path)

        http, _ = transport(handle)
        self.client = create_client("https://api.example", client_key="ck", http=http)

    def verifies(self) -> list[Any]:
        return [b for p, b in self.seen if p.endswith("/verify")]


class Calls:
    """A callable that records its calls."""

    def __init__(self, fn: Callable[..., Any]) -> None:
        self.fn = fn
        self.calls: list[tuple[Any, ...]] = []

    def __call__(self, *args: Any) -> Any:
        self.calls.append(args)
        return self.fn(*args)


def signer(signature: str = "0xsig") -> Calls:
    return Calls(lambda _message: signature)


def err(r: Any) -> Err:
    assert isinstance(r, Err), r
    return r


class TestSignIn:
    def test_asks_for_a_challenge_has_it_signed_and_verifies_with_the_same_owner_and_the_challenge_nonce(
        self,
    ) -> None:
        rec = Recorder(ok_flow)
        sign = signer()
        r = sign_in(rec.client, owner=OWNER, origin="https://app.example", sign_message=sign)
        assert isinstance(r, Ok) and r.body.model_dump() == TOKEN
        assert sign.calls == [(CHALLENGE["message"],)]
        assert rec.seen[0][1] == {"owner": OWNER, "origin": "https://app.example"}
        assert rec.seen[1][1] == {"owner": OWNER, "nonce": "n-1", "signature": "0xsig"}

    def test_asks_for_where_the_token_works_when_an_audience_is_given_and_sends_none_when_it_is_not(
        self,
    ) -> None:
        with_audience = Recorder(ok_flow)
        sign_in(with_audience.client, owner=OWNER, sign_message=signer(), audience="mcp")
        assert with_audience.verifies()[0] == {
            "owner": OWNER,
            "nonce": "n-1",
            "signature": "0xsig",
            "audience": "mcp",
        }
        # The challenge never carries it: only verify makes the token.
        assert with_audience.seen[0][1] == {"owner": OWNER}
        without = Recorder(ok_flow)
        sign_in(without.client, owner=OWNER, sign_message=signer())
        assert "audience" not in without.verifies()[0]

    def test_leaves_origin_out_of_the_challenge_request_when_none_is_given(self) -> None:
        rec = Recorder(ok_flow)
        sign_in(rec.client, owner=OWNER, sign_message=signer())
        assert rec.seen[0][1] == {"owner": OWNER}

    def test_a_check_that_returns_false_stops_before_any_signature_is_asked_for_and_before_verify(
        self,
    ) -> None:
        rec = Recorder(ok_flow)
        sign = signer()
        r = err(sign_in(rec.client, owner=OWNER, sign_message=sign, check=lambda _: False))
        assert (r.error.code, r.error.outcome) == ("challenge_refused", "failed")
        assert sign.calls == [] and rec.verifies() == []

    def test_a_check_that_raises_refuses_the_same_way_and_says_why(self) -> None:
        rec = Recorder(ok_flow)
        sign = signer()

        def check(_: str) -> bool:
            raise ValueError("not the fixed format")

        r = err(sign_in(rec.client, owner=OWNER, sign_message=sign, check=check))
        assert r.error.code == "challenge_refused"
        assert "not the fixed format" in r.error.message
        assert sign.calls == [] and rec.verifies() == []

    def test_a_check_that_returns_true_goes_on_and_receives_the_challenge_text(self) -> None:
        rec = Recorder(ok_flow)
        check = Calls(lambda _: True)
        assert sign_in(rec.client, owner=OWNER, sign_message=signer(), check=check).ok is True
        assert check.calls == [(CHALLENGE["message"],)]

    def test_a_rejected_signature_is_a_failed_sign_in_and_verify_is_never_sent(self) -> None:
        rec = Recorder(ok_flow)

        def reject(_: str) -> str:
            raise RuntimeError("user rejected")

        r = err(sign_in(rec.client, owner=OWNER, sign_message=reject))
        assert (r.error.code, r.error.outcome) == ("signing_failed", "failed")
        assert rec.verifies() == []

    def test_an_error_from_the_challenge_or_from_verify_comes_back_as_the_api_sent_it(self) -> None:
        a = Recorder(
            lambda p: error("unknown_origin", "refused", 403) if p.endswith("/challenge") else ok_flow(p)
        )
        sign = signer()
        r = err(sign_in(a.client, owner=OWNER, sign_message=sign))
        assert (r.status, r.error.code, r.error.outcome) == (403, "unknown_origin", "refused")
        assert sign.calls == []
        b = Recorder(lambda p: error("signature_not_owner") if p.endswith("/verify") else ok_flow(p))
        r = err(sign_in(b.client, owner=OWNER, sign_message=sign))
        assert (r.status, r.error.code) == (401, "signature_not_owner")

    def test_a_token_that_is_not_a_bearer_token_is_refused_and_not_returned(self) -> None:
        rec = Recorder(
            lambda p: answer(200, {**TOKEN, "tokenType": "Basic"}) if p.endswith("/verify") else ok_flow(p)
        )
        assert (
            err(sign_in(rec.client, owner=OWNER, sign_message=signer())).error.code
            == "unsupported_token_type"
        )

    def test_does_not_depend_on_the_text_of_the_message(self) -> None:
        for message in (
            "plain text",
            "example.com wants you to sign in\n\nURI: https://example.com\nNonce: abc",
            "",
        ):

            def respond(p: str, m: str = message) -> httpx.Response:
                return (
                    answer(200, {**CHALLENGE, "message": m})
                    if p.endswith("/challenge")
                    else answer(200, TOKEN)
                )

            rec = Recorder(respond)
            sign = signer()
            assert sign_in(rec.client, owner=OWNER, sign_message=sign).ok is True
            assert sign.calls == [(message,)]

    def test_works_through_a_client_with_no_client_key_neither_call_carries_one(self) -> None:
        keys: list[bool] = []

        def handle(r: httpx.Request) -> httpx.Response:
            keys.append("tempora-client-key" in r.headers)
            return ok_flow(r.url.path)

        http, _ = transport(handle)
        r = sign_in(create_client("https://api.example", http=http), owner=OWNER, sign_message=signer())
        assert isinstance(r, Ok) and r.body.model_dump() == TOKEN
        assert keys == [False, False]

    def test_never_raises_a_lost_answer_is_an_error_result(self) -> None:
        def down(_: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("down")

        http, _ = transport(down)
        r = sign_in(
            create_client("https://api.example", client_key="ck", http=http),
            owner=OWNER,
            sign_message=signer(),
        )
        assert err(r).error.code == "network_error"


def signed_in(token: str) -> Result[models.Token]:
    return Ok(
        status=200,
        body=models.Token.model_validate(
            {"token": token, "tokenType": "Bearer", "expiresAt": "2026-11-12T22:00:00Z"}
        ),
    )


def good(body: Any) -> Result[Any]:
    return Ok(status=200, body=body)


def refusal(code: str, outcome: Any = "refused") -> Err:
    return Err(status=401, error=internal.api_error(code, f"{code}.", outcome))


class TestWithOwnerRetry:
    def test_runs_the_call_with_the_token_in_hand_and_signs_in_no_more(self) -> None:
        sign = Calls(lambda: signed_in("new"))
        call = Calls(good)
        r = with_owner_retry(call, token="old", sign_in=sign)
        assert isinstance(r, Ok) and r.body == "old"
        assert sign.calls == [] and len(call.calls) == 1

    def test_signs_in_again_once_on_wallet_proof_required_and_repeats_the_call_once_with_the_new_token(
        self,
    ) -> None:
        sign = Calls(lambda: signed_in("new"))
        kept: list[Any] = []
        call = Calls(lambda t: refusal("wallet_proof_required") if t == "old" else good(t))
        r = with_owner_retry(call, token="old", sign_in=sign, on_sign_in=kept.append)
        assert isinstance(r, Ok) and r.body == "new"
        assert len(sign.calls) == 1
        assert [c[0] for c in call.calls] == ["old", "new"]
        assert [k.token for k in kept] == ["new"]

    def test_does_not_loop_a_second_wallet_proof_required_is_returned_as_it_is(self) -> None:
        sign = Calls(lambda: signed_in("new"))
        call = Calls(lambda _t: refusal("wallet_proof_required"))
        assert err(with_owner_retry(call, token="old", sign_in=sign)).error.code == "wallet_proof_required"
        assert len(sign.calls) == 1 and len(call.calls) == 2

    @pytest.mark.parametrize(
        "code", ["unauthenticated", "gate_failed", "rate_limited", "internal_error", "upstream_timeout"]
    )
    def test_does_not_repeat_for_any_other_code(self, code: str) -> None:
        sign = Calls(lambda: signed_in("new"))
        call = Calls(lambda _t: refusal(code))
        assert err(with_owner_retry(call, token="old", sign_in=sign)).error.code == code
        assert sign.calls == [] and len(call.calls) == 1

    def test_never_repeats_a_call_whose_outcome_is_unknown_whatever_the_code(self) -> None:
        sign = Calls(lambda: signed_in("new"))
        for code in ("upstream_timeout", "network_error", "wallet_proof_required"):
            call = Calls(lambda _t, c=code: refusal(c, "unknown"))
            r = err(with_owner_retry(call, token="old", sign_in=sign))
            assert (r.error.code, r.error.outcome) == (code, "unknown")
            assert len(call.calls) == 1
        assert sign.calls == []

    def test_with_no_token_signs_in_first_and_a_call_refused_with_that_fresh_token_is_not_retried(
        self,
    ) -> None:
        sign = Calls(lambda: signed_in("fresh"))
        call = Calls(lambda _t: refusal("wallet_proof_required"))
        assert err(with_owner_retry(call, sign_in=sign)).error.code == "wallet_proof_required"
        assert len(sign.calls) == 1 and call.calls == [("fresh",)]

    def test_a_raise_from_the_callers_own_functions_comes_back_as_a_result(self) -> None:
        def disk_full(_: Any) -> None:
            raise OSError("disk full")

        # on_sign_in raises: the token was obtained but not kept, so the call is not made.
        a = Calls(good)
        r = err(with_owner_retry(a, sign_in=lambda: signed_in("fresh"), on_sign_in=disk_full))
        assert (r.status, r.error.code, r.error.outcome) == (0, "callback_failed", "failed")
        assert a.calls == []

        def no_wallet() -> Result[models.Token]:
            raise RuntimeError("no wallet")

        # The sign-in function raises.
        b = Calls(good)
        r = err(with_owner_retry(b, sign_in=no_wallet))
        assert (r.error.code, r.error.outcome) == ("callback_failed", "failed")
        assert b.calls == []

        def boom(_: str) -> Result[str]:
            raise RuntimeError("boom")

        # The call raises: it may have been sent, so it is unknown, and it is not repeated.
        sign = Calls(lambda: signed_in("new"))
        c = Calls(boom)
        r = err(with_owner_retry(c, token="old", sign_in=sign))
        assert (r.error.code, r.error.outcome) == ("callback_failed", "unknown")
        assert len(c.calls) == 1 and sign.calls == []

    def test_a_failed_sign_in_comes_back_as_the_result_and_the_call_is_not_made_again(self) -> None:
        failed = Calls(lambda: Err(status=0, error=internal.api_error("signing_failed", "no.", "failed")))
        first = Calls(good)
        assert err(with_owner_retry(first, sign_in=failed)).error.code == "signing_failed"
        assert first.calls == []
        second = Calls(lambda _t: refusal("wallet_proof_required"))
        assert err(with_owner_retry(second, token="old", sign_in=failed)).error.code == "signing_failed"
        assert len(second.calls) == 1


class TestSignInGoesOnOnlyWhenCheckReturnsTrue:
    @pytest.mark.parametrize("verdict", [None, 0, 1, "", "no", {}, [], "True"], ids=repr)
    def test_a_check_that_returns_anything_but_true_refuses_and_nothing_is_signed(self, verdict: Any) -> None:
        rec = Recorder(ok_flow)
        sign = signer()
        r = err(sign_in(rec.client, owner=OWNER, sign_message=sign, check=lambda _: verdict))
        assert (r.status, r.error.code, r.error.outcome) == (0, "challenge_refused", "failed")
        assert sign.calls == [] and rec.verifies() == []

    def test_a_check_written_as_a_regex_match_refuses_a_challenge_that_does_not_match(self) -> None:
        rec = Recorder(lambda _: answer(200, {**CHALLENGE, "message": "Send everything to the attacker."}))
        sign = signer()
        r = sign_in(
            rec.client,
            owner=OWNER,
            sign_message=sign,
            check=lambda m: re.fullmatch(r"Sign in to the example\.", m),
        )
        assert err(r).error.code == "challenge_refused"
        assert sign.calls == []
