"""The generator, ported from typescript/tests/generate.test.ts, with the checks that are this generator's
own: the pattern translation, the formats it checks and the Python names it prints."""

from __future__ import annotations

import copy
import importlib.util
import json
import re
import shutil
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from types import ModuleType
from typing import Any

import httpx
import pytest
from pydantic import TypeAdapter
from temporalabs_client import Err, create_client
from temporalabs_client._schema import translate_pattern
from temporalabs_client.generated import models
from temporalabs_client.generated.spec import OPERATIONS

from conftest import PACKAGE, REPO, answer, transport


def _load_generator() -> ModuleType:
    spec = importlib.util.spec_from_file_location("generate", PACKAGE / "scripts" / "generate.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules["generate"] = module
    spec.loader.exec_module(module)
    return module


gen = _load_generator()
SPEC: dict[str, Any] = json.loads((REPO / "spec" / "openapi.json").read_text(encoding="utf-8"))
TOOL_DOC = gen.read_tool_doc(REPO)


def clone() -> dict[str, Any]:
    return copy.deepcopy(SPEC)


class TestTheApiDocumentInSpec:
    def test_has_the_17_calls_each_with_its_auth(self) -> None:
        ops = {o.id: o.auth for o in gen.operations_of(SPEC)}
        assert len(ops) == 17
        expected = {
            "products": "none",
            "sign_in_challenge": "client",
            "account": "owner",
            "withdraw": "owner",
            "submit": "owner",
        }
        assert {k: ops[k] for k in expected} == expected

    def test_every_named_shape_every_answer_and_the_error_body_become_validators(self) -> None:
        for name in SPEC["components"]["schemas"]:
            TypeAdapter(getattr(models, name))
        for op in OPERATIONS.values():
            TypeAdapter(op.response)
            for t in (op.outputs or {}).values():
                TypeAdapter(t)
        TypeAdapter(models.ErrorBody)

    def test_every_ref_points_at_a_named_shape(self) -> None:
        refs = re.findall(r'"\$ref": ?"#/components/schemas/([^"]+)"', json.dumps(SPEC))
        assert len(refs) > 100
        for r in refs:
            assert r in SPEC["components"]["schemas"]


def fails(mutate: Callable[[dict[str, Any]], Any], why: str) -> None:
    s = clone()
    mutate(s)
    with pytest.raises(gen.GenerateError, match=why):
        gen.generate(s)


def schemas(s: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = s["components"]["schemas"]
    return out


def move_path(s: dict[str, Any], old: str, new: str) -> None:
    s["paths"][new] = s["paths"].pop(old)


class TestTheGeneratorFailsClosed:
    def test_on_a_ref_outside_the_named_shapes(self) -> None:
        fails(
            lambda s: schemas(s)["Tvl"]["properties"].__setitem__("usd", {"$ref": "#/elsewhere/Usd"}),
            r"unsupported \$ref",
        )

    def test_on_a_keyword_it_cannot_type(self) -> None:
        fails(lambda s: schemas(s)["Tvl"].__setitem__("if", {}), "unsupported keyword if")

    def test_on_an_error_body_that_is_not_an_error_wrapper(self) -> None:
        def mutate(s: dict[str, Any]) -> None:
            s["components"]["responses"]["Error"]["content"]["application/json"]["schema"] = {
                "$ref": "#/components/schemas/ApiErrorSchema"
            }

        fails(mutate, r"must be \{ error")

    def test_on_a_document_that_is_not_openapi_3_1(self) -> None:
        fails(lambda s: s.__setitem__("openapi", "3.0.3"), "expected OpenAPI 3.1")

    def test_on_a_path_parameter_the_client_cannot_fill(self) -> None:
        def mutate(s: dict[str, Any]) -> None:
            op = s["paths"]["/v1/requests/{requestId}"]["get"]
            op["parameters"] = [
                {**p, "name": "request-id"} if p["name"] == "requestId" else p for p in op["parameters"]
            ]
            move_path(s, "/v1/requests/{requestId}", "/v1/requests/{request-id}")

        fails(mutate, "must be a required word name")

    def test_on_a_path_parameter_that_is_not_required(self) -> None:
        def mutate(s: dict[str, Any]) -> None:
            op = s["paths"]["/v1/requests/{requestId}"]["get"]
            op["parameters"] = [
                {**p, "required": False} if p["name"] == "requestId" else p for p in op["parameters"]
            ]

        fails(mutate, "must be a required word name")

    def test_on_a_path_that_names_a_parameter_the_call_does_not_have(self) -> None:
        fails(
            lambda s: move_path(s, "/v1/requests/{requestId}", "/v1/requests/{requestId}/{extra}"),
            r"names \{extra\}",
        )

    def test_on_a_call_without_an_operation_id(self) -> None:
        fails(lambda s: s["paths"]["/v1/positions"]["get"].pop("operationId"), "has no operationId")

    def test_on_an_unknown_security_scheme(self) -> None:
        fails(
            lambda s: s["paths"]["/v1/positions"]["get"].__setitem__("security", [{"cookie": []}]),
            "unknown security scheme",
        )

    def test_on_a_required_header(self) -> None:
        header = [{"name": "x-tenant", "in": "header", "required": True, "schema": {"type": "string"}}]
        fails(
            lambda s: s["paths"]["/v1/positions"]["get"].__setitem__("parameters", header),
            "required header x-tenant",
        )

    def test_on_a_request_body_that_is_not_json(self) -> None:
        body = {"required": True, "content": {"text/plain": {"schema": {"type": "string"}}}}
        fails(
            lambda s: s["paths"]["/v1/deposits"]["post"].__setitem__("requestBody", body),
            "no application/json schema",
        )

    def test_on_a_keyword_it_cannot_type_inside_the_items_of_a_schema_with_no_type(self) -> None:
        fails(
            lambda s: schemas(s).__setitem__("ReviewProbe", {"items": {"not": {}}}), "unsupported keyword not"
        )

    def test_on_a_keyword_it_cannot_type_inside_an_open_objects_other_fields(self) -> None:
        tvl = {
            "type": "object",
            "properties": {"usd": {"type": "number"}},
            "additionalProperties": {"not": {}},
        }
        fails(lambda s: schemas(s).__setitem__("Tvl", tvl), "unsupported keyword not")

    @pytest.mark.parametrize(
        "bad",
        [
            "//collector.example/v1/positions",
            "/v1/../../x",
            "https://collector.example/v1/positions",
            "/v1\\positions",
        ],
    )
    def test_on_a_path_that_is_not_a_plain_absolute_path(self, bad: str) -> None:
        fails(lambda s: move_path(s, "/v1/positions", bad), "is not a plain absolute path")

    # A lost answer is unknown only on a POST, so a call with any other write method would read a lost write
    # as failed.
    @pytest.mark.parametrize("method", ["put", "patch", "delete"])
    def test_on_a_method_the_client_does_not_send(self, method: str) -> None:
        def mutate(s: dict[str, Any]) -> None:
            s["paths"]["/v1/positions"][method] = {
                **s["paths"]["/v1/positions"]["get"],
                "operationId": f"positions_{method}",
            }

        fails(mutate, f"unsupported method {method}")

    # The version is written into generated source as text, so it must be a version and nothing else.
    @pytest.mark.parametrize(
        "version", ["0.1.1 */ export const injected = 1; /*", "0.1.1'\nimport os", "", "v0.1.1", "0.1"]
    )
    def test_on_an_api_version_that_is_not_a_version(self, version: str) -> None:
        fails(lambda s: s["info"].__setitem__("version", version), "API version")

    def test_on_an_error_response_without_x_unknown_codes(self) -> None:
        fails(lambda s: s["components"]["responses"]["Error"].pop("x-unknown-codes"), "x-unknown-codes")

    def test_on_an_error_code_that_names_no_codes(self) -> None:
        fails(
            lambda s: schemas(s)["ApiErrorSchema"]["properties"].__setitem__("code", {"type": "string"}),
            "names no error codes",
        )


class TestThePrinterFailsRatherThanDropPartOfASchema:
    @pytest.mark.parametrize(
        "schema",
        [
            {"$ref": "#/components/schemas/Time", "properties": {"a": {"type": "string"}}},
            {"$ref": "#/components/schemas/Time", "type": "object"},
            {"anyOf": [{"type": "string"}], "properties": {"a": {"type": "string"}}},
            {"oneOf": [{"type": "object"}], "required": ["a"]},
            {"allOf": [{"type": "array"}], "items": {"type": "string"}},
            {"enum": ["x"], "properties": {"a": {}}},
            {"const": "x", "additionalProperties": True},
            {"$ref": "#/components/schemas/Time", "anyOf": [{"type": "null"}]},
            {"enum": ["x", "y"], "const": "x"},
        ],
    )
    def test_on_a_deciding_keyword_beside_another(self, schema: dict[str, Any]) -> None:
        with pytest.raises(gen.GenerateError, match="beside"):
            gen.Printer({}).ty(schema, "X")

    def test_on_a_required_field_the_object_does_not_name(self) -> None:
        with pytest.raises(gen.GenerateError, match="required field b"):
            gen.Printer({}).ty(
                {"type": "object", "properties": {"a": {"type": "string"}}, "required": ["a", "b"]}, "X"
            )

    def test_still_prints_an_enum_or_a_const_beside_its_own_scalar_type_and_a_ref_beside_a_description(
        self,
    ) -> None:
        p = gen.Printer({})
        assert (
            p.ty({"type": "string", "enum": ["x", "y"]}, "X")
            == "Annotated[Literal['x', 'y'], JsLiteral('x', 'y')]"
        )
        assert p.ty({"type": "string", "const": "x"}, "X") == "Annotated[Literal['x'], JsLiteral('x')]"
        assert p.ty({"$ref": "#/components/schemas/Time", "description": "when"}, "X") == "Time"

    @pytest.mark.parametrize(
        ("schema", "why"),
        [
            ({"type": "string", "pattern": "^a\\cJ$"}, "cannot be checked the same way"),
            ({"type": "string", "pattern": "[\\S]"}, "cannot be checked the same way"),
            ({"type": "string", "pattern": "(unclosed"}, "cannot be checked the same way"),
            ({"type": "string", "format": "email"}, "format email"),
            ({"type": []}, "empty type list"),
            ({"type": "string", "pattern": 5}, "not a string"),
        ],
    )
    def test_on_a_pattern_or_format_this_client_cannot_check_the_same_way(
        self, schema: dict[str, Any], why: str
    ) -> None:
        with pytest.raises(gen.GenerateError, match=why):
            gen.Printer({}).ty(schema, "X")

    def test_on_a_shape_that_contains_itself(self) -> None:
        fails(
            lambda s: schemas(s)["Tvl"]["properties"].__setitem__(
                "next", {"$ref": "#/components/schemas/Tvl"}
            ),
            r"\$ref cycle through Tvl",
        )

    def test_on_two_shapes_that_would_share_a_python_name(self) -> None:
        def mutate(s: dict[str, Any]) -> None:
            schemas(s)["TvlUsd"] = {"type": "string"}
            schemas(s)["Tvl"] = {
                "type": "object",
                "properties": {"usd": {"type": "object", "properties": {"a": {}}}},
            }

        fails(mutate, "share the Python name TvlUsd")


class TestTheTypesItPrints:
    @pytest.mark.parametrize(
        ("schema", "want"),
        [
            ({"type": ["string", "null"]}, "Annotated[str, JsString()] | None"),
            ({"anyOf": [{"$ref": "#/components/schemas/Time"}, {"type": "null"}]}, "Time | None"),
            (
                {"anyOf": [{"type": "string"}, {"type": "number"}]},
                "Annotated[Annotated[str, JsString()] | Annotated[float, JsNumber()], "
                "Field(union_mode='left_to_right')]",
            ),
            (
                {"type": "array", "items": {"enum": ["x", "y"]}},
                "Annotated[list[Annotated[Literal['x', 'y'], JsLiteral('x', 'y')]], JsArray()]",
            ),
            (
                {"type": "object", "additionalProperties": {"type": "number"}},
                "dict[str, Annotated[float, JsNumber()]]",
            ),
            ({"type": "object", "additionalProperties": True}, "dict[str, Any]"),
            ({"type": "object", "additionalProperties": {}}, "dict[str, Any]"),
            ({"type": "object", "additionalProperties": False}, "Annotated[dict[str, Any], JsEmptyObject()]"),
            (
                {"type": "integer", "minimum": 0, "exclusiveMaximum": 10},
                "Annotated[int, JsNumber(integer=True, minimum=0, exclusive_maximum=10)]",
            ),
            (
                {"type": "string", "minLength": 1, "maxLength": 3, "pattern": "^a", "format": "date"},
                "Annotated[str, JsString(min_length=1, max_length=3, pattern='^a', format='date')]",
            ),
            ({"type": "string", "format": "x-custom"}, "Annotated[str, JsString()]"),
            ({"enum": []}, "Annotated[Any, JsNever()]"),
            ({"const": 1.5}, "Annotated[Any, JsLiteral(1.5)]"),
            ({}, "Any"),
            ({"properties": {"a": {"type": "string"}}}, "Any"),
        ],
    )
    def test_prints(self, schema: dict[str, Any], want: str) -> None:
        assert gen.Printer({}).ty(schema, "X") == want

    def test_an_object_with_named_fields_is_a_model_class(self) -> None:
        p = gen.Printer({})
        assert (
            p.ty(
                {
                    "type": "object",
                    "properties": {"a": {"type": "integer"}, "from": {"type": "boolean"}, "model_x": {}},
                    "required": ["a"],
                    "additionalProperties": False,
                },
                "Thing",
            )
            == "Thing"
        )
        assert p.blocks == [
            "class Thing(JsObject):\n"
            '    model_config = ConfigDict(extra="forbid")\n'
            "    js_not_null: ClassVar[frozenset[str]] = frozenset(['from'])\n"
            "    a: Annotated[int, JsNumber(integer=True)]\n"
            "    from_: Annotated[bool, JsBool()] | None = Field(default=None, alias='from')\n"
            "    model_x_: Any = Field(default=None, alias='model_x')"
        ]

    def test_an_open_object_with_a_schema_for_its_other_fields_checks_them(self) -> None:
        p = gen.Printer({})
        p.ty(
            {
                "type": "object",
                "properties": {"a": {"type": "string"}},
                "additionalProperties": {"type": "number"},
            },
            "Thing",
        )
        assert "    js_extra: ClassVar[Any] = Annotated[float, JsNumber()]" in p.blocks[-1]


class TestPatternsReadAsJavaScriptReadsThem:
    @pytest.mark.parametrize(
        ("pattern", "text", "matches"),
        [
            ("^a$", "a\n", False),
            ("^a.c$", "a\nc", False),
            ("^a.c$", "a\u2028c", False),
            ("^a.c$", "abc", True),
            ("^\\d+$", "\u0661\u0662", False),
            ("^\\w+$", "\u00e9", False),
            ("^\\s$", "\u00a0", True),
            ("^\\s$", "\u0085", False),
            ("^[\\s\\S]+$", "a\nb", True),
            ("^a{,2}$", "a{,2}", True),
            ("^[^]$", "x", True),
            ("^[]$", "", False),
            ("^(?<word>a)$", "a", True),
            ("a[b-d]", "xxcxx", False),
            ("a[b-d]", "xacx", True),
            ("^\\/$", "/", True),
        ],
    )
    def test_matches(self, pattern: str, text: str, matches: bool) -> None:
        assert (translate_pattern(pattern).search(text) is not None) is matches


class TestTheClientKeyHeaderLine:
    def test_appears_exactly_once_in_a_stable_form_and_is_the_header_the_client_sends(self) -> None:
        text = (PACKAGE / "src" / "generated" / "spec.py").read_text(encoding="utf-8")
        lines = [line for line in text.split("\n") if "CLIENT_KEY_HEADER" in line]
        assert len(lines) == 1
        m = re.fullmatch(r"CLIENT_KEY_HEADER: Final = '([^']+)'", lines[0])
        assert m and m.group(1) == "Tempora-Client-Key"
        http, seen = transport(lambda _: answer(200, {"products": []}))
        create_client("https://api.example", client_key="ck", http=http).products()
        assert seen[0].headers[m.group(1)] == "ck"


def scratch(tmp_path: Path) -> Path:
    """A copy of the parts of the repository the generator reads and writes."""
    shutil.copytree(REPO / "spec", tmp_path / "spec")
    shutil.copytree(PACKAGE / "scripts", tmp_path / "python" / "scripts")
    shutil.copytree(
        PACKAGE / "src", tmp_path / "python" / "src", ignore=shutil.ignore_patterns("__pycache__")
    )
    return tmp_path


def run_script(dir: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(dir / "python" / "scripts" / "generate.py"), *args],
        capture_output=True,
        text=True,
        check=False,
    )


class TestWhatIsCommittedIsWhatTheDocumentGenerates:
    def test_src_generated_matches_spec(self) -> None:
        for rel, text in gen.generate(SPEC, TOOL_DOC).items():
            assert (PACKAGE / rel).read_text(encoding="utf-8") == text, rel

    def test_check_passes_on_the_committed_files(self, tmp_path: Path) -> None:
        r = run_script(scratch(tmp_path), "--check")
        assert r.returncode == 0, r.stderr

    def test_check_fails_on_a_hand_edit_in_src_generated(self, tmp_path: Path) -> None:
        d = scratch(tmp_path)
        with (d / "python" / "src" / "generated" / "spec.py").open("a") as f:
            f.write("# edited\n")
        r = run_script(d, "--check")
        assert r.returncode == 1
        assert "src/generated/spec.py" in r.stderr

    def test_check_fails_on_a_file_in_src_generated_the_generator_does_not_write(
        self, tmp_path: Path
    ) -> None:
        d = scratch(tmp_path)
        (d / "python" / "src" / "generated" / "stale.py").write_text("STALE = 1\n")
        r = run_script(d, "--check")
        assert r.returncode == 1
        assert "src/generated/stale.py" in r.stderr

    def test_the_script_writes_the_same_files_it_is_tested_on(self, tmp_path: Path) -> None:
        d = scratch(tmp_path)
        out = tmp_path / "out"
        r = run_script(d, "--out", str(out))
        assert r.returncode == 0, r.stderr
        for rel in gen.generate(SPEC, TOOL_DOC):
            assert (out / rel).read_text(encoding="utf-8") == (PACKAGE / rel).read_text(encoding="utf-8")

    def test_a_document_it_does_not_understand_fails_the_script(self, tmp_path: Path) -> None:
        d = scratch(tmp_path)
        s = clone()
        s["openapi"] = "3.0.3"
        (d / "spec" / "openapi.json").write_text(json.dumps(s))
        r = run_script(d)
        assert r.returncode == 1
        assert "expected OpenAPI 3.1" in r.stderr


REQUEST = {
    "requestId": "req_0123456789",
    "action": "withdraw",
    "state": "processing",
    "chose": {"product": "example-product"},
    "expiresAt": "2026-11-09T00:00:00Z",
    "steps": [],
}


def client_answering(status: int, body: Any) -> Any:
    http, _ = transport(lambda _: httpx.Response(status, content=json.dumps(body).encode()))
    return create_client("https://api.example", client_key="ck", http=http)


def err(r: Any) -> Err:
    assert isinstance(r, Err), r
    return r


class TestAnswersAreCheckedAgainstTheDocument:
    def test_a_good_request_record_passes(self) -> None:
        assert client_answering(200, REQUEST).status(path={"requestId": "req_0123456789"}).ok is True

    def test_a_request_record_missing_a_required_field_is_unreadable(self) -> None:
        missing = {k: v for k, v in REQUEST.items() if k != "state"}
        e = err(client_answering(200, missing).status(path={"requestId": "req_0123456789"}))
        assert (e.error.code, e.error.outcome) == ("unreadable_answer", "failed")

    def test_a_nullable_reference_takes_null_a_tvl_read_with_no_as_of(self) -> None:
        r = client_answering(200, {"usd": None, "asOf": None, "stale": True}).product_read(
            path={"id": "example-product", "read": "tvl"}
        )
        assert r.ok is True

    def test_an_error_with_an_outcome_outside_the_three_is_unreadable_unknown_on_a_write(self) -> None:
        e = err(
            client_answering(
                409, {"error": {"code": "not_found", "message": "x", "outcome": "maybe"}}
            ).cancel(path={"requestId": "req_0123456789"})
        )
        assert (e.error.code, e.error.outcome) == ("unreadable_answer", "unknown")

    @pytest.mark.parametrize(
        "code", ["upstream_in_progress", "upstream_unavailable", "upstream_timeout", "upstream_unreadable"]
    )
    def test_an_unknown_code_with_any_outcome_but_unknown_is_unreadable(self, code: str) -> None:
        e = err(
            client_answering(502, {"error": {"code": code, "message": "x", "outcome": "failed"}}).positions()
        )
        assert (e.error.code, e.error.outcome) == ("unreadable_answer", "failed")
        e = err(
            client_answering(502, {"error": {"code": code, "message": "x", "outcome": "unknown"}}).positions()
        )
        assert (e.error.code, e.error.outcome) == (code, "unknown")

    def test_a_read_the_document_does_not_list_is_unreadable(self) -> None:
        r = client_answering(200, {"usd": 1, "asOf": None, "stale": False}).product_read(
            path={"id": "example-product", "read": "other"}
        )
        assert err(r).error.code == "unreadable_answer"

    def test_an_error_code_the_client_does_not_know_yet_still_passes(self) -> None:
        e = err(
            client_answering(
                503, {"error": {"code": "something_new", "message": "x", "outcome": "failed"}}
            ).products()
        )
        assert (e.error.code, e.error.outcome) == ("something_new", "failed")


def tool(name: str, exposure: str = "public") -> dict[str, Any]:
    return {
        "name": name,
        "description": f"Read {name}.",
        "exposure": exposure,
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    }


def tool_doc(tools: list[dict[str, Any]], version: str | None = None) -> dict[str, Any]:
    return {"version": version or SPEC["info"]["version"], "tools": tools}


class TestTheMcpToolList:
    def test_is_empty_until_the_api_publishes_one(self) -> None:
        out = gen.generate(SPEC)
        assert (
            "TOOLS: Final[tuple[dict[str, Any], ...]] = tuple(json.loads('[]'))"
            in out["src/generated/tools.py"]
        )

    def test_carries_the_published_tools(self) -> None:
        out = gen.generate(SPEC, tool_doc([tool("products"), tool("positions", "owner")]))
        assert '"name":"products"' in out["src/generated/tools.py"]
        assert "def positions(" in out["src/generated/operations.py"].split("class McpClient")[1]

    def test_fails_closed_on_a_bad_tool_list(self) -> None:
        with pytest.raises(gen.GenerateError, match="tool nope is not a call"):
            gen.generate(SPEC, tool_doc([tool("nope")]))
        with pytest.raises(gen.GenerateError, match="tool products is listed twice"):
            gen.generate(SPEC, tool_doc([tool("products"), tool("products")]))
        with pytest.raises(gen.GenerateError, match="tool products has exposure everyone"):
            gen.generate(SPEC, tool_doc([tool("products", "everyone")]))
        with pytest.raises(gen.GenerateError, match=r"the tool list is API 9\.9\.9"):
            gen.generate(SPEC, tool_doc([tool("products")], "9.9.9"))
