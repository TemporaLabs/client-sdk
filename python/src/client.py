"""The typed HTTP client for the Tempora API: one method per call, every answer a Result that never raises."""

from __future__ import annotations

import math
import re
from collections.abc import Callable, Mapping
from typing import Any, cast
from urllib.parse import quote, urljoin

import httpx

from . import _internal as internal
from ._result import Err, Ok, Result
from .generated.models import ApiError
from .generated.operations import Client
from .generated.spec import CLIENT_KEY_HEADER, OPERATIONS, Operation

__all__ = ["Client", "create_client"]

# `.` or `..`, even percent-encoded, would move the call to another route on the same origin.
_DOT_SEGMENT = re.compile(r"(?:\.|%2e){1,2}", re.IGNORECASE | re.ASCII)
_PATH_NAME = re.compile(r"\{(\w+)\}", re.ASCII)


class _PathValue(Exception):
    pass


def _fill(template: str, args: Mapping[str, Any]) -> str:
    """The path with every `{name}` filled. A value that is not a non-empty string is refused, never
    sent as text."""

    def one(m: re.Match[str]) -> str:
        v = args.get(m.group(1))
        if not isinstance(v, str) or v == "":
            raise _PathValue(m.group(1))
        # What JavaScript's encodeURIComponent writes; a lone surrogate cannot be written and is refused.
        try:
            return quote(v, safe="!*'()", encoding="utf-8", errors="strict")
        except UnicodeEncodeError:
            raise _PathValue(m.group(1)) from None

    return _PATH_NAME.sub(one, template)


def js_string(v: Any) -> str:
    """A query value as JavaScript's String() writes it; raises TypeError for a value it would not
    write plainly."""
    if isinstance(v, str):
        return v
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        if math.isnan(v):
            return "NaN"
        if math.isinf(v):
            return "Infinity" if v > 0 else "-Infinity"
        if v.is_integer() and abs(v) < 1e21:
            return str(int(v))
        return re.sub(r"e([+-])0*(\d)", r"e\1\2", repr(v))
    raise TypeError(f"a {type(v).__name__} is not a query value")


def form_encode(s: str) -> str:
    """One name or value as URLSearchParams writes it (application/x-www-form-urlencoded)."""
    # A lone surrogate becomes U+FFFD, as it does in a JavaScript URL.
    data = s.encode("utf-16", "surrogatepass").decode("utf-16", "replace").encode("utf-8")
    out = []
    for b in data:
        if b == 0x20:
            out.append("+")
        elif 0x30 <= b <= 0x39 or 0x41 <= b <= 0x5A or 0x61 <= b <= 0x7A or b in (0x2A, 0x2D, 0x2E, 0x5F):
            out.append(chr(b))
        else:
            out.append(f"%{b:02X}")
    return "".join(out)


def _err(status: int, error: ApiError, trace_id: str | None = None, wait: float | None = None) -> Err:
    return Err(status=status, error=error, trace_id=trace_id, retry_after=wait)


def _call(opts: internal.Options, name: str, op: Operation) -> Callable[..., Result[Any]]:
    base_origin = internal.origin_of(opts.url)

    def call(
        *,
        path: Mapping[str, Any] | None = None,
        query: Mapping[str, Any] | None = None,
        body: Any = internal.NOT_SET,
        owner_token: str | None = None,
    ) -> Result[Any]:
        path_args: Mapping[str, Any] = path if isinstance(path, Mapping) else {}
        if any(isinstance(v, str) and _DOT_SEGMENT.fullmatch(v) for v in path_args.values()):
            return _err(
                0,
                internal.api_error(
                    "invalid_path_value",
                    f'A {name} path value of "." or ".." is not a value; nothing was sent.',
                    "failed",
                ),
            )
        try:
            url = urljoin(opts.url, _fill(op.path, path_args))
        except _PathValue:
            return _err(
                0,
                internal.api_error(
                    "invalid_path_value",
                    f"A {name} path value is missing, empty, not text, or cannot be written into a URL; "
                    "nothing was sent.",
                    "failed",
                ),
            )
        try:
            pairs: dict[str, str] = {}
            for k, v in (query or {}).items():
                if v is not None:
                    pairs[js_string(k)] = js_string(v)
        except TypeError:
            return _err(
                0,
                internal.api_error(
                    "network_error",
                    f"The {name} call was not sent: a query value cannot be written into a URL.",
                    "failed",
                ),
            )
        if pairs:
            url = f"{url}?{'&'.join(f'{form_encode(k)}={form_encode(v)}' for k, v in pairs.items())}"
        # Credentials go only to the configured origin, checked on the final URL before any header is
        # attached.
        try:
            same = internal.origin_of(url) == base_origin
        except ValueError:
            same = False
        if not same:
            return _err(0, internal.off_origin(name))
        headers = {"accept": "application/json"}
        if opts.client_key is not None:
            headers[CLIENT_KEY_HEADER] = opts.client_key
        token = owner_token if owner_token is not None else opts.owner_token
        if op.auth == "owner" and token is not None:
            if not isinstance(token, str):
                return _err(0, internal.unsent_header(name))
            headers["authorization"] = f"{internal.AUTH_SCHEME} {token}"
        has_body = body is not internal.NOT_SET and body is not None
        if has_body:
            headers["content-type"] = "application/json"
        if not internal.headers_safe(headers):
            return _err(0, internal.unsent_header(name))
        try:
            text = internal.to_json(body) if has_body else None
        except (TypeError, ValueError, RecursionError):
            return _err(0, internal.unwritable_body(name))
        try:
            res = internal.send(opts, url, op.method, headers, text)
        except Exception as e:
            return _err(0, internal.no_answer(op.method, name, e))
        trace_id = res.headers.get(internal.TRACE_HEADER)
        value = res.json()
        if res.ok:
            schema = internal.answer_schema(op, path_args)
            ok, data = (False, None) if schema is internal.UNDEFINED else internal.check(schema, value)
            if ok:
                return Ok(status=res.status, body=data, trace_id=trace_id)
            return _err(res.status, internal.schema_mismatch(op.method, name), trace_id)
        error = internal.api_error_in(value)
        return _err(
            res.status,
            error
            if error is not None
            else internal.local(op.method, "unreadable_answer", f"The {name} error answer was not readable."),
            trace_id,
            internal.retry_after(res.headers.get(internal.RETRY_AFTER_HEADER)),
        )

    call.__name__ = name
    call.__qualname__ = f"Client.{name}"
    return call


class _Client:
    """The client: one attribute per call, each a method returning a Result."""

    def __repr__(self) -> str:
        return f"<temporalabs_client.Client {', '.join(sorted(vars(self)))}>"


def create_client(
    base_url: str,
    *,
    client_key: str | None = None,
    owner_token: str | None = None,
    timeout_s: float = internal.DEFAULT_TIMEOUT_S,
    http: httpx.Client | None = None,
) -> Client:
    """A client for the API at `base_url` (its origin; the paths carry /v1).

    `client_key` is a business's client key, sent on every call; left out, the caller is a wallet owner
    signing in on their own. `owner_token` is sent on owner calls unless a call passes its own. `timeout_s`
    bounds each call, body included. `http` is the httpx.Client to send with; the client never follows a
    redirect, whatever it says. A bad option raises TypeError or ValueError here, so no call raises for it.
    """
    opts = internal.check_options(
        "base_url", base_url, client_key=client_key, owner_token=owner_token, timeout_s=timeout_s, http=http
    )
    client = _Client()
    for name, op in OPERATIONS.items():
        setattr(client, name, _call(opts, name, op))
    return cast(Client, client)
