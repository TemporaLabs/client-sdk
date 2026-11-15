"""Shared paths and helpers for the tests."""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

PACKAGE = Path(__file__).resolve().parent.parent
REPO = PACKAGE.parent


def read_case(name: str) -> Any:
    """A shared fixture from cases/, which the TypeScript tests read too."""
    return json.loads((REPO / "cases" / name).read_text(encoding="utf-8"))


@dataclass
class Seen:
    """The requests a test transport received."""

    requests: list[httpx.Request] = field(default_factory=list)

    def __len__(self) -> int:
        return len(self.requests)

    def __getitem__(self, i: int) -> httpx.Request:
        return self.requests[i]


def transport(respond: Callable[[httpx.Request], httpx.Response]) -> tuple[httpx.Client, Seen]:
    """An httpx client whose every request is answered by `respond`, and the list of what it was sent."""
    seen = Seen()

    def handler(request: httpx.Request) -> httpx.Response:
        request.read()
        seen.requests.append(request)
        return respond(request)

    return httpx.Client(transport=httpx.MockTransport(handler)), seen


def answer(status: int, body: Any = None, headers: dict[str, str] | None = None) -> httpx.Response:
    """A response with a JSON body (or the text given), and a trace id unless other headers are given."""
    content = b"" if body is None else body.encode() if isinstance(body, str) else json.dumps(body).encode()
    return httpx.Response(
        status, content=content, headers={"x-trace-id": "t-1"} if headers is None else headers
    )
