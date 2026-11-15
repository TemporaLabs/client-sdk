"""The checks take a request's steps exactly as the client returns them: `request.steps`, read as the `Step`
model. Ported from typescript/tests/stepsAsReturned.test.ts; mypy checks this file too, so a check that does
not accept the model fails it. At run time a step of a kind a check does not take is refused, as before."""

from __future__ import annotations

from typing import Any

from pydantic import TypeAdapter
from temporalabs_client import (
    StepCheck,
    StepsCheck,
    check_portfolio_deposit,
    check_portfolio_withdrawal,
    check_step,
    check_steps,
)
from temporalabs_client.generated.models import Step

CHAIN = "eip155:8453"
VAULT = "0x5555555555555555555555555555555555555555"
ASSET = "0x6666666666666666666666666666666666666666"
OWNER = "0x00000000000000000000000000000000000000a1"
APPROVE = (
    "0x095ea7b3"
    "0000000000000000000000005555555555555555555555555555555555555555"
    "00000000000000000000000000000000000000000000000000000000001e8480"
)
DEPOSIT = (
    "0x6e553f65"
    "00000000000000000000000000000000000000000000000000000000001e8480"
    "00000000000000000000000000000000000000000000000000000000000000a1"
)
GENERATION = {"generation": 1, "expiresAt": "2026-11-14T00:10:00.000Z"}
STEP: TypeAdapter[Any] = TypeAdapter(Step)


def tx(step_id: str, purpose: str, to: str, data: str) -> Any:
    return STEP.validate_python(
        {
            "stepId": step_id,
            "chainId": CHAIN,
            "state": "ready",
            "checks": [],
            "kind": "send_transaction",
            "purpose": purpose,
            "payload": {**GENERATION, "to": to, "data": data, "value": "0"},
        }
    )


intent: Any = {
    "action": "deposit",
    "vault": {"chain": CHAIN, "vaultAddress": VAULT, "assetAddress": ASSET},
    "owner": OWNER,
    "assets": "2000000",
}


def test_check_steps_and_check_step_admit_a_vault_deposit_read_as_step_models() -> None:
    steps = [tx("s1", "approve", ASSET, APPROVE), tx("s2", "deposit", VAULT, DEPOSIT)]
    assert check_steps(steps, intent) == StepsCheck(ok=True)
    assert check_step(steps[0], intent, "approve") == StepCheck(ok=True, call="approve")


def test_a_step_of_another_kind_is_refused_at_run_time() -> None:
    solana = STEP.validate_python(
        {
            "stepId": "s1",
            "chainId": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
            "state": "ready",
            "checks": [],
            "kind": "send_solana_transaction",
            "payload": {**GENERATION, "transaction": "AA=="},
        }
    )
    later = STEP.validate_python({"stepId": "s2", "kind": "sign_with_passkey", "state": "ready"})
    r = check_steps([solana], intent)
    assert (r.ok, r.step) == (False, 0)
    assert check_step(later, intent).ok is False
    assert (
        check_portfolio_deposit(
            [solana], {"chain": CHAIN, "tokenAddress": ASSET, "smartAccount": VAULT, "amount": "1"}
        ).ok
        is False
    )
    withdrawal: Any = {
        "owner": OWNER,
        "smartAccount": VAULT,
        "portfolioId": "P1",
        "chain": CHAIN,
        "settlementAssetId": f"{CHAIN}/erc20:{ASSET}",
        "amount": {"kind": "all"},
        "holdings": {},
        "now": 0,
    }
    assert check_portfolio_withdrawal([later], withdrawal).ok is False


def test_a_step_read_from_the_api_keeps_only_the_fields_it_carried() -> None:
    # A pending step read as a model has no payload: the check sees nothing to sign, not a null payload.
    pending = STEP.validate_python(
        {"stepId": "s2", "chainId": CHAIN, "state": "waiting", "checks": [], "kind": "send_transaction"}
    )
    assert check_steps([tx("s1", "approve", ASSET, APPROVE), pending], intent) == StepsCheck(
        ok=True, pending=(1,)
    )
