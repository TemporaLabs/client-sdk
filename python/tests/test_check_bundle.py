"""A vault deposit's steps offered as one wallet_sendCalls batch, from cases/vault-bundle.json, which the
TypeScript tests read too: the batch must be exactly the checked steps, from the owner, on the vault's chain,
all-or-nothing."""

from __future__ import annotations

from typing import Any

import pytest
from temporalabs_client import BundleCheck, check_bundle
from temporalabs_client.check import BUNDLE_FIELDS

from conftest import read_case

FX = read_case("vault-bundle.json")
DEPOSIT = {"action": "deposit", "vault": FX["vault"], "owner": FX["owner"], "assets": FX["assets"]}
ADMITTED = next(c["request"] for c in FX["cases"] if c["admit"])


@pytest.mark.parametrize("c", FX["cases"], ids=lambda c: c["case"])
def test_the_shared_cases(c: dict[str, Any]) -> None:
    want = BundleCheck(ok=True) if c["admit"] else BundleCheck(ok=False, reason=c["reason"])
    assert check_bundle(c["request"], DEPOSIT) == want


def test_refuses_a_bundle_for_a_withdrawal() -> None:
    intent = {"action": "withdraw", "vault": FX["vault"], "owner": FX["owner"], "amount": {"kind": "all"}}
    assert check_bundle(ADMITTED, intent) == BundleCheck(
        ok=False, reason="a bundle is offered only for a deposit"
    )


def test_refuses_a_bundle_for_an_amount_other_than_the_one_asked_for() -> None:
    assert check_bundle(ADMITTED, {**DEPOSIT, "assets": "2000001"}).ok is False


def test_keeps_its_field_lists_read_only() -> None:
    with pytest.raises(TypeError):
        BUNDLE_FIELDS["sendCalls"] = ("capabilities",)  # type: ignore[index]
