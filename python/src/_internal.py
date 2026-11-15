"""What both entry points share: the answer checks, the option checks and the one function that sends a
request. Not part of the public interface."""

from __future__ import annotations

import json
import math
import queue
import re
import threading
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Final, Literal
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel, TypeAdapter

from ._schema import url_parses
from .generated.models import ApiError, ErrorBody
from .generated.spec import UNKNOWN_CODES, Operation

DEFAULT_TIMEOUT_S: Final = 30.0
TRACE_HEADER: Final = "x-trace-id"
# The longest wait the client passes on as `retry_after`, in seconds: one day. A longer one is left out.
MAX_RETRY_AFTER_S: Final = 86_400
# The longest timeout, in seconds: the largest delay a JavaScript timer accepts, so both clients take the
# same range.
MAX_TIMEOUT_S: Final = (2**31 - 1) / 1000
# The statuses a fetch would follow as a redirect. The client follows none: one is no answer at all.
REDIRECT_STATUSES: Final = frozenset({301, 302, 303, 307, 308})
LOCAL_HOSTS: Final = ("localhost", "127.0.0.1", "::1")


class _Undefined:
    """No value at all, as distinct from JSON null."""

    def __repr__(self) -> str:
        return "UNDEFINED"


UNDEFINED: Final = _Undefined()

# ------------------------------------------------------------------------------------------------------------
# Errors the client makes itself.
# ------------------------------------------------------------------------------------------------------------


def api_error(code: str, message: str, outcome: Literal["refused", "failed", "unknown"]) -> ApiError:
    return ApiError.model_validate({"code": code, "message": message, "outcome": outcome})


def local(method: str, code: Literal["network_error", "unreadable_answer"], message: str) -> ApiError:
    """A write whose answer was lost may have gone through, so it is `unknown`; a lost read changed
    nothing."""
    return api_error(code, message, "unknown" if method == "POST" else "failed")


def off_origin(name: str) -> ApiError:
    return api_error(
        "wrong_origin", f"The {name} call would leave the configured origin; nothing was sent.", "failed"
    )


def unwritable_body(name: str) -> ApiError:
    return api_error(
        "network_error", f"The {name} call was not sent: its body cannot be written as JSON.", "failed"
    )


def unsent_header(name: str) -> ApiError:
    return api_error(
        "network_error",
        f"The {name} call was not sent: a key or token is not a valid header value.",
        "failed",
    )


def schema_mismatch(method: str, name: str) -> ApiError:
    return local(method, "unreadable_answer", f"The {name} answer did not match its schema.")


# ------------------------------------------------------------------------------------------------------------
# Answer checks.
# ------------------------------------------------------------------------------------------------------------

_adapters: dict[int, tuple[Any, TypeAdapter[Any]]] = {}


def check(schema: Any, value: Any) -> tuple[bool, Any]:
    """The value read through the schema's type, or (False, None). A type that cannot become a validator
    leaves the answer unread, never a raised call."""
    if value is UNDEFINED:
        return False, None
    try:
        entry = _adapters.get(id(schema))
        if entry is None or entry[0] is not schema:
            entry = _adapters[id(schema)] = (schema, TypeAdapter(schema))
        return True, entry[1].validate_python(value)
    except Exception:
        return False, None


def answer_schema(op: Operation, path: Mapping[str, Any] | None) -> Any:
    """One answer shape per read (x-outputs), looked up by the read's own name."""
    if op.outputs is None:
        return op.response
    read = str(path.get("read")) if isinstance(path, Mapping) else "undefined"
    return op.outputs.get(read, UNDEFINED)


def api_error_in(body: Any) -> ApiError | None:
    """The API error in an error body, when the document allows it. A code that may hide a moved request must
    say `unknown`; any other pairing is unreadable."""
    ok, parsed = check(ErrorBody, body)
    if not ok:
        return None
    error: ApiError = parsed.error
    return error if error.code not in UNKNOWN_CODES or error.outcome == "unknown" else None


def parse_json(data: bytes) -> Any:
    """The body read as a JavaScript fetch reads it with `json()`: UTF-8 (a bad byte read as U+FFFD, a leading
    byte order mark dropped), plain JSON only (no NaN or Infinity), or UNDEFINED when it is not JSON."""
    text = data.decode("utf-8", errors="replace")
    if text.startswith("\ufeff"):
        text = text[1:]
    try:
        return json.loads(text, parse_constant=_no_constant)
    except Exception:
        return UNDEFINED


def parse_json_text(text: str) -> Any:
    """Text read as JavaScript's JSON.parse reads it: plain JSON only, or UNDEFINED."""
    try:
        return json.loads(text, parse_constant=_no_constant)
    except Exception:
        return UNDEFINED


def _no_constant(name: str) -> Any:
    raise ValueError(f"{name} is not JSON")


def to_json(value: Any) -> str:
    """The value as JavaScript's JSON.stringify writes it; raises TypeError or ValueError for what it cannot
    write. A model is written by its wire names, with only the fields that were set."""
    return json.dumps(_jsonable(value, 0), separators=(",", ":"), ensure_ascii=False, allow_nan=False)


_MAX_DEPTH = 1_000


def _jsonable(v: Any, depth: int) -> Any:
    if depth > _MAX_DEPTH:
        raise ValueError("nested too deep")
    if isinstance(v, BaseModel):
        return _jsonable(v.model_dump(mode="python", by_alias=True, exclude_unset=True), depth + 1)
    if v is None or isinstance(v, str | bool | int):
        return v
    if isinstance(v, float):
        # JSON.stringify writes NaN and the infinities as null.
        return v if math.isfinite(v) else None
    if isinstance(v, Mapping):
        out = {}
        for k, x in v.items():
            if not isinstance(k, str):
                raise TypeError("an object key is not a string")
            out[k] = _jsonable(x, depth + 1)
        return out
    if isinstance(v, list | tuple):
        return [_jsonable(x, depth + 1) for x in v]
    raise TypeError(f"a {type(v).__name__} cannot be written as JSON")


def retry_after(header: str | None) -> int | None:
    """Retry-After in whole seconds, up to a day; a date or anything longer is left out."""
    n = small_int(header) if header is not None else None
    return n if n is not None and n <= MAX_RETRY_AFTER_S else None


def small_int(text: str) -> int | None:
    """Whole seconds or a port: digits only, at most 9 significant digits; None otherwise, never raising."""
    if not re.fullmatch(r"[0-9]+", text, re.ASCII) or len(text.lstrip("0")) > 9:
        return None
    return int(text)


# ------------------------------------------------------------------------------------------------------------
# Options.
# ------------------------------------------------------------------------------------------------------------

_HEADER_SAFE = re.compile(r"[\t\x20-\x7e]*")


def header_safe(v: str) -> bool:
    """What an HTTP header value may hold here: visible ASCII, spaces and tabs."""
    return _HEADER_SAFE.fullmatch(v) is not None


def headers_safe(headers: Mapping[str, str]) -> bool:
    return all(header_safe(v) for v in headers.values())


@dataclass(frozen=True)
class Options:
    """The options both clients share, read once when the client is made: the copy is what was checked and
    what every call uses."""

    url: str
    client_key: str | None
    owner_token: str | None
    timeout_s: float
    http: httpx.Client


def check_options(
    url_name: str,
    url: Any,
    *,
    client_key: Any,
    owner_token: Any,
    timeout_s: Any,
    http: Any,
) -> Options:
    """The options both clients take, checked the same way: a bad one raises TypeError or ValueError when the
    client is made, so a call never raises for them."""
    if not isinstance(url, str):
        raise TypeError(f"{url_name} must be a string, an absolute URL such as https://api.example.com")
    url = check_url(url_name, url)
    if timeout_s is None:
        timeout_s = DEFAULT_TIMEOUT_S
    if isinstance(timeout_s, bool) or not isinstance(timeout_s, int | float):
        raise TypeError(f"timeout_s must be a number of seconds; got {timeout_s!r}")
    if not (math.isfinite(timeout_s) and 0 < timeout_s <= MAX_TIMEOUT_S):
        raise ValueError(f"timeout_s must be above 0 and at most {MAX_TIMEOUT_S} seconds; got {timeout_s!r}")
    if client_key is not None:
        if not isinstance(client_key, str):
            raise TypeError("client_key must be a string")
        # A blank key would be sent as no key at all.
        if client_key.strip() == "":
            raise ValueError("client_key is empty: leave it out for a caller with no key, or give the key")
        check_header_value("client_key", client_key)
    if owner_token is not None:
        if not isinstance(owner_token, str):
            raise TypeError("owner_token must be a string")
        if owner_token == "":
            raise ValueError(
                "owner_token is empty: leave it out for a caller with no token, or give the token"
            )
        check_header_value("owner_token", owner_token)
    if http is not None and not isinstance(http, httpx.Client):
        raise TypeError("http must be an httpx.Client")
    return Options(
        url=url,
        client_key=client_key,
        owner_token=owner_token,
        timeout_s=float(timeout_s),
        http=http if http is not None else httpx.Client(follow_redirects=False),
    )


def clean_url(value: str) -> str:
    """The URL as a WHATWG URL parser reads it: no leading or trailing control characters or spaces, and no
    tab or line break anywhere."""
    return (
        value.strip("".join(chr(c) for c in range(0x21)))
        .replace("\t", "")
        .replace("\n", "")
        .replace("\r", "")
    )


def check_url(name: str, value: str) -> str:
    """The URL, cleaned as a WHATWG URL parser cleans it, when it is an https URL or an http one to
    this machine."""
    cleaned = clean_url(value)
    try:
        u = urlsplit(cleaned)
        port = u.port
    except ValueError:
        u, port = None, None
    if u is None or not url_parses(cleaned):
        raise ValueError(f"{name} must be an absolute URL, such as https://api.example.com; got {value!r}")
    scheme = u.scheme.lower()
    if u.username is not None or u.password is not None:
        raise ValueError(f"{name} must not carry a user name or password; got {u.hostname}")
    if scheme not in ("http", "https"):
        raise ValueError(f"{name} must use https or http; got {scheme}:")
    # A key or token sent over plain http can be read on the way, so http is only for this machine.
    if scheme == "http" and (u.hostname or "").lower() not in LOCAL_HOSTS:
        host = u.hostname if port is None else f"{u.hostname}:{port}"
        raise ValueError(
            f"{name} must use https unless it is this machine (localhost, 127.0.0.1 or [::1]); got {host}"
        )
    return cleaned


def check_header_value(name: str, v: str) -> None:
    if not header_safe(v):
        raise ValueError(f"{name} is not a valid header value (it has a line break or a control character)")


def origin_of(url: str) -> tuple[str, str, int | None]:
    u = urlsplit(url)
    scheme = u.scheme.lower()
    default = {"http": 80, "https": 443}.get(scheme)
    port = u.port if u.port is not None else default
    return scheme, (u.hostname or "").lower(), port


# ------------------------------------------------------------------------------------------------------------
# Sending.
# ------------------------------------------------------------------------------------------------------------


class NoAnswer(Exception):
    """The request got no answer: a network failure, a redirect, a timeout, or a transport that gave
    no response."""


@dataclass
class Answer:
    """The parts of an answer the clients read. The body is read under the same deadline as the request."""

    status: int
    headers: httpx.Headers
    _results: queue.SimpleQueue[tuple[str, Any]]
    _deadline: float
    _stop: threading.Event

    @property
    def ok(self) -> bool:
        return 200 <= self.status <= 299

    def json(self) -> Any:
        """The body as JSON, or UNDEFINED when it is not JSON or did not arrive in time."""
        try:
            kind, value = self._results.get(timeout=max(0.0, self._deadline - time.monotonic()))
        except queue.Empty:
            # Stop the reader: it closes the response at its next chunk instead of buffering on.
            self._stop.set()
            return UNDEFINED
        return parse_json(value) if kind == "body" else UNDEFINED


def send(opts: Options, url: str, method: str, headers: dict[str, str], body: str | None) -> Answer:
    """One request, under the client's timeout. Redirects are refused: a followed redirect would carry the
    credentials to wherever it points. The request runs on its own thread, so the timeout holds through the
    body's last byte, even for a transport that ignores its own timeouts; a request still running at the
    deadline is abandoned: the reader stops at its next chunk and closes the response."""
    deadline = time.monotonic() + opts.timeout_s
    results: queue.SimpleQueue[tuple[str, Any]] = queue.SimpleQueue()
    stop = threading.Event()

    def run() -> None:
        try:
            request = opts.http.build_request(
                method,
                url,
                headers=headers,
                content=body.encode("utf-8") if body is not None else None,
                timeout=httpx.Timeout(opts.timeout_s),
            )
            response = opts.http.send(request, stream=True, follow_redirects=False)
        except BaseException as e:
            results.put(("error", e))
            return
        try:
            if not isinstance(response, httpx.Response):
                results.put(("error", TypeError("the transport did not give a response")))
                return
            if response.status_code in REDIRECT_STATUSES:
                results.put(("error", NoAnswer("a redirect, which the client never follows")))
                return
            if stop.is_set():
                return
            results.put(("response", response))
            try:
                chunks: list[bytes] = []
                for chunk in response.iter_bytes():
                    if stop.is_set() or time.monotonic() >= deadline:
                        results.put(("body-error", NoAnswer("the body did not arrive before the timeout")))
                        return
                    chunks.append(chunk)
                results.put(("body", b"".join(chunks)))
            except BaseException as e:
                results.put(("body-error", e))
        finally:
            if isinstance(response, httpx.Response):
                response.close()

    threading.Thread(target=run, name="temporalabs-client-request", daemon=True).start()
    try:
        kind, value = results.get(timeout=opts.timeout_s)
    except queue.Empty:
        stop.set()
        raise NoAnswer("no answer before the timeout") from None
    if kind != "response":
        raise NoAnswer("no answer") from value if isinstance(value, BaseException) else None
    return Answer(
        status=value.status_code, headers=value.headers, _results=results, _deadline=deadline, _stop=stop
    )
