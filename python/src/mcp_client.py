"""The MCP client: the HTTP client's calls, each one `tools/call` POST to the API's MCP endpoint, with the
same Result. Credentials travel in headers, never in a tool's arguments."""

from __future__ import annotations

import json
import math
import re
from collections.abc import Callable, Mapping, Sequence
from typing import Any, Final

from . import _internal as internal
from ._result import Err, Ok, Result
from ._schema import is_number
from ._version import VERSION
from .generated.models import ApiError
from .generated.spec import CLIENT_KEY_HEADER, OPERATIONS, Operation

__all__ = ["PROTOCOL_VERSION", "is_tool", "mcp_client_for"]

# The protocol revision this client speaks.
PROTOCOL_VERSION: Final = "2026-07-28"
CLIENT_INFO: Final = {"name": "temporalabs-client", "version": VERSION}
# The protocol's code for a revision the server does not serve; its data names the ones it does.
UNSUPPORTED_PROTOCOL: Final = -32022
META: Final = {
    "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
    "io.modelcontextprotocol/clientCapabilities": {},
}
STATUS: Final = "status"
STATUS_LOOKUP: Final = "status_lookup"
_U = internal.UNDEFINED


def is_tool(t: Any) -> bool:
    """Whether a value has a tool's shape: a name, an exposure and an input schema object."""
    return (
        isinstance(t, dict)
        and isinstance(t.get("name"), str)
        and isinstance(t.get("exposure"), str)
        and isinstance(t.get("inputSchema"), dict)
    )


def _get(obj: Any, key: str) -> Any:
    """`obj?.key` in JavaScript: a member of an object, or UNDEFINED."""
    return obj.get(key, _U) if isinstance(obj, dict) else _U


def _truthy(v: Any) -> bool:
    """JavaScript's truthiness: an empty object or array is true, as is any string but the empty one."""
    if v is _U or v is None or v is False:
        return False
    if isinstance(v, int | float) and not isinstance(v, bool):
        return v != 0 and not (isinstance(v, float) and math.isnan(v))
    if isinstance(v, str):
        return v != ""
    return True


def _finite(v: Any) -> bool:
    """A JSON number JavaScript reads as finite: an int past a double's range reads as Infinity there."""
    if isinstance(v, int):
        try:
            float(v)
        except OverflowError:
            return False
        return True
    return math.isfinite(v)


def _seconds(v: Any) -> float | None:
    if is_number(v):
        n: float | None = v if _finite(v) else None
    elif isinstance(v, str):
        n = internal.small_int(v)
    else:
        return None
    return n if n is not None and 0 <= n <= internal.MAX_RETRY_AFTER_S else None


def _unreadable(method: str, name: str) -> ApiError:
    return internal.local(method, "unreadable_answer", f"The {name} answer was not readable.")


def _api_error(value: Any) -> ApiError | None:
    """An API error, if the value is one the document allows (the same rule as the HTTP client)."""
    return internal.api_error_in({"error": value}) if value is not _U else None


def _rpc_error(res: internal.Answer, error: Any, method: str, name: str) -> Err:
    """A JSON-RPC error as a Result: the endpoint's own refusal (an API error), a protocol revision it no
    longer serves, or unreadable."""
    code = _get(error, "code")
    if is_number(code) and code == UNSUPPORTED_PROTOCOL:
        supported = _get(_get(error, "data"), "supported")
        # Only date-shaped revisions are quoted: the rest of the list is the endpoint's text, not the
        # protocol's.
        dates = (
            [s for s in supported if isinstance(s, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", s, re.ASCII)]
            if isinstance(supported, list)
            else []
        )
        listed = ", ".join(dates) if dates else "none named"
        return Err(
            status=res.status,
            error=internal.api_error(
                "unsupported_protocol",
                f"The MCP endpoint no longer serves protocol {PROTOCOL_VERSION}; it serves {listed}. "
                "Upgrade temporalabs-client.",
                "failed",
            ),
        )
    # A refusal before the protocol layer (the origin check; a deployment with no MCP endpoint) is a plain API
    # error body, `{ error: { code, message, outcome } }`, so `error` is itself the API error.
    api = _api_error(_get(error, "data"))
    if api is None:
        api = _api_error(error)
    wait = _seconds(res.headers.get("retry-after"))
    if api is None:
        return Err(status=res.status, error=_unreadable(method, name))
    return Err(status=res.status, error=api, trace_id=api.traceId, retry_after=wait)


def _headers(
    opts: internal.Options, method: str, name: str | None, owner: bool, token: Any
) -> dict[str, str]:
    headers = {
        "accept": "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": PROTOCOL_VERSION,
        "mcp-method": method,
    }
    if name:
        headers["mcp-name"] = name
    if opts.client_key is not None:
        headers[CLIENT_KEY_HEADER] = opts.client_key
    token = token if token is not None else opts.owner_token
    if owner and token is not None:
        # A token that is not text cannot be a header value: the header check refuses the call.
        headers["authorization"] = f"Bearer {token}" if isinstance(token, str) else "\x00"
    return headers


def _is_json(res: internal.Answer) -> bool:
    return "application/json" in (res.headers.get("content-type") or "")


def _text_value(text: Any) -> Any:
    """The tool's text read as JSON, as JavaScript's JSON.parse reads it; UNDEFINED when it is not JSON."""
    if text is _U:
        return _U
    if isinstance(text, str):
        return internal.parse_json_text(text)
    if text is None or isinstance(text, bool) or (is_number(text) and _finite(text)):
        return text
    return _U


def _first(content: Any) -> Any:
    if isinstance(content, list):
        return content[0] if content else _U
    return _get(content, "0")


def _call_tool(
    opts: internal.Options, tool: Mapping[str, Any], name: str, op: Operation
) -> Callable[..., Result[Any]]:
    def call(
        *,
        path: Mapping[str, Any] | None = None,
        query: Mapping[str, Any] | None = None,
        body: Any = internal.NOT_SET,
        owner_token: str | None = None,
    ) -> Result[Any]:
        # Only mappings are read: a call never raises for what it was given.
        args: dict[str, Any] = {
            **(path if isinstance(path, Mapping) else {}),
            **(query if isinstance(query, Mapping) else {}),
        }
        if body is not internal.NOT_SET and body is not None:
            args["body"] = body
        headers = _headers(opts, "tools/call", tool["name"], tool["exposure"] == "owner", owner_token)
        if not internal.headers_safe(headers):
            return Err(status=0, error=internal.unsent_header(name))
        try:
            rpc_body = internal.to_json(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "tools/call",
                    "params": {"name": tool["name"], "arguments": args, "_meta": META},
                }
            )
        except (TypeError, ValueError, RecursionError):
            return Err(status=0, error=internal.unwritable_body(name))
        try:
            res = internal.send(opts, opts.url, "POST", headers, rpc_body)
        except Exception:
            return Err(
                status=0, error=internal.local(op.method, "network_error", f"The {name} call got no answer.")
            )
        # The endpoint answers in JSON; anything else (a stream, a page) is not its answer.
        if not _is_json(res):
            return Err(status=res.status, error=_unreadable(op.method, name))
        rpc = res.json()
        error = _get(rpc, "error")
        if _truthy(error):
            return _rpc_error(res, error, op.method, name)
        result = _get(rpc, "result")
        value = _text_value(_get(_first(_get(result, "content")), "text"))
        if _truthy(_get(result, "isError")):
            v = value if value is not _U and value is not None else {}
            api = _api_error(_get(v, "error"))
            said = _get(v, "status")
            # A non-2xx HTTP status stands; otherwise the body's status is used only when it is an error
            # status.
            status = res.status
            if (
                res.ok
                and is_number(said)
                and _finite(said)
                and float(said).is_integer()
                and 400 <= said <= 599
            ):
                status = int(said)
            wait = _seconds(_get(v, "retryAfter"))
            if api is None:
                return Err(status=status, error=_unreadable(op.method, name))
            return Err(status=status, error=api, trace_id=api.traceId, retry_after=wait)
        if not res.ok:
            return Err(status=res.status, error=_unreadable(op.method, name))
        schema = internal.answer_schema(op, path)
        ok, data = (False, None) if schema is _U or value is _U else internal.check(schema, value)
        trace_id = res.headers.get(internal.TRACE_HEADER)
        if ok:
            return Ok(status=res.status, body=data, trace_id=trace_id)
        return Err(status=res.status, error=internal.schema_mismatch(op.method, name), trace_id=trace_id)

    call.__name__ = name
    return call


def _list_tools(opts: internal.Options) -> Callable[..., Result[tuple[dict[str, Any], ...]]]:
    def list_tools(*, owner_token: str | None = None) -> Result[tuple[dict[str, Any], ...]]:
        # The owner token goes too, when there is one: the endpoint lists the owner tools only to a caller
        # with it.
        headers = _headers(opts, "tools/list", None, True, owner_token)
        if not internal.headers_safe(headers):
            return Err(status=0, error=internal.unsent_header("tool list"))
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {"_meta": META}})
        try:
            res = internal.send(opts, opts.url, "POST", headers, body)
        except Exception:
            return Err(status=0, error=internal.local("GET", "network_error", "The tool list got no answer."))
        unreadable = Err(
            status=res.status,
            error=internal.local("GET", "unreadable_answer", "The tool list was not readable."),
        )
        # The endpoint answers in JSON, and every item of the list must be a tool.
        if not _is_json(res):
            return unreadable
        rpc = res.json()
        error = _get(rpc, "error")
        if _truthy(error):
            return _rpc_error(res, error, "GET", "tool list")
        # A list on a non-2xx answer is not the endpoint's answer, as for a tool call.
        if not res.ok:
            return unreadable
        tools = _get(_get(rpc, "result"), "tools")
        if isinstance(tools, list) and all(is_tool(t) for t in tools):
            return Ok(status=res.status, body=tuple(tools))
        return unreadable

    return list_tools


class _McpClient:
    """The client: one attribute per published tool, `status_lookup` beside `status`, and `list_tools`."""

    def __repr__(self) -> str:
        return f"<temporalabs_client.McpClient {', '.join(sorted(vars(self)))}>"


def mcp_client_for(opts: internal.Options, tools: Sequence[Mapping[str, Any]]) -> Any:
    """The client over a given tool list: each tool a method, plus `status_lookup` when `status` is a tool."""
    client = _McpClient()
    client.list_tools = _list_tools(opts)  # type: ignore[attr-defined]
    for t in tools:
        op = OPERATIONS.get(t["name"])
        if op is None:
            continue
        setattr(client, t["name"], _call_tool(opts, t, t["name"], op))
        if t["name"] == STATUS and STATUS_LOOKUP in OPERATIONS:
            setattr(client, STATUS_LOOKUP, _call_tool(opts, t, STATUS_LOOKUP, OPERATIONS[STATUS_LOOKUP]))
    return client
