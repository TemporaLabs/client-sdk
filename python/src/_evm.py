"""EVM facts the step checks share: which chains a step may be on, and what counts as an address.

The checks may be stricter than the API, never looser: a chain the API does not serve, or an address whose
mixed-case checksum is wrong, is refused before anything reaches a wallet. The TypeScript client's
`typescript/src/evm.ts` is the same rule.
"""

from __future__ import annotations

import re
from typing import Any, Final

# The EVM chains the API serves (`GET /v1/chains`, API 0.1.3), by chain id. A step or a vault on any other
# chain is refused. A chain the API adds later is refused until a client release adds it here: stricter, never
# looser.
SERVED_CHAINS: Final[tuple[str, ...]] = ("1", "56", "143", "4663", "8453", "42161")

_CHAIN: Final = re.compile(r"eip155:([1-9][0-9]*)", re.ASCII)
_ADDRESS_SHAPE: Final = re.compile(r"0x[0-9a-fA-F]{40}", re.ASCII)


def served_chain(value: Any) -> str | None:
    """The chain id of an `eip155:<id>` chain the API serves, or None for any other value."""
    m = _CHAIN.fullmatch(value) if isinstance(value, str) else None
    return m.group(1) if m and m.group(1) in SERVED_CHAINS else None


def is_address(value: Any) -> bool:
    """Whether `value` is an address: `0x` and 40 hex digits, all lower case, all upper case, or mixed
    case with a correct EIP-55 checksum. A mixed-case address with a wrong checksum is most likely mistyped,
    and is refused."""
    if not isinstance(value, str) or _ADDRESS_SHAPE.fullmatch(value) is None:
        return False
    hex_ = value[2:]
    if hex_ in (hex_.lower(), hex_.upper()):
        return True
    return value == to_checksum(hex_)


def to_checksum(hex_: str) -> str:
    """The EIP-55 form of 40 hex digits."""
    lower = hex_.lower()
    digest = keccak256(lower.encode("ascii"))
    out = []
    for i, ch in enumerate(lower):
        nibble = (digest[i >> 1] >> (4 if i % 2 == 0 else 0)) & 0xF
        out.append(ch.upper() if nibble >= 8 else ch)
    return "0x" + "".join(out)


# Keccak-256 (the original Keccak padding, as Ethereum uses; not hashlib's SHA3-256), over 64-bit lanes.
_MASK: Final = (1 << 64) - 1
_ROUND_CONSTANTS: Final = (
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
)  # fmt: skip
_ROTATIONS: Final = (
    0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
)  # fmt: skip
_RATE: Final = 136


def _rotl(x: int, n: int) -> int:
    return x if n == 0 else ((x << n) | (x >> (64 - n))) & _MASK


def _permute(s: list[int]) -> None:
    for rc in _ROUND_CONSTANTS:
        c = [s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20] for x in range(5)]
        for x in range(5):
            d = c[(x + 4) % 5] ^ _rotl(c[(x + 1) % 5], 1)
            for y in range(0, 25, 5):
                s[y + x] ^= d
        b = [0] * 25
        for x in range(5):
            for y in range(5):
                b[y + 5 * ((2 * x + 3 * y) % 5)] = _rotl(s[x + 5 * y], _ROTATIONS[x + 5 * y])
        for x in range(5):
            for y in range(5):
                s[x + 5 * y] = b[x + 5 * y] ^ (~b[(x + 1) % 5 + 5 * y] & _MASK & b[(x + 2) % 5 + 5 * y])
        s[0] ^= rc


def keccak256(data: bytes) -> bytes:
    """Keccak-256 of `data`, as 32 bytes."""
    padded = bytearray(data)
    padded += bytes(-(len(data) + 1) % _RATE + 1)
    padded[len(data)] ^= 0x01
    padded[-1] ^= 0x80
    s = [0] * 25
    for off in range(0, len(padded), _RATE):
        for i in range(_RATE // 8):
            s[i] ^= int.from_bytes(padded[off + i * 8 : off + i * 8 + 8], "little")
        _permute(s)
    return b"".join(s[i].to_bytes(8, "little") for i in range(4))
