"""The Tempora API's calls over its MCP endpoint, with the same names and the same Result as the HTTP client,
and the API's published tool list to pin. Every call returns a result and never raises."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any, Final, cast

import httpx

from . import _internal as internal
from .generated.operations import McpClient
from .generated.spec import API_VERSION
from .generated.tools import TOOLS
from .mcp_client import PROTOCOL_VERSION, is_tool, mcp_client_for

__all__ = ["PROTOCOL_VERSION", "RELEASED", "TOOLS", "McpClient", "create_mcp_client", "tool_breaks"]

# The API's released tool list as one document, the shape `tool_breaks` takes: what a consumer pins.
RELEASED: Final[Mapping[str, Any]] = {"version": API_VERSION, "tools": TOOLS}


def create_mcp_client(
    url: str,
    *,
    client_key: str | None = None,
    owner_token: str | None = None,
    timeout_s: float = internal.DEFAULT_TIMEOUT_S,
    http: httpx.Client | None = None,
) -> McpClient:
    """A client for the MCP endpoint at `url`, such as https://<mcp origin>/mcp.

    `client_key` is sent on every call when given; `owner_token` on owner tools and on `list_tools`, unless a
    call passes its own. A bad option raises TypeError or ValueError here; a call never raises.
    """
    opts = internal.check_options(
        "url", url, client_key=client_key, owner_token=owner_token, timeout_s=timeout_s, http=http
    )
    return cast(McpClient, mcp_client_for(opts, TOOLS))


# How deep inside an input the comparison goes; a schema nested deeper is reported as a break, not compared.
MAX_SCHEMA_DEPTH: Final = 64


class _TooDeep(Exception):
    pass


def _props(s: Mapping[str, Any]) -> Mapping[str, Any]:
    p = s.get("properties")
    return p if isinstance(p, dict) else {}


def _required(s: Mapping[str, Any]) -> list[Any]:
    r = s.get("required")
    return r if isinstance(r, list) else []


def _canonical(x: Any, depth: int = 0) -> str:
    """A schema as one string whatever its key order, so two alternatives compare by content."""
    if depth > MAX_SCHEMA_DEPTH:
        raise _TooDeep
    if isinstance(x, list):
        return "[" + ",".join(_canonical(v, depth + 1) for v in x) + "]"
    if isinstance(x, dict):
        return "{" + ",".join(f"{json.dumps(k)}:{_canonical(x[k], depth + 1)}" for k in sorted(x)) + "}"
    return json.dumps(x)


def _input_breaks(
    tool: str, was: Mapping[str, Any], now: Mapping[str, Any], path: str, out: list[str], depth: int = 0
) -> None:
    """The input changes under `path` that could break a caller: a field removed, a field made required, and
    the same for every object field inside, at any depth (not inside array items). An alternative (`oneOf`,
    `anyOf`) may be added; one changed or removed is reported, since a caller may be sending exactly that
    one."""
    if depth > MAX_SCHEMA_DEPTH:
        raise _TooDeep
    before = _props(was)
    after = _props(now)
    for name, w in before.items():
        at = path + name
        if name not in after:
            out.append(f"{tool}: input {at} removed")
            continue
        n = after[name]
        if not isinstance(w, dict) or not isinstance(n, dict):
            continue
        _input_breaks(tool, w, n, f"{at}.", out, depth + 1)
        for key in ("oneOf", "anyOf"):
            if not isinstance(w.get(key), list):
                continue
            current = {_canonical(v) for v in (n[key] if isinstance(n.get(key), list) else [])}
            if any(_canonical(alt) not in current for alt in w[key]):
                out.append(f"{tool}: input {at}: an alternative was changed or removed")
    had = set(_required(was))
    for r in _required(now):
        if r not in had:
            out.append(f"{tool}: input {path}{r} is now required")


def _readable(doc: Any) -> bool:
    tools = doc.get("tools") if isinstance(doc, Mapping) else None
    return isinstance(tools, list | tuple) and all(is_tool(t) for t in tools)


def tool_breaks(released: Mapping[str, Any], current: Mapping[str, Any]) -> list[str]:
    """Every change from a released tool list that could break a client pinned to it; an empty list means only
    additions.

    The API holds itself to the same rule: no tool removed, no input removed or made required (at any depth
    inside an object input such as `body`), no output schema dropped, no change of exposure, no read made
    writable, no destructive tool marked safe. It does not compare a field's type, an enum's members or an
    output schema's content, so a field retyped, an enum narrowed or an output schema replaced passes: pin
    those with your own tests.
    """
    # A list that is not tools cannot be compared, so it is reported as a break rather than passed or raised
    # on.
    if not _readable(released) or not _readable(current):
        return [f"{'the current' if _readable(released) else 'the released'} tool list is not readable"]
    out: list[str] = []
    now = {t["name"]: t for t in current["tools"]}
    for was in released["tools"]:
        name = was["name"]
        is_ = now.get(name)
        if is_ is None:
            out.append(f"{name}: removed")
            continue
        if is_["exposure"] != was["exposure"]:
            out.append(f"{name}: exposure changed from {was['exposure']} to {is_['exposure']}")
        if was.get("outputSchema") is not None and is_.get("outputSchema") is None:
            out.append(f"{name}: output schema removed")
        was_notes = was.get("annotations") if isinstance(was.get("annotations"), dict) else {}
        is_notes = is_.get("annotations") if isinstance(is_.get("annotations"), dict) else {}
        if was_notes.get("readOnlyHint") is True and is_notes.get("readOnlyHint") is not True:
            out.append(f"{name}: no longer read-only")
        if was_notes.get("destructiveHint") is True and is_notes.get("destructiveHint") is not True:
            out.append(f"{name}: no longer marked destructive")
        try:
            _input_breaks(name, was["inputSchema"], is_["inputSchema"], "", out)
        except _TooDeep:
            out.append(f"{name}: input nested too deep to compare (more than {MAX_SCHEMA_DEPTH} levels)")
    return out
