"""The answers both clients must judge alike, from cases/answers.json, which typescript/tests/answers.test.ts
reads too: every named shape, every call's answer, every product read and the error bodies, each with the
verdict the answer check gives. A verdict that changes here must change in the TypeScript client in the same
change."""

from __future__ import annotations

import json
from typing import Any

import pytest
from temporalabs_client import _internal as internal
from temporalabs_client.generated import models
from temporalabs_client.generated.spec import OPERATIONS

from conftest import REPO, read_case

CASES = read_case("answers.json")
NAMED = list(CASES["schemas"])


def verdicts(o: dict[str, list[Any]]) -> list[tuple[Any, bool]]:
    return [(v, True) for v in o["accept"]] + [(v, False) for v in o["reject"]]


def test_covers_every_named_shape_every_call_and_every_read() -> None:
    spec = json.loads((REPO / "spec" / "openapi.json").read_text(encoding="utf-8"))
    assert sorted(CASES["schemas"]) == sorted(spec["components"]["schemas"])
    assert sorted(CASES["operations"]) == sorted(OPERATIONS)
    for name, op in OPERATIONS.items():
        assert sorted(CASES["operations"][name].get("reads", {})) == sorted(op.outputs or {})


def test_has_a_value_to_accept_and_one_to_refuse_for_every_shape_and_call() -> None:
    for o in [*CASES["schemas"].values(), *CASES["operations"].values()]:
        assert o["accept"] and o["reject"]


@pytest.mark.parametrize("name", NAMED)
def test_named_shape(name: str) -> None:
    shape = getattr(models, name)
    for value, ok in verdicts(CASES["schemas"][name]):
        assert (value, internal.check(shape, value)[0]) == (value, ok)


@pytest.mark.parametrize("name", sorted(CASES["operations"]))
def test_call_answer(name: str) -> None:
    op = OPERATIONS[name]
    o = CASES["operations"][name]
    for value, ok in verdicts(o):
        assert (value, internal.check(op.response, value)[0]) == (value, ok)
    for read, r in o.get("reads", {}).items():
        assert op.outputs is not None
        for value, ok in verdicts(r):
            assert (read, value, internal.check(op.outputs[read], value)[0]) == (read, value, ok)


def test_error_bodies() -> None:
    for case in CASES["errors"]:
        read = internal.api_error_in(case["body"])
        got = None if read is None else {"code": read.code, "outcome": read.outcome}
        assert (case["body"], got) == (case["body"], case["error"])


def test_urls_with_thousands_of_leading_zeros_read_as_whatwg_reads_them() -> None:
    from temporalabs_client._schema import url_parses

    z = "0" * 5000
    assert url_parses(f"http://h:{z}80/") is True
    assert url_parses(f"http://{z}5/") is True  # octal 5
    assert url_parses(f"http://{z}9/") is False  # 9 is not an octal digit
