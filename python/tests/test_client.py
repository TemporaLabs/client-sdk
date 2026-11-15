"""The HTTP client, ported from typescript/tests/client.test.ts."""

from __future__ import annotations

import dataclasses
import http.server
import json
import math
import threading
import time
from collections.abc import Callable, Iterator
from typing import Any

import httpx
import pytest
from temporalabs_client import Err, Ok, create_client
from temporalabs_client import _internal as internal
from temporalabs_client.generated.spec import OPERATIONS

from conftest import Seen, answer, transport

REQUEST = {
    "requestId": "req_0123456789",
    "action": "withdraw",
    "state": "processing",
    "chose": {"product": "example-product"},
    "expiresAt": "2026-11-09T00:00:00Z",
    "steps": [],
}
WITHDRAW_ALL = {"product": "example-product", "amount": {"kind": "all"}}


def make(
    respond: Callable[[httpx.Request], httpx.Response], owner_token: str | None = None, **kw: Any
) -> tuple[Any, Seen]:
    http, seen = transport(respond)
    return create_client(
        "https://api.example", client_key="ck", owner_token=owner_token, http=http, **kw
    ), seen


def err(r: Any) -> Err:
    assert isinstance(r, Err), r
    return r


def code_outcome(r: Any) -> tuple[int, str, str]:
    e = err(r)
    return e.status, e.error.code, e.error.outcome


class TestTheClient:
    def test_fills_and_encodes_the_path_sets_the_query_and_sends_the_client_key(self) -> None:
        client, seen = make(lambda _: answer(200, {"productId": None}))
        client.products_route(query={"amount": "100", "chain": "eip155:56"})
        client.product(path={"id": "a/b"})
        assert str(seen[0].url) == "https://api.example/v1/products/route?amount=100&chain=eip155%3A56"
        assert str(seen[1].url) == "https://api.example/v1/products/a%2Fb"
        assert seen[0].headers["Tempora-Client-Key"] == "ck"

    def test_with_no_client_key_sends_no_client_key_header_and_still_sends_the_owner_token(self) -> None:
        http, seen = transport(lambda _: answer(200, REQUEST))
        client = create_client("https://api.example", owner_token="owner-1", http=http)
        client.status(path={"requestId": "req_0123456789"})
        client.products()
        for s in seen.requests:
            assert "tempora-client-key" not in s.headers
        assert seen[0].headers["authorization"] == "Bearer owner-1"

    def test_sends_the_owner_token_on_owner_calls_only_a_calls_own_token_first(self) -> None:
        client, seen = make(lambda _: answer(200, REQUEST), "owner-1")
        client.status(path={"requestId": "req_0123456789"}, owner_token="owner-2")
        client.products()
        assert seen[0].headers["authorization"] == "Bearer owner-2"
        assert "authorization" not in seen[1].headers

    def test_decodes_a_success_through_the_output_schema_and_product_read_through_its_read(self) -> None:
        def respond(r: httpx.Request) -> httpx.Response:
            tvl = {"usd": 1, "asOf": None, "stale": False, "extra": "ignored"}
            return answer(200, tvl if str(r.url).endswith("/tvl") else REQUEST)

        client, _ = make(respond)
        r = client.product_read(path={"id": "example-product", "read": "tvl"})
        # A field the API adds later is tolerated, not refused: answers grow additively within a version.
        assert isinstance(r, Ok) and r.status == 200 and r.trace_id == "t-1"
        assert (r.body.usd, r.body.asOf, r.body.stale) == (1, None, False)
        assert r.body.model_extra == {"extra": "ignored"}
        assert client.status_lookup(query={"txHash": "0x" + "a" * 64}).ok is True

    def test_checks_a_product_read_against_that_reads_own_shape_not_any_reads(self) -> None:
        client, _ = make(lambda _: answer(200, {"open": True, "session": None, "allHoldings": True}))
        assert client.product_read(path={"id": "example-product", "read": "market"}).ok is True
        r = client.product_read(path={"id": "example-product", "read": "tvl"})
        assert (err(r).error.code, err(r).error.outcome) == ("unreadable_answer", "failed")

    def test_returns_the_servers_error_as_it_came_with_the_trace_id(self) -> None:
        error = {"code": "gate_failed", "message": "Not open to you.", "outcome": "refused"}
        client, _ = make(lambda _: answer(403, {"error": error}))
        r = err(client.withdraw(body=WITHDRAW_ALL))
        assert (r.status, r.error.model_dump(exclude_unset=True), r.trace_id, r.retry_after) == (
            403,
            error,
            "t-1",
            None,
        )

    @pytest.mark.parametrize(("name", "outcome"), [("withdraw", "unknown"), ("positions", "failed")])
    def test_a_lost_write_is_unknown_and_a_lost_read_failed(self, name: str, outcome: str) -> None:
        def down(_: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("fetch failed")

        client, _ = make(down)
        r = client.withdraw(body=WITHDRAW_ALL) if name == "withdraw" else client.positions()
        assert code_outcome(r) == (0, "network_error", outcome)

    def test_treats_an_answer_that_is_not_the_contract_as_unreadable_unknown_on_a_write(self) -> None:
        client, _ = make(lambda _: answer(502, "<html>bad gateway</html>"))
        assert code_outcome(client.withdraw(body=WITHDRAW_ALL)) == (502, "unreadable_answer", "unknown")
        c2, _ = make(lambda _: answer(200, {"not": "a request"}))
        assert code_outcome(c2.withdraw(body=WITHDRAW_ALL))[1:] == ("unreadable_answer", "unknown")

    def test_keeps_an_unknown_outcome_from_the_server_as_unknown(self) -> None:
        error = {"code": "upstream_in_progress", "message": "It may be running.", "outcome": "unknown"}
        client, _ = make(lambda _: answer(409, {"error": error}))
        assert code_outcome(client.cancel(path={"requestId": "req_0123456789"})) == (
            409,
            "upstream_in_progress",
            "unknown",
        )

    def test_has_exactly_one_method_per_operation_in_the_api_document(self) -> None:
        client, _ = make(lambda _: answer(200, {}))
        assert sorted(vars(client)) == sorted(OPERATIONS)
        assert len(vars(client)) == 17


class TestTheConfiguredOrigin:
    def test_a_path_that_would_leave_it_is_never_sent_and_no_credential_leaves(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        op = OPERATIONS["positions"]
        monkeypatch.setitem(
            OPERATIONS, "positions", dataclasses.replace(op, path="//collector.example/v1/positions")
        )
        client, seen = make(lambda _: answer(200, {}), "ot")
        r = client.positions()
        assert len(seen) == 0
        assert code_outcome(r) == (0, "wrong_origin", "failed")


def solana_step(transaction: str) -> dict[str, Any]:
    return {
        "stepId": "s1",
        "chainId": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        "state": "ready",
        "checks": [],
        "kind": "send_solana_transaction",
        "payload": {"generation": 1, "expiresAt": "2026-11-09T00:00:00Z", "transaction": transaction},
    }


class TestRulesTheDocumentNowCarries:
    @pytest.mark.parametrize(
        "body",
        [{**REQUEST, "steps": [solana_step("not base64!")]}, {**REQUEST, "chose": {"product": "route"}}],
        ids=["a Solana transaction that is not Base64", "the reserved product id"],
    )
    def test_an_answer_breaking_a_rule_is_unreadable(self, body: dict[str, Any]) -> None:
        client, _ = make(lambda _: answer(200, body), "ot")
        assert err(client.status(path={"requestId": "req_0123456789"})).error.code == "unreadable_answer"

    def test_a_base64_transaction_and_an_ordinary_product_id_read(self) -> None:
        client, _ = make(lambda _: answer(200, {**REQUEST, "steps": [solana_step("AAEC")]}), "ot")
        assert client.status(path={"requestId": "req_0123456789"}).ok is True


BY_OPERATION = {
    **REQUEST,
    "action": "withdraw",
    "state": "processing",
    "steps": [],
    "operation": {"id": "op-1", "state": "running"},
}


class TestAWithdrawalFoundByItsOperationId:
    def test_reads_with_its_operation_and_no_steps(self) -> None:
        client, _ = make(lambda _: answer(200, BY_OPERATION), "ot")
        r = client.status_lookup(query={"operationId": "op-1"})
        assert isinstance(r, Ok)
        assert r.body.steps == [] and r.body.operation.id == "op-1" and r.body.operation.state == "running"

    def test_an_operation_state_added_later_still_reads(self) -> None:
        client, _ = make(
            lambda _: answer(200, {**BY_OPERATION, "operation": {"id": "op-1", "state": "paused"}}), "ot"
        )
        assert client.status_lookup(query={"operationId": "op-1"}).ok is True

    @pytest.mark.parametrize("operation", [{"state": "running"}, {"id": "", "state": "running"}])
    def test_an_operation_with_no_or_an_empty_id_is_unreadable(self, operation: dict[str, Any]) -> None:
        client, _ = make(lambda _: answer(200, {**BY_OPERATION, "operation": operation}), "ot")
        assert err(client.status_lookup(query={"operationId": "op-1"})).error.code == "unreadable_answer"


class TestPathValues:
    @pytest.mark.parametrize("v", [".", "..", "%2e", "%2E%2e"])
    def test_a_dot_value_is_refused_and_nothing_is_sent(self, v: str) -> None:
        client, seen = make(lambda _: answer(200, REQUEST), "ot")
        r = client.status(path={"requestId": v})
        assert len(seen) == 0
        assert code_outcome(r) == (0, "invalid_path_value", "failed")

    def test_a_value_with_dots_inside_is_sent_as_itself(self) -> None:
        client, seen = make(lambda _: answer(200, {"productId": None}))
        client.product(path={"id": "a.b"})
        assert seen[0].url.path == "/v1/products/a.b"


class _Server:
    """A local HTTP server on its own thread, recording the headers of every request it receives."""

    def __init__(self, respond: Callable[[http.server.BaseHTTPRequestHandler], None]) -> None:
        self.reached: list[dict[str, str]] = []
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                outer.reached.append(dict(self.headers))
                respond(self)

            do_POST = do_GET

            def log_message(self, *args: Any) -> None:
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


class TestRedirects:
    def test_never_follows_a_redirect_so_a_307_to_another_origin_gets_no_client_key(self) -> None:
        def ok(h: http.server.BaseHTTPRequestHandler) -> None:
            h.send_response(200)
            h.send_header("content-type", "application/json")
            h.end_headers()
            h.wfile.write(b"{}")

        other = _Server(ok)

        def redirect(h: http.server.BaseHTTPRequestHandler) -> None:
            h.send_response(307)
            h.send_header("location", f"http://127.0.0.1:{other.port}/v1/positions")
            h.send_header("content-length", "0")
            h.end_headers()

        api = _Server(redirect)
        try:
            client = create_client(f"http://localhost:{api.port}", client_key="ck-secret", owner_token="ot")
            read = client.positions()
            write = client.withdraw(body=WITHDRAW_ALL)
            assert code_outcome(read)[1:] == ("network_error", "failed")
            assert code_outcome(write)[1:] == ("network_error", "unknown")
            assert other.reached == []
            assert len(api.reached) == 2
        finally:
            api.close()
            other.close()


def ok_http() -> httpx.Client:
    return transport(lambda _: answer(200, {}))[0]


class TestOptionsAndHeaderValues:
    def test_refuses_a_bad_option_when_the_client_is_made_so_no_call_raises_for_it(self) -> None:
        with pytest.raises(ValueError):
            create_client("api.example.com", client_key="ck", http=ok_http())
        with pytest.raises(ValueError, match="https or http"):
            create_client("ftp://api.example", client_key="ck", http=ok_http())
        for timeout_s in (-1, 0, math.nan, math.inf, 2**31 / 1000):
            with pytest.raises(ValueError, match="timeout_s"):
                create_client("https://api.example", client_key="ck", timeout_s=timeout_s, http=ok_http())
        for wrong in ("1.5", True):
            with pytest.raises(TypeError, match="timeout_s"):
                create_client("https://api.example", timeout_s=wrong, http=ok_http())  # type: ignore[arg-type]
        with pytest.raises(ValueError, match="client_key"):
            create_client("https://api.example", client_key="ck\n", http=ok_http())
        with pytest.raises(ValueError, match="owner_token"):
            create_client("https://api.example", client_key="ck", owner_token="tok\r\n", http=ok_http())
        create_client("https://api.example", client_key="ck", timeout_s=5, http=ok_http())

    def test_refuses_plain_http_except_to_this_machine(self) -> None:
        for base_url in ("http://api.example", "http://10.0.0.5:8080", "http://localhost.example.com"):
            with pytest.raises(ValueError, match="https"):
                create_client(base_url, http=ok_http())
        for base_url in (
            "http://localhost:3000",
            "http://127.0.0.1:8080",
            "http://[::1]:8080",
            "https://api.example",
        ):
            create_client(base_url, http=ok_http())

    def test_refuses_an_empty_or_blank_client_key_which_would_quietly_make_the_caller_keyless(self) -> None:
        for client_key in ("", " ", "   ", "\t"):
            with pytest.raises(ValueError, match="client_key"):
                create_client("https://api.example", client_key=client_key, http=ok_http())

    def test_refuses_any_control_character_in_a_key_not_only_a_line_break(self) -> None:
        for client_key in ("ck\t\u0000", "ck\u001b", "ck\u007f"):
            with pytest.raises(ValueError, match="client_key"):
                create_client("https://api.example", client_key=client_key, http=ok_http())

    def test_refuses_options_of_the_wrong_type(self) -> None:
        with pytest.raises(TypeError, match="base_url"):
            create_client(7)  # type: ignore[arg-type]
        with pytest.raises(TypeError, match="client_key"):
            create_client("https://api.example", client_key=7)  # type: ignore[arg-type]
        with pytest.raises(TypeError, match="http"):
            create_client("https://api.example", http=object())  # type: ignore[arg-type]

    def test_a_calls_own_token_with_a_line_break_is_not_sent_and_the_call_failed_rather_than_unknown(
        self,
    ) -> None:
        client, seen = make(lambda _: answer(200, REQUEST))
        r = client.cancel(path={"requestId": "req_0123456789"}, owner_token="tok\n")
        assert code_outcome(r) == (0, "network_error", "failed")
        assert len(seen) == 0


class TestASchemaThatCannotBecomeAValidator:
    def test_leaves_the_answer_unreadable_instead_of_raising(self, monkeypatch: pytest.MonkeyPatch) -> None:
        def broken(*_: Any, **__: Any) -> Any:
            raise RuntimeError("cannot convert")

        monkeypatch.setattr(internal, "_adapters", {})
        monkeypatch.setattr(internal, "TypeAdapter", broken)
        client, _ = make(lambda _: answer(200, REQUEST))
        r = client.status(path={"requestId": "req_0123456789"}, owner_token="t")
        assert err(r).error.code == "unreadable_answer"


class TestRetryAfter:
    def test_a_refusals_retry_after_header_reaches_the_result_in_seconds(self) -> None:
        error = {
            "code": "rate_limited",
            "message": "Too many requests; try again later.",
            "outcome": "refused",
            "traceId": "t-1",
        }
        headers = {"content-type": "application/json", "retry-after": "5", "x-trace-id": "t-1"}
        client, _ = make(lambda _: answer(429, {"error": error}, headers))
        r = err(client.products())
        assert (r.status, r.error.model_dump(exclude_unset=True), r.trace_id, r.retry_after) == (
            429,
            error,
            "t-1",
            5,
        )

    @pytest.mark.parametrize(
        "headers", [{}, {"retry-after": "soon"}, {"retry-after": "86401"}, {"retry-after": "-1"}]
    )
    def test_a_missing_malformed_or_too_long_retry_after_is_left_out(self, headers: dict[str, str]) -> None:
        error = {"code": "rate_limited", "message": "x", "outcome": "refused"}
        client, _ = make(lambda _: answer(429, {"error": error}, headers))
        assert err(client.products()).retry_after is None

    def test_one_day_is_kept(self) -> None:
        error = {"code": "rate_limited", "message": "Slow down.", "outcome": "refused"}
        client, _ = make(lambda _: answer(429, {"error": error}, {"retry-after": "86400"}))
        assert err(client.products()).retry_after == 86_400


class TestWhatBothClientsSharePinnedOnTheHttpClient:
    def test_an_error_with_a_code_that_may_hide_a_moved_request_not_saying_unknown_is_unreadable(
        self,
    ) -> None:
        body = {"error": {"code": "upstream_timeout", "message": "No answer in time.", "outcome": "refused"}}
        client, _ = make(lambda _: answer(504, body))
        assert code_outcome(client.withdraw(body=WITHDRAW_ALL)) == (504, "unreadable_answer", "unknown")

    @pytest.mark.parametrize("read", ["__proto__", "constructor", "toString", "__class__", "keys"])
    def test_a_read_named_like_an_object_property_is_not_a_listed_read(self, read: str) -> None:
        client, _ = make(lambda _: answer(200, {"anything": True}))
        assert code_outcome(client.product_read(path={"id": "example-product", "read": read})) == (
            200,
            "unreadable_answer",
            "failed",
        )

    def test_times_a_call_out_after_30_seconds_unless_timeout_s_says_otherwise(self) -> None:
        client, seen = make(lambda _: answer(200, {"products": []}))
        client.products()
        assert seen[0].extensions["timeout"] == {"connect": 30.0, "read": 30.0, "write": 30.0, "pool": 30.0}
        client, seen = make(lambda _: answer(200, {"products": []}), timeout_s=1.234)
        client.products()
        assert seen[0].extensions["timeout"]["read"] == 1.234


class TestTheRequestItself:
    def test_a_call_with_no_body_sends_no_body_at_all(self) -> None:
        client, seen = make(lambda _: answer(200, {"products": []}))
        client.products()
        assert seen[0].content == b""
        assert "content-type" not in seen[0].headers

    def test_a_body_is_sent_as_json_with_its_type(self) -> None:
        client, seen = make(lambda _: answer(200, REQUEST))
        client.withdraw(body=WITHDRAW_ALL)
        assert json.loads(seen[0].content) == WITHDRAW_ALL
        assert seen[0].headers["content-type"] == "application/json"

    def test_names_the_option_it_refuses_base_url(self) -> None:
        with pytest.raises(ValueError, match=r"^base_url must be an absolute URL"):
            create_client("not a url")
        with pytest.raises(ValueError, match=r"^base_url must use https"):
            create_client("http://api.example")


class _Hostile:
    def __str__(self) -> str:
        raise RuntimeError("no")


class TestACallNeverRaisesForItsInput:
    @pytest.mark.parametrize(
        "value", ["\ud800", _Hostile()], ids=["a lone surrogate", "a value whose str raises"]
    )
    def test_a_path_value_that_cannot_be_written_is_refused_and_nothing_is_sent(self, value: Any) -> None:
        client, seen = make(lambda _: answer(200, {"productId": None}))
        assert code_outcome(client.product(path={"id": value})) == (0, "invalid_path_value", "failed")
        assert len(seen) == 0

    def test_a_query_value_that_cannot_be_written_is_not_sent_and_the_call_failed(self) -> None:
        client, seen = make(lambda _: answer(200, {"productId": None}))
        r = client.products_route(query={"amount": _Hostile(), "chain": "eip155:56"})
        assert code_outcome(r) == (0, "network_error", "failed")
        assert len(seen) == 0

    def test_query_values_are_written_as_javascript_writes_them(self) -> None:
        client, seen = make(lambda _: answer(200, {"productId": None}))
        client.products_route(query={"amount": 100.0, "chain": "a b~*", "extra": True, "skipped": None})
        assert seen[0].url.query == b"amount=100&chain=a+b%7E*&extra=true"


class TestOptionsAreReadOnce:
    def test_changing_the_options_afterwards_changes_nothing_a_call_sends(self) -> None:
        http, seen = transport(lambda _: answer(200, {"positions": []}))
        opts: dict[str, Any] = {"client_key": "ck", "owner_token": "tok", "http": http}
        client = create_client("https://api.example", **opts)
        opts.update(client_key="other", owner_token="other")
        assert client.positions().ok is True
        assert str(seen[0].url) == "https://api.example/v1/positions"
        assert seen[0].headers["Tempora-Client-Key"] == "ck"
        assert seen[0].headers["authorization"] == "Bearer tok"


class TestInputsThatCannotBeSentAsGiven:
    def test_a_body_that_cannot_be_written_as_json_is_not_sent_and_the_call_failed_rather_than_unknown(
        self,
    ) -> None:
        client, seen = make(lambda _: answer(200, REQUEST))
        r = client.withdraw(body={**WITHDRAW_ALL, "extra": {1, 2}})
        assert code_outcome(r) == (0, "network_error", "failed")
        assert len(seen) == 0

    @pytest.mark.parametrize("value", [None, "", 5, {}], ids=["missing", "empty", "a number", "an object"])
    def test_a_path_value_that_is_not_text_is_refused_and_nothing_is_sent(self, value: Any) -> None:
        client, seen = make(lambda _: answer(200, {"productId": None}))
        path = {} if value is None else {"id": value}
        assert code_outcome(client.product(path=path)) == (0, "invalid_path_value", "failed")
        assert len(seen) == 0

    def test_refuses_an_empty_owner_token_and_a_base_url_carrying_a_user_or_password(self) -> None:
        with pytest.raises(ValueError, match="owner_token"):
            create_client("https://api.example", owner_token="")
        with pytest.raises(ValueError, match=r"^base_url must not carry"):
            create_client("https://user:pass@api.example")
        with pytest.raises(ValueError, match=r"^base_url must not carry"):
            create_client("https://user@api.example")


class _Endless(httpx.SyncByteStream):
    """A body that never ends until the test releases it."""

    def __init__(self, release: threading.Event) -> None:
        self.release = release

    def __iter__(self) -> Iterator[bytes]:
        self.release.wait()
        yield b""


class TestTheClientSurvivesACarelessCallerAndACarelessTransport:
    def test_a_call_made_with_no_argument_at_all_is_a_result(self) -> None:
        client, _ = make(lambda _: answer(200, {"products": []}))
        assert client.products().ok is True

    def test_a_timeout_fires_even_when_the_transport_ignores_it(self) -> None:
        release = threading.Event()

        def hang(_: httpx.Request) -> httpx.Response:
            release.wait()
            return answer(200, {})

        try:
            client, _ = make(hang, timeout_s=0.05)
            started = time.monotonic()
            assert code_outcome(client.products()) == (0, "network_error", "failed")
            assert time.monotonic() - started < 2
        finally:
            release.set()

    @pytest.mark.parametrize("value", [None, {}, {"ok": True, "status": 200}])
    def test_a_transport_that_gives_something_that_is_not_a_response_is_a_network_error(
        self, value: Any
    ) -> None:
        client, _ = make(lambda _: value)
        assert code_outcome(client.products())[:2] == (0, "network_error")

    def test_a_body_that_never_ends_ends_at_the_timeout_as_unreadable_answer(self) -> None:
        release = threading.Event()
        try:
            client, _ = make(lambda _: httpx.Response(200, stream=_Endless(release)), "tok", timeout_s=0.05)
            started = time.monotonic()
            assert code_outcome(client.products()) == (200, "unreadable_answer", "failed")
            assert code_outcome(client.withdraw(body=WITHDRAW_ALL)) == (200, "unreadable_answer", "unknown")
            assert time.monotonic() - started < 2
        finally:
            release.set()


class TestAnswersAsJavaScriptReadsThem:
    @pytest.mark.parametrize(
        "text",
        ['{"usd": NaN, "asOf": null, "stale": false}', '{"usd": Infinity, "asOf": null, "stale": false}', ""],
    )
    def test_a_body_that_is_not_plain_json_is_unreadable(self, text: str) -> None:
        client, _ = make(lambda _: answer(200, text))
        assert (
            err(client.product_read(path={"id": "example-product", "read": "tvl"})).error.code
            == "unreadable_answer"
        )

    def test_a_number_too_large_for_a_double_is_unreadable(self) -> None:
        client, _ = make(lambda _: answer(200, '{"usd": 1e400, "asOf": null, "stale": false}'))
        assert (
            err(client.product_read(path={"id": "example-product", "read": "tvl"})).error.code
            == "unreadable_answer"
        )

    def test_a_leading_byte_order_mark_is_dropped(self) -> None:
        body = "\ufeff" + json.dumps({"usd": 1, "asOf": None, "stale": False})
        client, _ = make(lambda _: httpx.Response(200, content=body.encode()))
        assert client.product_read(path={"id": "example-product", "read": "tvl"}).ok is True


class _Drip(httpx.SyncByteStream):
    """A body that keeps arriving, a chunk at a time, faster than any per-read timeout: it never ends."""

    def __init__(self) -> None:
        self.sent = 0
        self.closed = threading.Event()

    def __iter__(self) -> Iterator[bytes]:
        while not self.closed.is_set():
            self.sent += 1
            time.sleep(0.002)
            yield b" "

    def close(self) -> None:
        self.closed.set()


class TestTheDeadlineStopsTheReaderAndOversizedNumbersStayResults:
    def test_a_body_still_arriving_at_the_deadline_is_stopped_and_closed_not_buffered_on(self) -> None:
        streams: list[_Drip] = []

        def respond(_: httpx.Request) -> httpx.Response:
            streams.append(_Drip())
            return httpx.Response(200, stream=streams[-1])

        client, _ = make(respond, timeout_s=0.05)
        assert code_outcome(client.products()) == (200, "unreadable_answer", "failed")
        assert code_outcome(client.withdraw(body=WITHDRAW_ALL)) == (200, "unreadable_answer", "unknown")
        for s in streams:
            assert s.closed.wait(2), "the reader went on after the deadline"
        sent = [s.sent for s in streams]
        time.sleep(0.05)
        assert [s.sent for s in streams] == sent

    def test_a_retry_after_too_long_to_read_is_left_out_and_the_error_still_returned(self) -> None:
        error = {"code": "rate_limited", "message": "Slow down.", "outcome": "refused"}
        client, _ = make(lambda _: answer(429, {"error": error}, {"retry-after": "9" * 4301}))
        e = err(client.products())
        assert (e.status, e.error.code, e.retry_after) == (429, "rate_limited", None)
