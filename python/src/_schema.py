"""The run-time answer checks the generated models are built from.

Each piece checks one JSON Schema keyword the way the TypeScript client's validator does, so that both clients
accept and refuse the same answers: a string's length, pattern and format, a number's bounds, an enum or
const, an array's size, `oneOf`, `allOf`, and an object's `additionalProperties`. Every value is checked
exactly as JSON gives it: a boolean is never a number, a number is never a string, and no value is coerced
into another type. Not part of the public interface.
"""

from __future__ import annotations

import encodings.idna
import ipaddress
import math
import re
import unicodedata
from collections.abc import Callable
from typing import Any, ClassVar

from pydantic import BaseModel, ConfigDict, GetCoreSchemaHandler, TypeAdapter, model_validator
from pydantic_core import PydanticCustomError, core_schema

__all__ = [
    "JS_WHITESPACE",
    "JsAllOf",
    "JsArray",
    "JsBool",
    "JsEmptyObject",
    "JsLiteral",
    "JsNever",
    "JsNumber",
    "JsObject",
    "JsOneOf",
    "JsString",
    "js_trim",
    "translate_pattern",
]

# What JavaScript's String.prototype.trim and the regular expression class \s take as white space.
JS_WHITESPACE = (
    "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)
_WS_CLASS = "".join(f"\\u{ord(c):04x}" for c in JS_WHITESPACE)
# The largest integer a JavaScript number holds exactly.
MAX_SAFE_INTEGER = 2**53 - 1


def js_trim(s: str) -> str:
    return s.strip(JS_WHITESPACE)


def _fail(kind: str, message: str) -> PydanticCustomError:
    return PydanticCustomError(kind, message)


def _plain(validate: Callable[[Any], Any]) -> core_schema.CoreSchema:
    return core_schema.no_info_plain_validator_function(validate)


# ------------------------------------------------------------------------------------------------------------
# Patterns: a JSON Schema `pattern` is an ECMAScript regular expression, tested unanchored and without flags.
# ------------------------------------------------------------------------------------------------------------

_QUANTIFIER = re.compile(r"\{\d+(?:,\d*)?\}")
_KEPT_ESCAPES = set("dDwWbBnrtfv0123456789")


def translate_pattern(source: str) -> re.Pattern[str]:
    """The pattern as a Python regular expression that matches what JavaScript's `new RegExp(source)` matches.

    `$` ends only the whole text, `.` stops at every JavaScript line terminator, `\\s` is JavaScript's white
    space and `\\d`, `\\w` and `\\b` are ASCII only, as they are in JavaScript. A construct with no faithful
    translation raises ValueError, so the generator fails rather than check a value differently.
    """
    out: list[str] = []
    i = 0
    n = len(source)
    while i < n:
        c = source[i]
        if c == "\\":
            if i + 1 >= n:
                raise ValueError("a pattern ends in a lone backslash")
            out.append(_escape(source[i + 1], in_class=False))
            i += 2
        elif c == "[":
            j, cls = _char_class(source, i)
            out.append(cls)
            i = j
        elif c == "$":
            out.append(r"\Z")
            i += 1
        elif c == ".":
            out.append(r"[^\n\r\u2028\u2029]")
            i += 1
        elif c == "(" and source.startswith("(?<", i) and not source.startswith(("(?<=", "(?<!"), i):
            out.append("(?P<")
            i += 3
        elif c == "{":
            m = _QUANTIFIER.match(source, i)
            if m:
                out.append(m.group(0))
                i = m.end()
            else:
                out.append(r"\{")
                i += 1
        elif c == "}":
            out.append(r"\}")
            i += 1
        else:
            out.append(c)
            i += 1
    return re.compile("".join(out), re.ASCII)


def _escape(c: str, *, in_class: bool) -> str:
    if c == "s":
        return _WS_CLASS if in_class else f"[{_WS_CLASS}]"
    if c == "S":
        if in_class:
            raise ValueError(r"\S inside a character class has no faithful translation")
        return f"[^{_WS_CLASS}]"
    if c in "ux":
        return "\\" + c
    if c in ("c", "k", "p", "P"):
        raise ValueError(f"the escape \\{c} has no faithful translation")
    if c in _KEPT_ESCAPES:
        if in_class and c in "bB":
            # Inside a class, JavaScript's \b is a backspace; \B is an error there.
            if c == "B":
                raise ValueError(r"\B inside a character class")
            return r"\x08"
        return "\\" + c
    # Any other escaped character stands for itself.
    return re.escape(c)


def _char_class(source: str, start: int) -> tuple[int, str]:
    i = start + 1
    negated = source.startswith("^", i)
    if negated:
        i += 1
    parts: list[str] = []
    has_s = has_not_s = False
    while True:
        if i >= len(source):
            raise ValueError("a character class is not closed")
        c = source[i]
        if c == "]":
            i += 1
            break
        if c == "\\":
            if i + 1 >= len(source):
                raise ValueError("a pattern ends in a lone backslash")
            e = source[i + 1]
            if e == "S":
                has_not_s = True
            else:
                if e == "s":
                    has_s = True
                parts.append(_escape(e, in_class=True))
            i += 2
            continue
        # Characters Python reads specially inside a class (or warns about) are written escaped.
        parts.append(re.escape(c) if c in "[&~|" else c)
        i += 1
    if has_not_s:
        # [\s\S] and the like match every character; anything else with \S is refused.
        if not has_s or negated:
            raise ValueError(r"\S inside a character class has no faithful translation")
        return i, r"[\s\S]"
    body = "".join(parts)
    if body == "":
        # JavaScript's [] matches nothing and [^] matches any character.
        return i, (r"[\s\S]" if negated else "(?!)")
    return i, f"[{'^' if negated else ''}{body}]"


# ------------------------------------------------------------------------------------------------------------
# Formats: the ones the TypeScript client's validator checks. The generator refuses any other it would check.
# ------------------------------------------------------------------------------------------------------------

_DATE = (
    r"(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])"
    r"-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))"
)
_HHMM = r"(?:[01]\d|2[0-3]):[0-5]\d"
DATE_RE = re.compile(rf"{_DATE}", re.ASCII)
DATE_TIME_RE = re.compile(
    rf"{_DATE}T(?:{_HHMM}:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))", re.ASCII
)
TIME_RE = re.compile(
    r"(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)", re.ASCII
)

# The formats the TypeScript client's validator checks. A format outside this set is not checked there either.
CHECKED_FORMATS = frozenset(
    {
        "email",
        "uri",
        "uri-reference",
        "uuid",
        "guid",
        "date-time",
        "date",
        "time",
        "duration",
        "hostname",
        "ipv4",
        "ipv6",
        "mac",
        "cidr",
        "cidr-v6",
        "base64",
        "base64url",
        "e164",
        "credit_card",
        "iban",
        "jwt",
        "emoji",
        "nanoid",
        "cuid",
        "cuid2",
        "ulid",
        "xid",
        "ksuid",
    }
)
# The checked formats this client implements; the generator fails on the others.
SUPPORTED_FORMATS = frozenset({"uri", "uri-reference", "date-time", "date", "time"})

_SPECIAL_SCHEMES = {"http", "https", "ws", "wss", "ftp", "file"}
_FORBIDDEN_HOST = set("\x00\t\n\r #/:<>?@[\\]^|")
_FORBIDDEN_DOMAIN = _FORBIDDEN_HOST | {chr(c) for c in range(0x20)} | {"%", "\x7f"}
_SCHEME = re.compile(r"[A-Za-z][A-Za-z0-9+.\-]*:")


def clean_url(value: str) -> str:
    """The URL as a WHATWG URL parser reads it: no leading or trailing control characters or spaces, and no
    tab or line break anywhere."""
    return (
        value.strip("".join(chr(c) for c in range(0x21)))
        .replace("\t", "")
        .replace("\n", "")
        .replace("\r", "")
    )


def url_parses(value: str) -> bool:
    """Whether a WHATWG URL parser, given no base, parses `value`: what `URL.canParse` answers in
    JavaScript."""
    s = clean_url(value)
    m = _SCHEME.match(s)
    if not m:
        return False
    scheme = m.group(0)[:-1].lower()
    rest = s[m.end() :]
    if scheme in _SPECIAL_SCHEMES:
        if scheme == "file":
            return _file_ok(rest)
        rest = rest.lstrip("/\\")
        authority = re.split(r"[/\\?#]", rest, maxsplit=1)[0]
        host_port = authority.rpartition("@")[2]
        if host_port == "":
            return False
        return _host_port_ok(host_port, special=True)
    if not rest.startswith("//"):
        return True
    authority = re.split(r"[/?#]", rest[2:], maxsplit=1)[0]
    host_port = authority.rpartition("@")[2]
    return host_port == "" or _host_port_ok(host_port, special=False)


def _file_ok(rest: str) -> bool:
    """A file URL after `file:`: with `//`, its host is empty, a Windows drive letter (read as the path), a
    bracketed IPv6 address or a domain; never credentials or a port."""
    r = rest.replace("\\", "/")
    if not r.startswith("//"):
        return True
    host = re.split(r"[/?#]", r[2:], maxsplit=1)[0]
    if host == "" or re.fullmatch(r"[A-Za-z][:|]", host, re.ASCII):
        return True
    if host.startswith("["):
        return host.endswith("]") and _host_port_ok(host, special=True)
    if "@" in host or ":" in host:
        return False
    return _domain_ok(host)


def _host_port_ok(host_port: str, *, special: bool) -> bool:
    if host_port.startswith("["):
        end = host_port.find("]")
        if end == -1:
            return False
        host, after = host_port[: end + 1], host_port[end + 1 :]
        if after and not after.startswith(":"):
            return False
        port = after[1:] if after else ""
    else:
        host, _, port = host_port.partition(":")
    if port and (
        not re.fullmatch(r"[0-9]+", port, re.ASCII)
        or len(port.lstrip("0")) > 5
        or int(port.lstrip("0") or "0") > 65535
    ):
        return False
    if host.startswith("["):
        inner = host[1:-1]
        if "%" in inner:
            return False
        try:
            ipaddress.IPv6Address(inner)
        except ValueError:
            return False
        return True
    if host == "":
        return not special
    if not special:
        return not any(ch in _FORBIDDEN_HOST for ch in host)
    return _domain_ok(host)


# The characters a URL parser reads as the dot between labels (Unicode UTS 46).
_LABEL_DOTS = (".", "\u3002", "\uff0e", "\uff61")


def _label_text_ok(text: str) -> bool:
    """Whether a decoded label is text one host label may hold: none of the characters a URL parser reads
    as a dot, and, once its compatibility forms are folded (fullwidth to ASCII, as the URL parser does), no
    forbidden host character. A fullwidth solidus would otherwise show a label as a path."""
    if any(dot in text for dot in _LABEL_DOTS):
        return False
    folded = unicodedata.normalize("NFKC", text)
    return not any(ch in _FORBIDDEN_DOMAIN or ch == "." for ch in folded)


def _domain_ok(host: str) -> bool:
    try:
        decoded = _percent_decode(host).decode("utf-8")
    except UnicodeDecodeError:
        return False
    try:
        if decoded.isascii():
            ascii_host = decoded.lower()
            for label in ascii_host.split("."):
                if label.startswith("xn--"):
                    # A punycode label must decode to something, and to text a host may hold: an empty, plain
                    # ASCII or control-character decoding is refused, as the WHATWG URL parser refuses it, and
                    # so is one holding a full stop, which the parser would read as two labels.
                    unicode = label[4:].encode("ascii").decode("punycode")
                    if unicode == "" or unicode.isascii() or not _label_text_ok(unicode):
                        return False
                    encodings.idna.ToASCII(unicode)
        else:
            ascii_host = ".".join(
                label.encode("idna").decode("ascii") if label and not label.isascii() else label.lower()
                for label in decoded.split(".")
            )
    except ValueError:  # UnicodeError is a ValueError
        return False
    if ascii_host == "" or any(ch in _FORBIDDEN_DOMAIN for ch in ascii_host):
        return False
    labels = ascii_host.split(".")
    last = labels[-2] if labels[-1] == "" and len(labels) > 1 else labels[-1]
    if re.fullmatch(r"[0-9]+|0[xX][0-9a-fA-F]*", last, re.ASCII):
        return _ipv4_ok(labels[:-1] if labels[-1] == "" else labels)
    return True


def _percent_decode(s: str) -> bytes:
    raw = s.encode("utf-8")
    out = bytearray()
    i = 0
    while i < len(raw):
        if raw[i] == 0x25 and i + 2 < len(raw) and re.fullmatch(rb"[0-9a-fA-F]{2}", raw[i + 1 : i + 3]):
            out.append(int(raw[i + 1 : i + 3], 16))
            i += 3
        else:
            out.append(raw[i])
            i += 1
    return bytes(out)


def _ipv4_ok(parts: list[str]) -> bool:
    if len(parts) > 4:
        return False
    numbers: list[int] = []
    for p in parts:
        if p == "":
            return False
        if re.fullmatch(r"0[xX][0-9a-fA-F]*", p, re.ASCII):
            numbers.append(int(p[2:] or "0", 16))
        elif re.fullmatch(r"0[0-7]+", p, re.ASCII):
            numbers.append(int(p, 8))
        elif re.fullmatch(r"0[0-9]+", p, re.ASCII):
            # A leading zero makes the part octal, as WHATWG URL parsing reads it: an 8 or a 9 is invalid.
            return False
        elif re.fullmatch(r"[0-9]+", p, re.ASCII):
            # Past ten significant digits the part is beyond any IPv4 field; int() refuses a very long one.
            if len(p.lstrip("0")) > 10:
                return False
            numbers.append(int(p, 10))
        else:
            return False
    if any(x > 255 for x in numbers[:-1]):
        return False
    return bool(numbers[-1] < 256 ** (5 - len(numbers)))


def _check_format(fmt: str, v: str) -> str:
    if fmt in ("uri", "uri-reference"):
        trimmed = js_trim(v)
        if not url_parses(trimmed):
            raise _fail("format", "not a URL")
        # The TypeScript client's validator returns the URL as it parsed it: trimmed, with tabs and line
        # breaks removed.
        return trimmed.replace("\t", "").replace("\n", "").replace("\r", "")
    pattern = {"date-time": DATE_TIME_RE, "date": DATE_RE, "time": TIME_RE}[fmt]
    if not pattern.fullmatch(v):
        raise _fail("format", f"not a {fmt}")
    return v


# ------------------------------------------------------------------------------------------------------------
# Scalars.
# ------------------------------------------------------------------------------------------------------------


class JsString:
    """A JSON string, with the narrowing keywords beside `type: string`."""

    def __init__(
        self,
        *,
        min_length: int | None = None,
        max_length: int | None = None,
        pattern: str | None = None,
        format: str | None = None,
    ) -> None:
        self.min_length = min_length
        self.max_length = max_length
        self.pattern = translate_pattern(pattern) if pattern else None
        self.format = format if format in SUPPORTED_FORMATS else None
        if format in CHECKED_FORMATS and format not in SUPPORTED_FORMATS:
            raise ValueError(f"the string format {format} is not supported")

    def validate(self, v: Any) -> str:
        if not isinstance(v, str):
            raise _fail("string_type", "not a string")
        if self.format is not None:
            v = _check_format(self.format, v)
        # Lengths count characters (code points), as the TypeScript client's validator does.
        if self.min_length is not None and len(v) < self.min_length:
            raise _fail("string_too_short", "too short")
        if self.max_length is not None and len(v) > self.max_length:
            raise _fail("string_too_long", "too long")
        if self.pattern is not None and not self.pattern.search(v):
            raise _fail("string_pattern_mismatch", "does not match its pattern")
        out: str = v
        return out

    def __get_pydantic_core_schema__(
        self, source: Any, handler: GetCoreSchemaHandler
    ) -> core_schema.CoreSchema:
        return _plain(self.validate)


def is_number(v: Any) -> bool:
    """A JSON number: an int or a float, never a bool."""
    return isinstance(v, int | float) and not isinstance(v, bool)


class JsNumber:
    """A JSON number (or integer), with its bounds. Read as JavaScript reads it: a finite double."""

    def __init__(
        self,
        *,
        integer: bool = False,
        minimum: float | None = None,
        maximum: float | None = None,
        exclusive_minimum: float | bool | None = None,
        exclusive_maximum: float | bool | None = None,
    ) -> None:
        self.integer = integer
        self.checks: list[tuple[str, float]] = []
        # A boolean exclusive bound (an older draft's form) makes its sibling bound exclusive.
        if is_number(minimum) and exclusive_minimum is not True:
            self.checks.append((">=", minimum))  # type: ignore[arg-type]
        if is_number(maximum) and exclusive_maximum is not True:
            self.checks.append(("<=", maximum))  # type: ignore[arg-type]
        if is_number(exclusive_minimum):
            self.checks.append((">", exclusive_minimum))  # type: ignore[arg-type]
        elif exclusive_minimum is True and is_number(minimum):
            self.checks.append((">", minimum))  # type: ignore[arg-type]
        if is_number(exclusive_maximum):
            self.checks.append(("<", exclusive_maximum))  # type: ignore[arg-type]
        elif exclusive_maximum is True and is_number(maximum):
            self.checks.append(("<", maximum))  # type: ignore[arg-type]

    def validate(self, v: Any) -> float:
        if not is_number(v):
            raise _fail("number_type", "not a number")
        if isinstance(v, int) and abs(v) > MAX_SAFE_INTEGER:
            # JavaScript reads a number this large as the nearest double; one too large to hold is Infinity.
            try:
                v = float(v)
            except OverflowError:
                raise _fail("number_type", "not a finite number") from None
        if isinstance(v, float):
            if not math.isfinite(v):
                raise _fail("number_type", "not a finite number")
            if self.integer:
                if not v.is_integer():
                    raise _fail("int_type", "not a whole number")
                v = int(v)
        if self.integer and abs(v) > MAX_SAFE_INTEGER:
            raise _fail("int_type", "not a safe integer")
        for op, bound in self.checks:
            if not (
                (op == ">=" and v >= bound)
                or (op == "<=" and v <= bound)
                or (op == ">" and v > bound)
                or (op == "<" and v < bound)
            ):
                raise _fail("number_bound", f"not {op} {bound}")
        out: float = v
        return out

    def __get_pydantic_core_schema__(
        self, source: Any, handler: GetCoreSchemaHandler
    ) -> core_schema.CoreSchema:
        return _plain(self.validate)


class JsBool:
    def __get_pydantic_core_schema__(
        self, source: Any, handler: GetCoreSchemaHandler
    ) -> core_schema.CoreSchema:
        def validate(v: Any) -> bool:
            if not isinstance(v, bool):
                raise _fail("bool_type", "not a boolean")
            return v

        return _plain(validate)


class JsNever:
    """No value: an empty `enum`."""

    def __get_pydantic_core_schema__(
        self, source: Any, handler: GetCoreSchemaHandler
    ) -> core_schema.CoreSchema:
        def validate(v: Any) -> Any:
            raise _fail("never", "no value is allowed here")

        return _plain(validate)


class JsLiteral:
    """An `enum` or a `const`. A string, number, boolean or null matches an equal value of the same JSON type;
    an object or an array matches nothing, as in the TypeScript client's validator, which compares them by
    identity."""

    def __init__(self, *values: Any) -> None:
        self.values = values

    def matches(self, v: Any) -> bool:
        for want in self.values:
            if want is None and v is None:
                return True
            if isinstance(want, bool) and isinstance(v, bool) and v == want:
                return True
            if is_number(want) and is_number(v) and v == want:
                return True
            if isinstance(want, str) and isinstance(v, str) and v == want:
                return True
        return False

    def __get_pydantic_core_schema__(
        self, source: Any, handler: GetCoreSchemaHandler
    ) -> core_schema.CoreSchema:
        def validate(v: Any) -> Any:
            if not self.matches(v):
                raise _fail("literal_error", "not one of the allowed values")
            return v

        return _plain(validate)


# ------------------------------------------------------------------------------------------------------------
# Arrays, compositions and objects.
# ------------------------------------------------------------------------------------------------------------


class JsArray:
    """`minItems` and `maxItems` on a list the annotation's own type validates."""

    def __init__(self, *, min_items: int | None = None, max_items: int | None = None) -> None:
        self.min_items = min_items
        self.max_items = max_items

    def __get_pydantic_core_schema__(
        self, source: Any, handler: GetCoreSchemaHandler
    ) -> core_schema.CoreSchema:
        def check(v: list[Any]) -> list[Any]:
            if self.min_items is not None and len(v) < self.min_items:
                raise _fail("too_short", "too few items")
            if self.max_items is not None and len(v) > self.max_items:
                raise _fail("too_long", "too many items")
            return v

        def array_only(v: Any) -> Any:
            # A JSON array only: never a tuple, a set or a mapping.
            if not isinstance(v, list):
                raise _fail("list_type", "not an array")
            return v

        return core_schema.no_info_before_validator_function(
            array_only, core_schema.no_info_after_validator_function(check, handler(source))
        )


class _Branches:
    def __init__(self, *types: Any) -> None:
        self.types = types
        self._adapters: list[TypeAdapter[Any]] | None = None

    def adapters(self) -> list[TypeAdapter[Any]]:
        if self._adapters is None:
            self._adapters = [TypeAdapter(t) for t in self.types]
        return self._adapters


class JsOneOf(_Branches):
    """`oneOf`: exactly one branch takes the value."""

    def __get_pydantic_core_schema__(
        self, source: Any, handler: GetCoreSchemaHandler
    ) -> core_schema.CoreSchema:
        def validate(v: Any) -> Any:
            taken: list[Any] = []
            for a in self.adapters():
                try:
                    taken.append(a.validate_python(v))
                except ValueError:
                    continue
            if len(taken) != 1:
                raise _fail("one_of", f"{len(taken)} alternatives take this value, not exactly one")
            return taken[0]

        return _plain(validate)


class JsAllOf(_Branches):
    """`allOf`: every branch takes the value. The first branch's reading is kept."""

    def __get_pydantic_core_schema__(
        self, source: Any, handler: GetCoreSchemaHandler
    ) -> core_schema.CoreSchema:
        def validate(v: Any) -> Any:
            out = [a.validate_python(v) for a in self.adapters()]
            return out[0]

        return _plain(validate)


class JsEmptyObject:
    """An object with no fields at all: no properties and `additionalProperties: false`."""

    def __get_pydantic_core_schema__(
        self, source: Any, handler: GetCoreSchemaHandler
    ) -> core_schema.CoreSchema:
        def validate(v: Any) -> dict[str, Any]:
            if not isinstance(v, dict) or v:
                raise _fail("empty_object", "not an empty object")
            return v

        return _plain(validate)


class JsObject(BaseModel):
    """A JSON object with named fields. Wire names are kept as they are; a field whose name is not a Python
    name is reached by its alias. A field that is not required may be left out, but is null only where its
    schema allows null. Fields the document does not name are kept, in `model_extra`, unless the schema closes
    the object."""

    model_config = ConfigDict(frozen=True, strict=True, extra="allow")

    # The wire names of the optional fields whose schema does not take null.
    js_not_null: ClassVar[frozenset[str]] = frozenset()
    # The type every field the document does not name must have (`additionalProperties` as a schema), if any.
    js_extra: ClassVar[Any] = None

    @model_validator(mode="before")
    @classmethod
    def _js_object(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            raise _fail("model_type", "not an object")
        for name in cls.js_not_null:
            if name in data and data[name] is None:
                raise _fail("none_not_allowed", f"{name} is not nullable")
        return data

    @model_validator(mode="after")
    def _js_extra(self) -> JsObject:
        cls = type(self)
        extra = self.__pydantic_extra__
        if cls.js_extra is not None and extra:
            adapter = _EXTRA_ADAPTERS.get(cls)
            if adapter is None:
                adapter = _EXTRA_ADAPTERS[cls] = TypeAdapter(cls.js_extra)
            for k, v in list(extra.items()):
                extra[k] = adapter.validate_python(v)
        return self


_EXTRA_ADAPTERS: dict[type[JsObject], TypeAdapter[Any]] = {}
