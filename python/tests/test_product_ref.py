"""A vault answers with its share ticker, and a product can be named four ways: its id, its share ticker, its
vault address, or that address with its chain (CAIP-10). Ported from typescript/tests/productRef.test.ts."""

from __future__ import annotations

import httpx
import pytest
from temporalabs_client import _internal as internal
from temporalabs_client import create_client
from temporalabs_client.generated import models

from conftest import transport

ADDRESS = "0x" + "aB" * 20
VAULT = {
    "standard": "erc4626",
    "shareSymbol": "tlExampleUSDC",
    "chain": "eip155:8453",
    "vaultAddress": ADDRESS,
    "assetAddress": ADDRESS,
    "assetDecimals": 6,
    "shareDecimals": 18,
}
FORMS = ["example-product", "tlExampleUSDC", ADDRESS, f"eip155:8453:{ADDRESS}"]


def test_a_vault_carries_its_share_ticker_and_an_answer_without_one_does_not_match() -> None:
    ok, vault = internal.check(models.VaultIdentity, VAULT)
    assert ok and vault.shareSymbol == "tlExampleUSDC"
    without = {k: v for k, v in VAULT.items() if k != "shareSymbol"}
    assert internal.check(models.VaultIdentity, without)[0] is False


@pytest.mark.parametrize("ref", FORMS)
def test_a_product_reference_admits(ref: str) -> None:
    assert internal.check(models.ProductRef, ref)[0] is True


@pytest.mark.parametrize("ref", ["Example Product", "Example-Product", "eip155:8453:0x12", ""])
def test_a_product_reference_refuses(ref: str) -> None:
    assert internal.check(models.ProductRef, ref)[0] is False


def test_is_sent_in_the_path_encoded_for_each_of_the_four_forms() -> None:
    http, seen = transport(lambda _: httpx.Response(404))
    client = create_client("https://api.example", http=http)
    for ref in FORMS:
        client.product(path={"id": ref})
    assert [str(r.url) for r in seen.requests] == [
        "https://api.example/v1/products/example-product",
        "https://api.example/v1/products/tlExampleUSDC",
        f"https://api.example/v1/products/{ADDRESS}",
        f"https://api.example/v1/products/eip155%3A8453%3A{ADDRESS}",
    ]
