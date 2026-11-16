"""Keccak-256 and the EIP-55 address checksum the step checks rely on, against published vectors and an
independent implementation's output (viem's keccak256) across the 136-byte block boundary. The TypeScript
client's tests/evm.test.ts holds the same vectors."""

from __future__ import annotations

from typing import Any

import pytest
from temporalabs_client._evm import SERVED_CHAINS, is_address, keccak256, served_chain, to_checksum

VIEM = [
    (135, "34367dc248bbd832f4e3e69dfaac2f92638bd0bbd18f2912ba4ef454919cf446"),
    (136, "a6c4d403279fe3e0af03729caada8374b5ca54d8065329a3ebcaeb4b60aa386e"),
    (137, "d869f639c7046b4929fc92a4d988a8b22c55fbadb802c0c66ebcd484f1915f39"),
    (200, "96ea54061def936c4be90b518992fdc6f12f535068a256229aca54267b4d084d"),
    (272, "cf7fcd4f705ee749930d19ca84561a9bf62516bd90a471545fa2f49fdc7e63c8"),
    (1000, "b6a4ac1f51884d71f30fa397a5e155de3099e11fc0edef5d08b646e621e19de9"),
]
# The examples in EIP-55 itself.
VECTORS = [
    "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
    "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
    "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
]


def test_published_digests() -> None:
    assert keccak256(b"").hex() == "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
    assert keccak256(b"abc").hex() == "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"


@pytest.mark.parametrize(("n", "want"), VIEM)
def test_agrees_with_an_independent_implementation(n: int, want: str) -> None:
    assert keccak256(b"a" * n).hex() == want


@pytest.mark.parametrize("a", VECTORS)
def test_checksums_as_eip55_does_and_admits_it(a: str) -> None:
    assert to_checksum(a[2:].lower()) == a
    assert is_address(a)
    assert is_address(a.lower())
    assert is_address("0x" + a[2:].upper())


@pytest.mark.parametrize("a", VECTORS)
def test_refuses_any_one_letter_in_the_wrong_case(a: str) -> None:
    for i in range(2, len(a)):
        c = a[i]
        if c.lower() == c.upper():
            continue
        flipped = a[:i] + (c.upper() if c == c.lower() else c.lower()) + a[i + 1 :]
        if flipped[2:] in (flipped[2:].lower(), flipped[2:].upper()):
            continue
        assert not is_address(flipped)


@pytest.mark.parametrize(
    "v",
    [
        None,
        7,
        "",
        "0x",
        "0X5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
        "5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
        "0x5aaeb6053f3e94c9b9a09f33669435e7ef1bea",
        "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaedd",
        "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaeg",
    ],
)
def test_refuses_what_is_not_an_address(v: Any) -> None:
    assert not is_address(v)


def test_served_chains_cannot_be_widened_at_run_time() -> None:
    assert isinstance(SERVED_CHAINS, tuple)
    with pytest.raises(AttributeError):
        SERVED_CHAINS.append("999")  # type: ignore[attr-defined]
    assert served_chain("eip155:999") is None


@pytest.mark.parametrize("i", SERVED_CHAINS)
def test_reads_a_served_chain(i: str) -> None:
    assert served_chain(f"eip155:{i}") == i


@pytest.mark.parametrize(
    "v",
    [
        "eip155:999999999",
        "eip155:08453",
        "eip155:0",
        "eip155:",
        "eip155",
        "solana:mainnet",
        "garbage",
        " eip155:8453",
        "eip155:8453\n",
        8453,
        None,
    ],
)
def test_refuses_a_chain_the_api_does_not_serve(v: Any) -> None:
    assert served_chain(v) is None


def test_rebinding_served_chains_does_not_widen_served_chain(monkeypatch: pytest.MonkeyPatch) -> None:
    import temporalabs_client._evm as evm

    monkeypatch.setattr(evm, "SERVED_CHAINS", (*SERVED_CHAINS, "999"))
    assert served_chain("eip155:999") is None
    assert served_chain("eip155:8453") == "8453"
