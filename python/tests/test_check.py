"""The check before signing, for a vault's steps, ported from typescript/tests/check.test.ts. Each step's
calldata is decoded and refused unless it is exactly what the owner asked for, against the product's own vault
record. The calldata here was encoded by an independent ABI encoder, so the decoder is never checked against
itself."""

from __future__ import annotations

import json
from typing import Any

import pytest
from temporalabs_client import SERVED_CHAINS, StepCheck, StepsCheck, check_step, check_steps

from conftest import read_case

VAULT = "0x1111111111111111111111111111111111111111"
ASSET = "0x2222222222222222222222222222222222222222"
OWNER = "0x3333333333333333333333333333333333333333"
CHAIN = "eip155:8453"
vault = {"chain": CHAIN, "vaultAddress": VAULT, "assetAddress": ASSET}

DATA = {
    "approve": (
        "0x095ea7b3"
        "0000000000000000000000001111111111111111111111111111111111111111"
        "00000000000000000000000000000000000000000000000000000000001e8480"
    ),
    "approveOther": (
        "0x095ea7b3"
        "0000000000000000000000004444444444444444444444444444444444444444"
        "00000000000000000000000000000000000000000000000000000000001e8480"
    ),
    "approveMax": (
        "0x095ea7b3"
        "0000000000000000000000001111111111111111111111111111111111111111"
        "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
    ),
    "deposit": (
        "0x6e553f65"
        "00000000000000000000000000000000000000000000000000000000001e8480"
        "0000000000000000000000003333333333333333333333333333333333333333"
    ),
    "depositOther": (
        "0x6e553f65"
        "00000000000000000000000000000000000000000000000000000000001e8480"
        "0000000000000000000000004444444444444444444444444444444444444444"
    ),
    "withdraw": (
        "0xb460af94"
        "000000000000000000000000000000000000000000000000000000000016e360"
        "0000000000000000000000003333333333333333333333333333333333333333"
        "0000000000000000000000003333333333333333333333333333333333333333"
    ),
    "withdrawOther": (
        "0xb460af94"
        "000000000000000000000000000000000000000000000000000000000016e360"
        "0000000000000000000000004444444444444444444444444444444444444444"
        "0000000000000000000000003333333333333333333333333333333333333333"
    ),
    "redeem": (
        "0xba087652"
        "00000000000000000000000000000000000000000000000000000000000003e8"
        "0000000000000000000000003333333333333333333333333333333333333333"
        "0000000000000000000000003333333333333333333333333333333333333333"
    ),
    "redeemOwnerOther": (
        "0xba087652"
        "00000000000000000000000000000000000000000000000000000000000003e8"
        "0000000000000000000000003333333333333333333333333333333333333333"
        "0000000000000000000000004444444444444444444444444444444444444444"
    ),
}


def step(to: str, data: str, **over: Any) -> dict[str, Any]:
    return {
        "kind": "send_transaction",
        "chainId": CHAIN,
        "payload": {"to": to, "data": data, "value": "0"},
        **over,
    }


deposit = {"action": "deposit", "vault": vault, "owner": OWNER, "assets": "2000000"}
withdraw_assets = {
    "action": "withdraw",
    "vault": vault,
    "owner": OWNER,
    "amount": {"kind": "assets", "raw": "1500000"},
}
redeem_shares = {
    "action": "withdraw",
    "vault": vault,
    "owner": OWNER,
    "amount": {"kind": "shares", "raw": "1000"},
}
redeem_all = {"action": "withdraw", "vault": vault, "owner": OWNER, "amount": {"kind": "all"}}


def reason_of(r: StepCheck | StepsCheck) -> str:
    return "ok" if r.ok else str(r.reason)


class TestCheckStepWhatEachVaultCallMustBe:
    def test_admits_an_exact_approval_of_the_vault_on_the_asset_and_the_deposit_to_the_owner(self) -> None:
        assert check_step(step(ASSET, DATA["approve"]), deposit) == StepCheck(ok=True, call="approve")
        assert check_step(step(VAULT, DATA["deposit"]), deposit) == StepCheck(ok=True, call="deposit")

    def test_admits_a_withdrawal_by_assets_by_shares_and_of_every_share(self) -> None:
        assert check_step(step(VAULT, DATA["withdraw"]), withdraw_assets) == StepCheck(
            ok=True, call="withdraw"
        )
        assert check_step(step(VAULT, DATA["redeem"]), redeem_shares) == StepCheck(ok=True, call="redeem")
        assert check_step(step(VAULT, DATA["redeem"]), redeem_all) == StepCheck(ok=True, call="redeem")

    def test_compares_addresses_whatever_their_case(self) -> None:
        def upper(a: str) -> str:
            return "0x" + a[2:].upper()

        assert check_step(step(upper(ASSET), DATA["approve"]), {**deposit, "owner": upper(OWNER)}).ok is True

    @pytest.mark.parametrize(
        ("s", "intent", "reason"),
        [
            (step(ASSET, DATA["approveOther"]), deposit, "spender"),
            (step(ASSET, DATA["approveMax"]), deposit, "unlimited"),
            (step(VAULT, DATA["approve"]), deposit, "sent to"),
            (step(VAULT, DATA["depositOther"]), deposit, "receiver"),
            (step(VAULT, DATA["deposit"]), {**deposit, "assets": "2000001"}, "amount"),
            (step(ASSET, DATA["deposit"]), deposit, "sent to"),
            (step(VAULT, DATA["withdrawOther"]), withdraw_assets, "receiver"),
            (
                step(VAULT, DATA["withdraw"]),
                {**withdraw_assets, "amount": {"kind": "assets", "raw": "1"}},
                "amount",
            ),
            (step(VAULT, DATA["redeemOwnerOther"]), redeem_shares, "owner"),
            (
                step(VAULT, DATA["redeem"]),
                {**redeem_shares, "amount": {"kind": "shares", "raw": "999"}},
                "shares",
            ),
            # The amounts match (1000 and 1500000 either way), so only the kind of amount tells these apart.
            (
                step(VAULT, DATA["redeem"]),
                {**withdraw_assets, "amount": {"kind": "assets", "raw": "1000"}},
                "given in assets",
            ),
            (
                step(VAULT, DATA["withdraw"]),
                {**redeem_shares, "amount": {"kind": "shares", "raw": "1500000"}},
                "given in shares",
            ),
            (step(VAULT, DATA["deposit"]), withdraw_assets, "asked"),
            (step(VAULT, DATA["withdraw"]), deposit, "asked"),
        ],
        ids=[
            "an approval of anything but the vault",
            "an unlimited approval",
            "an approval sent to anything but the asset",
            "a deposit for another receiver",
            "a deposit of another amount",
            "a deposit sent to anything but the vault",
            "a withdrawal paying another receiver",
            "a withdrawal of another amount",
            "a redeem of another owner's shares",
            "a redeem of other shares",
            "a redeem when assets were asked for",
            "a withdraw when shares were asked for",
            "a deposit call in a withdrawal",
            "a withdrawal call in a deposit",
        ],
    )
    def test_refuses(self, s: dict[str, Any], intent: dict[str, Any], reason: str) -> None:
        assert reason in reason_of(check_step(s, intent))

    def test_refuses_a_step_with_value_on_another_chain_not_a_transaction_or_with_nothing_to_sign(
        self,
    ) -> None:
        assert "value" in reason_of(
            check_step(
                step(VAULT, DATA["deposit"], payload={"to": VAULT, "data": DATA["deposit"], "value": "1"}),
                deposit,
            )
        )
        assert "chain" in reason_of(check_step(step(VAULT, DATA["deposit"], chainId="eip155:1"), deposit))
        assert "kind" in reason_of(check_step(step(VAULT, DATA["deposit"], kind="sign_typed_data"), deposit))
        assert "nothing to sign" in reason_of(
            check_step({"kind": "send_transaction", "chainId": CHAIN}, deposit)
        )

    def test_refuses_calldata_that_is_not_exactly_the_canonical_encoding(self) -> None:
        assert "encoding" in reason_of(check_step(step(VAULT, DATA["deposit"] + "00"), deposit))
        assert "encoding" in reason_of(check_step(step(VAULT, DATA["deposit"][:-2]), deposit))
        # A receiver word with a bit set above the 20 address bytes decodes to the owner in a lax decoder.
        dirty = DATA["deposit"][:74] + "01" + DATA["deposit"][76:]
        assert "encoding" in reason_of(check_step(step(VAULT, dirty), deposit))
        assert "not a vault call" in reason_of(check_step(step(VAULT, "0xdeadbeef"), deposit))
        assert "encoding" in reason_of(check_step(step(VAULT, "not hex"), deposit))

    def test_refuses_a_vault_record_or_an_owner_that_is_not_an_address(self) -> None:
        assert "owner" in reason_of(check_step(step(VAULT, DATA["deposit"]), {**deposit, "owner": "nobody"}))
        assert "vault record" in reason_of(
            check_step(step(VAULT, DATA["deposit"]), {**deposit, "vault": {**vault, "vaultAddress": "0x12"}})
        )

    def test_refuses_an_approval_of_2_128_or_more_even_when_the_intent_asks_for_that_amount(self) -> None:
        assert "unlimited" in reason_of(
            check_step(step(ASSET, DATA["approveMax"]), {**deposit, "assets": str(2**256 - 1)})
        )

    def test_refuses_an_intent_for_a_zero_amount_whatever_the_step_says(self) -> None:
        zero_approve = DATA["approve"][:74] + "0" * 64
        assert "zero" in reason_of(check_step(step(ASSET, zero_approve), {**deposit, "assets": "0"}))
        zero_withdraw = DATA["withdraw"][:10] + "0" * 64 + DATA["withdraw"][74:]
        assert "zero" in reason_of(
            check_step(
                step(VAULT, zero_withdraw), {**withdraw_assets, "amount": {"kind": "assets", "raw": "0"}}
            )
        )
        zero_redeem = DATA["redeem"][:10] + "0" * 64 + DATA["redeem"][74:]
        assert "zero" in reason_of(
            check_step(step(VAULT, zero_redeem), {**redeem_shares, "amount": {"kind": "shares", "raw": "0"}})
        )

    def test_refuses_an_all_withdrawal_of_no_shares(self) -> None:
        none = DATA["redeem"][:10] + "0" * 64 + DATA["redeem"][74:]
        assert "shares" in reason_of(check_step(step(VAULT, none), redeem_all))


class TestCheckStepsTheRequestAsAWhole:
    def test_admits_approve_deposit_deposit_and_one_withdrawal(self) -> None:
        assert check_steps(
            [step(ASSET, DATA["approve"]), step(VAULT, DATA["deposit"])], deposit
        ) == StepsCheck(ok=True)
        assert check_steps([step(VAULT, DATA["deposit"])], deposit) == StepsCheck(ok=True)
        assert check_steps([step(VAULT, DATA["withdraw"])], withdraw_assets) == StepsCheck(ok=True)

    def test_checks_a_step_with_nothing_to_sign_yet_only_by_its_kind_and_chain(self) -> None:
        r = check_steps(
            [step(ASSET, DATA["approve"]), {"kind": "send_transaction", "chainId": CHAIN}], deposit
        )
        assert r == StepsCheck(ok=True, pending=(1,))

    def test_refuses_a_reordered_repeated_or_extra_step_and_names_it(self) -> None:
        assert check_steps([step(VAULT, DATA["deposit"]), step(ASSET, DATA["approve"])], deposit).step == 0
        assert check_steps([step(ASSET, DATA["approve"]), step(ASSET, DATA["approve"])], deposit).step == 1
        assert (
            check_steps([step(VAULT, DATA["withdraw"]), step(VAULT, DATA["withdraw"])], withdraw_assets).step
            == 1
        )
        assert check_steps([], deposit).ok is False
        r = check_steps([step(ASSET, DATA["approve"]), step(VAULT, DATA["depositOther"])], deposit)
        assert (r.ok, r.step) == (False, 1) and "receiver" in str(r.reason)


@pytest.mark.parametrize("c", read_case("vault-steps.json")["oneStepDeposits"], ids=lambda c: c["case"])
def test_one_deposit_step_from_the_shared_cases(c: dict[str, Any]) -> None:
    intent = {"action": "deposit", "vault": c["vault"], "owner": c["owner"], "assets": "2000000"}
    s = {"kind": "send_transaction", "chainId": c["vault"]["chain"], "payload": c["step"]}
    assert check_steps([s], intent).ok is c["admit"]


class TestTheApisOwnVaultStepsPass:
    """Steps in the shape the API returns, from cases/vault-steps.json, which the TypeScript tests read
    too."""

    def test_a_deposit_with_and_without_its_approval_a_withdrawal_by_assets_and_a_redeem_by_shares(
        self,
    ) -> None:
        fx = read_case("vault-steps.json")

        def as_step(payload: dict[str, Any]) -> dict[str, Any]:
            return {"kind": "send_transaction", "chainId": fx["vault"]["chain"], "payload": payload}

        intent = {"action": "deposit", "vault": fx["vault"], "owner": fx["owner"], "assets": "2000000"}
        assert check_steps([as_step(p) for p in fx["deposit"]], intent) == StepsCheck(ok=True)
        assert check_steps([as_step(p) for p in fx["depositNoApprove"]], intent) == StepsCheck(ok=True)
        by_assets = {
            "action": "withdraw",
            "vault": fx["vault"],
            "owner": fx["owner"],
            "amount": {"kind": "assets", "raw": "1500000"},
        }
        assert check_steps([as_step(fx["withdraw"])], by_assets) == StepsCheck(ok=True)
        by_shares = {
            "action": "withdraw",
            "vault": fx["vault"],
            "owner": fx["owner"],
            "amount": {"kind": "shares", "raw": "1000"},
        }
        assert check_steps([as_step(fx["redeem"])], by_shares) == StepsCheck(ok=True)


class TestCheckStepWithTheCallItsPositionTakes:
    def test_admits_the_call_that_position_takes(self) -> None:
        assert check_step(step(ASSET, DATA["approve"]), deposit, "approve") == StepCheck(
            ok=True, call="approve"
        )
        assert check_step(step(VAULT, DATA["deposit"]), deposit, "deposit") == StepCheck(
            ok=True, call="deposit"
        )

    def test_refuses_a_valid_call_that_is_not_the_one_its_position_takes(self) -> None:
        # [pending, deposit] fits [approve, deposit]; when the pending step arrives as a second deposit it is
        # refused.
        pending_first = check_steps(
            [{"kind": "send_transaction", "chainId": CHAIN}, step(VAULT, DATA["deposit"])], deposit
        )
        assert pending_first == StepsCheck(ok=True, pending=(0,))
        assert "approve" in reason_of(check_step(step(VAULT, DATA["deposit"]), deposit, "approve"))


OWNER_WORD = "000000000000000000000000" + OWNER[2:]


class TestTheCalldataDecoderByteByByte:
    @pytest.mark.parametrize(
        "data",
        ["0x6e553f6g" + "0" * 128, DATA["deposit"] + "0", "0x6e553f", "0x"],
        ids=[
            "a character that is not hex",
            "an odd number of hex digits",
            "fewer bytes than a selector",
            "nothing at all",
        ],
    )
    def test_refuses_as_not_a_valid_encoding(self, data: str) -> None:
        assert reason_of(check_step(step(VAULT, data), deposit)) == "the calldata is not a valid encoding"

    def test_names_the_call_whose_encoding_is_not_canonical(self) -> None:
        assert (
            reason_of(check_step(step(VAULT, DATA["deposit"] + "00"), deposit))
            == "the calldata is not the canonical encoding of deposit"
        )
        assert (
            reason_of(check_step(step(VAULT, DATA["withdraw"][:-2]), withdraw_assets))
            == "the calldata is not the canonical encoding of withdraw"
        )

    def test_refuses_calldata_that_is_not_lower_case_hex_in_the_selector_or_an_argument(self) -> None:
        refused = StepCheck(ok=False, reason="the calldata is not a valid encoding")
        assert (
            check_step(step(VAULT, DATA["deposit"].replace("0x6e553f65", "0x6E553F65")), deposit) == refused
        )
        assert check_step(step(VAULT, "0x" + DATA["deposit"][2:].upper()), deposit) == refused
        assert check_step(step(VAULT, DATA["deposit"][:-2] + "A1"), deposit) == refused

    def test_reads_every_byte_of_an_amount_word_the_top_one_included(self) -> None:
        assets = 2**255 + 1
        data = f"0x6e553f65{assets:064x}{OWNER_WORD}"
        assert check_step(step(VAULT, data), {**deposit, "assets": str(assets)}) == StepCheck(
            ok=True, call="deposit"
        )
        assert reason_of(check_step(step(VAULT, data), {**deposit, "assets": "1"})) != "ok"


REDEEM_MANY = f"0xba087652{10**30:064x}{'0' * 24}{OWNER[2:]}{'0' * 24}{OWNER[2:]}"


class TestAnIntentOutsideTheDocumentedShapeIsRefused:
    @pytest.mark.parametrize("kind", ["SHARES", "shares ", "Assets", ""])
    def test_a_withdrawal_amount_of_an_unknown_kind_admits_no_step(self, kind: str) -> None:
        intent = {
            "action": "withdraw",
            "vault": vault,
            "owner": OWNER,
            "amount": {"kind": kind, "raw": "1000"},
        }
        assert check_step(step(VAULT, REDEEM_MANY), intent).ok is False
        assert check_step(step(VAULT, DATA["withdraw"]), intent).ok is False
        assert check_steps([step(VAULT, REDEEM_MANY)], intent).ok is False

    @pytest.mark.parametrize("action", ["Deposit", "withdrawal", ""])
    def test_an_unknown_action_is_refused_not_raised(self, action: str) -> None:
        intent = {**deposit, "action": action}
        assert check_step(step(VAULT, DATA["deposit"]), intent).ok is False
        assert check_steps([step(VAULT, DATA["deposit"])], intent).ok is False

    def test_a_withdrawal_with_no_amount_is_refused_not_raised(self) -> None:
        intent = {"action": "withdraw", "vault": vault, "owner": OWNER}
        assert check_step(step(VAULT, DATA["withdraw"]), intent).ok is False
        assert check_steps([step(VAULT, DATA["withdraw"])], intent).ok is False

    def test_an_intent_with_no_vault_is_refused_not_raised(self) -> None:
        assert (
            check_step(step(VAULT, DATA["deposit"]), {"action": "deposit", "owner": OWNER, "assets": "1"}).ok
            is False
        )

    @pytest.mark.parametrize(
        "bad_vault",
        [
            None,
            {},
            {**vault, "chain": ""},
            {**vault, "vaultAddress": "0x12"},
            {**vault, "assetAddress": None},
        ],
    )
    def test_a_request_whose_intent_has_no_complete_vault_is_refused_even_with_nothing_to_sign_yet(
        self, bad_vault: Any
    ) -> None:
        # A deposit's second step waits on its approval: it has no payload, and no chain to compare.
        waiting = {"kind": "send_transaction"}
        intent: dict[str, Any] = {"action": "deposit", "owner": OWNER, "assets": "2000000"}
        if bad_vault is not None:
            intent["vault"] = bad_vault
        r = check_steps([step(ASSET, DATA["approve"]), waiting], intent)
        assert r.ok is False
        assert r.reason == "the vault record is not complete"


EXTRAS = {
    "authorizationList": [],
    "chainId": "0x1",
    "gas": "0x5208",
    "maxFeePerGas": "0x1",
    "maxPriorityFeePerGas": "0x1",
    "from": OWNER,
    "nonce": "0x0",
    "type": "0x4",
    "accessList": [],
}


class TestAVaultStepCarriesOnlyThePayloadFieldsTheApiDefines:
    @pytest.mark.parametrize(("key", "value"), list(EXTRAS.items()))
    def test_refuses_a_payload_carrying_another_field(self, key: str, value: Any) -> None:
        s = step(ASSET, DATA["approve"])
        extra = {**s, "payload": {**s["payload"], key: value}}
        assert "payload" in reason_of(check_step(extra, deposit))
        r = check_steps([extra, step(VAULT, DATA["deposit"])], deposit)
        assert (r.ok, r.step) == (False, 0) and "payload" in str(r.reason)

    def test_admits_the_fields_the_api_sends_generation_and_expires_at_beside_to_data_and_value(self) -> None:
        s = step(ASSET, DATA["approve"])
        payload = {**s["payload"], "generation": 1, "expiresAt": "2026-11-14T00:00:00.000Z"}
        assert check_step({**s, "payload": payload}, deposit) == StepCheck(ok=True, call="approve")

    def test_refuses_a_payload_that_is_not_an_object_and_an_own_proto_key(self) -> None:
        assert check_step({"kind": "send_transaction", "chainId": CHAIN, "payload": "x"}, deposit).ok is False
        assert (
            check_step({"kind": "send_transaction", "chainId": CHAIN, "payload": None}, deposit).ok is False
        )
        s = step(ASSET, DATA["approve"])
        poisoned = {**s, "payload": json.loads(json.dumps(s["payload"]).replace("{", '{"__proto__":{},', 1))}
        assert "payload" in reason_of(check_step(poisoned, deposit))


HUGE = "9" * 4301  # past Python's 4,300-digit int() limit


class TestRawAmountsAreUint256Sized:
    def test_an_amount_asked_for_too_long_for_int_is_a_refusal_not_an_exception(self) -> None:
        r = check_step(step(ASSET, DATA["approve"]), {**deposit, "assets": HUGE})
        assert r.ok is False and r.reason
        r = check_step(
            step(VAULT, DATA["withdraw"]), {**withdraw_assets, "amount": {"kind": "assets", "raw": HUGE}}
        )
        assert r.ok is False and r.reason

    def test_an_amount_one_digit_past_a_uint256_is_refused_and_the_largest_is_read(self) -> None:
        r = check_step(step(ASSET, DATA["approve"]), {**deposit, "assets": "1" + "0" * 78})
        assert r.ok is False and "raw amount" in reason_of(r)


class TestChainsAndAddressesNeverLooserThanTheApi:
    # EIP-55's own example, and the same address with one letter's case flipped.
    GOOD = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"
    BAD = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD"

    @staticmethod
    def deposit_for(owner: str) -> str:
        return f"0x6e553f65{2000000:064x}{'0' * 24}{owner[2:].lower()}"

    @staticmethod
    def on(chain: str) -> dict[str, Any]:
        return {"action": "deposit", "vault": {**vault, "chain": chain}, "owner": OWNER, "assets": "2000000"}

    @pytest.mark.parametrize(
        "chain",
        [
            "eip155:999999999",
            "eip155:08453",
            "eip155:0",
            "eip155:",
            "solana:mainnet",
            "garbage",
            "eip155:8453 ",
        ],
    )
    def test_refuses_a_vault_on_a_chain_the_api_does_not_serve(self, chain: str) -> None:
        assert check_step(step(VAULT, DATA["deposit"], chainId=chain), self.on(chain)).ok is False
        pending = {"kind": "send_transaction", "chainId": chain}
        assert check_steps([pending], self.on(chain)).ok is False

    @pytest.mark.parametrize("chain", [f"eip155:{i}" for i in SERVED_CHAINS])
    def test_admits_a_vault_on_a_chain_the_api_serves(self, chain: str) -> None:
        r = check_step(step(VAULT, DATA["deposit"], chainId=chain), self.on(chain))
        assert r == StepCheck(ok=True, call="deposit")

    def test_admits_an_owner_in_lower_upper_or_correctly_checksummed_mixed_case(self) -> None:
        for owner in (self.GOOD.lower(), "0x" + self.GOOD[2:].upper(), self.GOOD):
            r = check_step(step(VAULT, self.deposit_for(owner)), {**deposit, "owner": owner})
            assert r == StepCheck(ok=True, call="deposit")

    def test_refuses_a_mixed_case_owner_whose_checksum_is_wrong(self) -> None:
        r = check_step(step(VAULT, self.deposit_for(self.BAD)), {**deposit, "owner": self.BAD})
        assert r == StepCheck(ok=False, reason="the owner is not an address")

    def test_refuses_a_vault_record_or_a_step_naming_a_badly_checksummed_address(self) -> None:
        bad_vault = {**deposit, "vault": {**vault, "vaultAddress": self.BAD}}
        assert check_step(step(self.BAD, DATA["deposit"]), bad_vault) == StepCheck(
            ok=False, reason="the vault record is not complete"
        )
        good_vault = {**deposit, "vault": {**vault, "vaultAddress": self.GOOD}}
        assert check_step(step(self.BAD, DATA["deposit"]), good_vault) == StepCheck(
            ok=False, reason="the step is not sent to an address"
        )
        lower_vault = {**deposit, "vault": {**vault, "vaultAddress": self.GOOD.lower()}}
        assert check_step(step(self.GOOD, DATA["deposit"]), lower_vault) == StepCheck(ok=True, call="deposit")
