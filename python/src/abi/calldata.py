"""Hand decoding of contract calldata against a fixed list of calls. It refuses anything that is not exactly
one of them, rather than guessing."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Literal

# A 32-byte argument word: an address (20 bytes, the rest zero) or a uint256.
Word = Literal["address", "uint"]

SELECTOR_HEX = 8
WORD_HEX = 64
ADDRESS_HEX = 40
HEX_BYTES = re.compile(r"0x(?:[0-9a-fA-F]{2})*", re.ASCII)


@dataclass(frozen=True)
class Decoded:
    """The call's selector (lower case) and its argument words: an address as `0x` text, a uint as an int."""

    ok: Literal[True]
    selector: str
    words: list[int | str] = field(default_factory=list)


@dataclass(frozen=True)
class Refused:
    """Why not: `encoding`, not whole hex bytes with a selector; `selector`, a selector not in the list;
    `canonical`, a known selector whose arguments are not exactly their canonical encoding (a wrong length, or
    bits set above an address's 20 bytes)."""

    ok: Literal[False]
    refused: Literal["encoding", "selector", "canonical"]
    selector: str | None = None


def decode_call(data: str, calls: Mapping[str, Sequence[Word]]) -> Decoded | Refused:
    if not isinstance(data, str) or not HEX_BYTES.fullmatch(data) or len(data) < 2 + SELECTOR_HEX:
        return Refused(ok=False, refused="encoding")
    selector = data[: 2 + SELECTOR_HEX].lower()
    args = calls.get(selector)
    if args is None:
        return Refused(ok=False, refused="selector", selector=selector)
    body = data[2 + SELECTOR_HEX :]
    if len(body) != len(args) * WORD_HEX:
        return Refused(ok=False, refused="canonical", selector=selector)
    words: list[int | str] = []
    for i, kind in enumerate(args):
        word = body[i * WORD_HEX : (i + 1) * WORD_HEX]
        if kind == "address":
            if word[: WORD_HEX - ADDRESS_HEX].strip("0"):
                return Refused(ok=False, refused="canonical", selector=selector)
            words.append(f"0x{word[WORD_HEX - ADDRESS_HEX :]}")
        else:
            words.append(int(word, 16))
    return Decoded(ok=True, selector=selector, words=words)
