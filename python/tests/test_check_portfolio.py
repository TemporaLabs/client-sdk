"""The checks before signing for a portfolio's steps, ported from typescript/tests/checkPortfolio.test.ts. The
withdrawal authorization is the provider's EIP-712 struct in the shape the API returns; the transfer calldata
was encoded by an independent ABI encoder, so the decoder is never checked against itself."""

from __future__ import annotations

import math
from datetime import UTC, datetime
from typing import Any, ClassVar

import pytest
from temporalabs_client import (
    PortfolioDepositCheck,
    PortfolioTotal,
    PortfolioWithdrawalCheck,
    check_portfolio_deposit,
    check_portfolio_withdrawal,
)

OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
SA = "0x7777777777777777777777777777777777777777"
OTHER = "0x4444444444444444444444444444444444444444"
USDT_ADDR = "0x55d398326f99059fF775485246999027B3197955"
USDT = f"eip155:56/erc20:{USDT_ADDR}"
TOKEN = "eip155:56/erc20:0x1234567890123456789012345678901234567890"
CHAIN = "eip155:56"
NOW = 1_793_977_000_000
EXPIRES = 1_793_977_800

TRANSFER_FIELDS = [
    {"name": "portfolioId", "type": "string"},
    {"name": "recipientAccountId", "type": "string"},
    {"name": "assets", "type": "WithdrawalAsset[]"},
    {"name": "nonce", "type": "bytes32"},
    {"name": "expiresAt", "type": "uint256"},
]
SALE_FIELDS = [
    *TRANSFER_FIELDS,
    {"name": "liquidate", "type": "bool"},
    {"name": "settlementAssetId", "type": "string"},
]
ASSET_FIELDS = [{"name": "assetId", "type": "string"}, {"name": "amountRaw", "type": "string"}]
NONCE = "0x" + "00" * 32
DOMAIN_1 = {"name": "Glider Withdrawal Authorization", "version": "1", "chainId": 56, "verifyingContract": SA}


def transfer_auth(
    over: dict[str, Any] | None = None, message: dict[str, Any] | None = None
) -> dict[str, Any]:
    return {
        "domain": DOMAIN_1,
        "types": {"Withdrawal": TRANSFER_FIELDS, "WithdrawalAsset": ASSET_FIELDS},
        "primaryType": "Withdrawal",
        "message": {
            "portfolioId": "P1",
            "recipientAccountId": f"eip155:56:{OWNER}",
            "assets": [{"assetId": USDT, "amountRaw": "25000000000000000000"}],
            "nonce": NONCE,
            "expiresAt": EXPIRES,
            **(message or {}),
        },
        **(over or {}),
    }


def sale_auth(message: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "domain": {**DOMAIN_1, "version": "2"},
        "types": {"Withdrawal": SALE_FIELDS, "WithdrawalAsset": ASSET_FIELDS},
        "primaryType": "Withdrawal",
        "message": {
            "portfolioId": "P1",
            "recipientAccountId": f"eip155:56:{OWNER}",
            "assets": [{"assetId": TOKEN, "amountRaw": "400"}],
            "nonce": NONCE,
            "expiresAt": EXPIRES,
            "liquidate": True,
            "settlementAssetId": USDT,
            **(message or {}),
        },
    }


def plan_of(a: dict[str, Any]) -> dict[str, Any]:
    return {"liquidate": a["message"].get("liquidate") is True, "assets": a["message"]["assets"]}


def batch(a: dict[str, Any], plan: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "kind": "sign_typed_data",
        "chainId": CHAIN,
        "plan": plan_of(a) if plan is None else plan,
        "payload": {"typedData": a},
    }


withdraw: dict[str, Any] = {
    "owner": OWNER,
    "smartAccount": SA,
    "portfolioId": "P1",
    "chain": CHAIN,
    "settlementAssetId": USDT,
    "amount": {"kind": "all"},
    "holdings": {USDT: "25000000000000000000", TOKEN: "400"},
    "now": NOW,
}


def reason_of(r: PortfolioWithdrawalCheck | PortfolioDepositCheck) -> str:
    return "ok" if r.ok else str(r.reason)


class TestCheckPortfolioWithdrawal:
    def test_admits_a_plain_transfer_of_the_idle_usdt_and_a_sale_settling_in_usdt(self) -> None:
        assert check_portfolio_withdrawal(
            [batch(transfer_auth()), batch(sale_auth())], withdraw
        ) == PortfolioWithdrawalCheck(
            ok=True,
            kinds=("transfer", "sale"),
            totals=(
                PortfolioTotal(asset_id=USDT, amount="25000000000000000000", held="25000000000000000000"),
                PortfolioTotal(asset_id=TOKEN, amount="400", held="400"),
            ),
            expires_at=datetime.fromtimestamp(EXPIRES, tz=UTC),
            pending=(),
        )

    def test_compares_ids_by_their_parsed_form_so_letter_case_does_not_matter(self) -> None:
        lower = transfer_auth(
            {},
            {
                "recipientAccountId": f"eip155:56:{OWNER.lower()}",
                "assets": [{"assetId": USDT.lower(), "amountRaw": "25000000000000000000"}],
            },
        )
        assert check_portfolio_withdrawal([batch(lower)], withdraw).ok is True

    @pytest.mark.parametrize(
        ("auth", "reason"),
        [
            (transfer_auth({"primaryType": "Transfer"}), "form"),
            (transfer_auth({"domain": {**DOMAIN_1, "name": "X"}}), "form"),
            (transfer_auth({"domain": DOMAIN_1}, {"liquidate": True, "settlementAssetId": USDT}), "form"),
            (transfer_auth({"domain": {**DOMAIN_1, "salt": NONCE}}), "form"),
            (
                transfer_auth(
                    {
                        "types": {
                            "Withdrawal": [TRANSFER_FIELDS[1], TRANSFER_FIELDS[0], *TRANSFER_FIELDS[2:]],
                            "WithdrawalAsset": ASSET_FIELDS,
                        }
                    }
                ),
                "form",
            ),
            (
                transfer_auth(
                    {
                        "types": {
                            "Withdrawal": TRANSFER_FIELDS,
                            "WithdrawalAsset": [ASSET_FIELDS[1], ASSET_FIELDS[0]],
                        }
                    }
                ),
                "form",
            ),
            (transfer_auth({}, {"note": "x"}), "form"),
            (
                transfer_auth(
                    {"types": {"Withdrawal": TRANSFER_FIELDS, "WithdrawalAsset": ASSET_FIELDS, "Other": []}}
                ),
                "form",
            ),
            (
                transfer_auth(
                    {
                        "types": {
                            "Withdrawal": TRANSFER_FIELDS,
                            "WithdrawalAsset": ASSET_FIELDS,
                            "EIP712Domain": [
                                {"name": "version", "type": "string"},
                                {"name": "name", "type": "string"},
                                {"name": "chainId", "type": "uint256"},
                                {"name": "verifyingContract", "type": "address"},
                            ],
                        }
                    }
                ),
                "form",
            ),
            (transfer_auth({"domain": {**DOMAIN_1, "chainId": 1}}), "chain"),
            (transfer_auth({"domain": {**DOMAIN_1, "verifyingContract": OTHER}}), "smart account"),
            (transfer_auth({}, {"portfolioId": "P2"}), "portfolio"),
            (transfer_auth({}, {"recipientAccountId": f"eip155:56:{OTHER}"}), "pay"),
            (transfer_auth({}, {"recipientAccountId": f"eip155:1:{OWNER}"}), "pay"),
            (transfer_auth({}, {"recipientAccountId": f"eip155:056:{OWNER}"}), "pay"),
            (
                transfer_auth(
                    {}, {"assets": [{"assetId": f"eip155:056/erc20:{USDT_ADDR}", "amountRaw": "1"}]}
                ),
                "asset",
            ),
            (transfer_auth({}, {"assets": [{"assetId": TOKEN, "amountRaw": "1"}]}), "without selling"),
            (transfer_auth({}, {"assets": [{"assetId": USDT, "amountRaw": "1.5"}]}), "asset"),
            (transfer_auth({}, {"assets": [{"assetId": USDT, "amountRaw": "0"}]}), "asset"),
            (
                transfer_auth(
                    {},
                    {
                        "assets": [
                            {"assetId": USDT, "amountRaw": "1"},
                            {"assetId": USDT.lower(), "amountRaw": "1"},
                        ]
                    },
                ),
                "twice",
            ),
            (transfer_auth({}, {"assets": [{"assetId": USDT, "amountRaw": "1", "to": OTHER}]}), "form"),
            (transfer_auth({}, {"expiresAt": NOW // 1000 - 1}), "expired"),
            (transfer_auth({}, {"expiresAt": NOW // 1000 + 3601}), "valid for more"),
            (transfer_auth({}, {"nonce": "0x01"}), "form"),
        ],
        ids=[
            "another primary type",
            "another domain name",
            "a sale signed as version 1",
            "an extra domain field",
            "the struct fields reordered",
            "the asset fields reordered",
            "a field shown but not signed",
            "an extra type",
            "a domain type out of the standard order",
            "another chain",
            "another debit account",
            "another portfolio",
            "another recipient",
            "a recipient on another chain",
            "a recipient chain with a leading zero",
            "an asset chain with a leading zero",
            "a transfer of something other than the settlement asset",
            "an amount that is not whole units",
            "a zero amount",
            "the same asset twice",
            "an asset entry with an extra key",
            "an expired authorization",
            "an authorization valid for too long",
            "a bad nonce",
        ],
    )
    def test_refuses(self, auth: dict[str, Any], reason: str) -> None:
        assert reason in reason_of(check_portfolio_withdrawal([batch(auth)], withdraw))

    def test_refuses_a_version_that_does_not_match_the_kind(self) -> None:
        sale = sale_auth()
        assert "form" in reason_of(
            check_portfolio_withdrawal(
                [batch({**sale, "domain": {**sale["domain"], "version": "1"}})], withdraw
            )
        )
        transfer = transfer_auth()
        assert "form" in reason_of(
            check_portfolio_withdrawal(
                [batch({**transfer, "domain": {**transfer["domain"], "version": "2"}})], withdraw
            )
        )

    def test_refuses_a_sale_settling_in_another_asset(self) -> None:
        assert "settles" in reason_of(
            check_portfolio_withdrawal([batch(sale_auth({"settlementAssetId": TOKEN}))], withdraw)
        )

    def test_holds_each_batch_to_the_apis_own_plan(self) -> None:
        a = sale_auth()
        for plan in (
            {"liquidate": False, "assets": a["message"]["assets"]},
            {"liquidate": True, "assets": [{"assetId": TOKEN, "amountRaw": "399"}]},
            {"liquidate": True, "assets": []},
            {"liquidate": True, "assets": [*a["message"]["assets"], {"assetId": USDT, "amountRaw": "1"}]},
        ):
            assert "plan" in reason_of(check_portfolio_withdrawal([batch(a, plan)], withdraw))

    def test_refuses_a_batch_with_no_plan(self) -> None:
        step = {"kind": "sign_typed_data", "chainId": CHAIN, "payload": {"typedData": sale_auth()}}
        assert "plan" in reason_of(check_portfolio_withdrawal([step], withdraw))

    def test_bounds_the_totals_over_every_batch_by_the_holdings_passed_in_and_the_fraction_asked(
        self,
    ) -> None:
        def half(n: str) -> dict[str, Any]:
            return sale_auth({"assets": [{"assetId": TOKEN, "amountRaw": n}]})

        half_of = {**withdraw, "amount": {"kind": "fraction", "value": "0.5"}}
        # Two batches each within the holding, together above it.
        assert "more than" in reason_of(
            check_portfolio_withdrawal([batch(half("300")), batch(half("300"))], withdraw)
        )
        assert "more than" in reason_of(check_portfolio_withdrawal([batch(half("300"))], half_of))
        assert check_portfolio_withdrawal([batch(half("200"))], half_of).ok is True
        # An asset the account does not hold.
        assert "does not hold" in reason_of(
            check_portfolio_withdrawal([batch(half("1"))], {**withdraw, "holdings": {USDT: "1"}})
        )

    def test_refuses_a_bad_intent_rather_than_comparing_against_it(self) -> None:
        for value in ("0", "1.5", "-0.1", "half", "0.1234567890123456789"):
            assert "fraction" in reason_of(
                check_portfolio_withdrawal(
                    [batch(sale_auth())], {**withdraw, "amount": {"kind": "fraction", "value": value}}
                )
            )
        assert "owner" in reason_of(
            check_portfolio_withdrawal([batch(sale_auth())], {**withdraw, "owner": "nobody"})
        )
        assert "chain" in reason_of(
            check_portfolio_withdrawal([batch(sale_auth())], {**withdraw, "chain": "eip155:056"})
        )

    def test_lists_a_batch_with_nothing_to_sign_as_pending_checks_its_kind_and_refuses_no_steps(
        self,
    ) -> None:
        r = check_portfolio_withdrawal(
            [batch(transfer_auth()), {"kind": "sign_typed_data", "chainId": CHAIN}], withdraw
        )
        assert (r.ok, r.pending) == (True, (1,))
        r = check_portfolio_withdrawal([{"kind": "send_transaction", "chainId": CHAIN}], withdraw)
        assert (r.ok, r.step) == (False, 0)
        r = check_portfolio_withdrawal([], withdraw)
        assert (r.ok, r.step) == (False, None)


TRANSFER = (
    "0xa9059cbb"
    "0000000000000000000000007777777777777777777777777777777777777777"
    "0000000000000000000000000000000000000000000000015af1d78b58c40000"
)
TRANSFER_OTHER = (
    "0xa9059cbb"
    "0000000000000000000000004444444444444444444444444444444444444444"
    "0000000000000000000000000000000000000000000000015af1d78b58c40000"
)
ENROL: dict[str, Any] = {
    "kind": "sign_message",
    "chainId": CHAIN,
    "purpose": "enrol",
    "payload": {"bytes": "0x" + "ab" * 32},
}


def send(to: str, data: str, **over: Any) -> dict[str, Any]:
    return {
        "kind": "send_transaction",
        "chainId": CHAIN,
        "payload": {"to": to, "data": data, "value": "0"},
        **over,
    }


deposit: dict[str, Any] = {
    "chain": CHAIN,
    "tokenAddress": USDT_ADDR,
    "smartAccount": SA,
    "amount": "25000000000000000000",
}


class TestCheckPortfolioDeposit:
    def test_admits_enrol_then_transfer_and_transfer_alone(self) -> None:
        assert check_portfolio_deposit([ENROL, send(USDT_ADDR, TRANSFER)], deposit) == PortfolioDepositCheck(
            ok=True
        )
        assert check_portfolio_deposit([send(USDT_ADDR, TRANSFER)], deposit) == PortfolioDepositCheck(ok=True)
        # The transfer waits on the enrol: it has nothing to send yet.
        r = check_portfolio_deposit([ENROL, {"kind": "send_transaction", "chainId": CHAIN}], deposit)
        assert r == PortfolioDepositCheck(ok=True, pending=(1,))

    @pytest.mark.parametrize(
        ("steps", "reason", "over"),
        [
            ([send(USDT_ADDR, TRANSFER_OTHER)], "smart account", {}),
            ([send(USDT_ADDR, TRANSFER)], "amount", {"amount": "1"}),
            ([send(OTHER, TRANSFER)], "token", {}),
            (
                [send(USDT_ADDR, TRANSFER, payload={"to": USDT_ADDR, "data": TRANSFER, "value": "1"})],
                "value",
                {},
            ),
            ([send(USDT_ADDR, TRANSFER, chainId="eip155:1")], "chain", {}),
            ([send(USDT_ADDR, TRANSFER + "00")], "encoding", {}),
            ([send(USDT_ADDR, TRANSFER[:10] + "01" + TRANSFER[12:])], "encoding", {}),
            ([send(USDT_ADDR, "0x095ea7b3" + TRANSFER[10:])], "transfer", {}),
            ([{**ENROL, "payload": {"bytes": "0xabcd"}}, send(USDT_ADDR, TRANSFER)], "32 bytes", {}),
            ([{**ENROL, "purpose": "approve"}, send(USDT_ADDR, TRANSFER)], "enrol", {}),
            ([{**ENROL, "chainId": "eip155:1"}, send(USDT_ADDR, TRANSFER)], "chain", {}),
            ([send(USDT_ADDR, TRANSFER), ENROL], "order", {}),
            ([send(USDT_ADDR, TRANSFER), send(USDT_ADDR, TRANSFER)], "order", {}),
            ([], "steps", {}),
        ],
        ids=[
            "a transfer to anything but the smart account",
            "a transfer of another amount",
            "a transfer on another token contract",
            "a transfer carrying value",
            "a transfer on another chain",
            "trailing calldata",
            "a dirty address word",
            "another function",
            "an enrol hash that is not 32 bytes",
            "an enrol step with another purpose",
            "an enrol step on another chain",
            "an enrol step after the transfer",
            "two transfers",
            "no steps",
        ],
    )
    def test_refuses(self, steps: list[dict[str, Any]], reason: str, over: dict[str, Any]) -> None:
        assert reason in reason_of(check_portfolio_deposit(steps, {**deposit, **over}))

    def test_admits_an_enrol_only_request_when_no_amount_was_asked_and_nothing_else_then(self) -> None:
        enrol_only = {k: v for k, v in deposit.items() if k != "amount"}
        assert check_portfolio_deposit([ENROL], enrol_only) == PortfolioDepositCheck(ok=True)
        assert "steps" in reason_of(check_portfolio_deposit([ENROL, send(USDT_ADDR, TRANSFER)], enrol_only))

    def test_an_amount_of_null_is_not_an_enrol_only_request(self) -> None:
        # Only an amount left out asks for enrolment alone; null is an amount that is not a raw amount.
        assert "zero or not a raw amount" in reason_of(
            check_portfolio_deposit([ENROL], {**deposit, "amount": None})
        )

    def test_refuses_an_intent_for_a_zero_amount_or_a_smart_account_that_is_not_an_address(self) -> None:
        assert "zero" in reason_of(
            check_portfolio_deposit([send(USDT_ADDR, TRANSFER)], {**deposit, "amount": "0"})
        )
        assert "smart account" in reason_of(
            check_portfolio_deposit([send(USDT_ADDR, TRANSFER)], {**deposit, "smartAccount": "0x12"})
        )


class TestThePlanMatchesTheSignedBatchBothWays:
    both: ClassVar[dict[str, Any]] = {**withdraw, "holdings": {USDT: "1000", TOKEN: "400"}}
    signed = sale_auth(
        {"assets": [{"assetId": TOKEN, "amountRaw": "400"}, {"assetId": USDT, "amountRaw": "1000"}]}
    )

    def test_admits_a_plan_that_names_exactly_the_signed_assets(self) -> None:
        assert check_portfolio_withdrawal([batch(self.signed)], self.both).ok is True

    def test_refuses_a_plan_that_names_one_asset_twice(self) -> None:
        plan = {
            "liquidate": True,
            "assets": [{"assetId": TOKEN, "amountRaw": "400"}, {"assetId": TOKEN, "amountRaw": "400"}],
        }
        assert "plan" in reason_of(check_portfolio_withdrawal([batch(self.signed, plan)], self.both))

    def test_refuses_a_plan_that_names_the_signed_asset_twice_at_the_same_amount(self) -> None:
        plan = {
            "liquidate": True,
            "assets": [{"assetId": TOKEN, "amountRaw": "400"}, {"assetId": TOKEN, "amountRaw": "400"}],
        }
        assert "plan" in reason_of(check_portfolio_withdrawal([batch(sale_auth(), plan)], withdraw))

    def test_treats_the_same_asset_in_another_letter_case_as_a_repeat(self) -> None:
        plan = {
            "liquidate": True,
            "assets": [
                {"assetId": USDT, "amountRaw": "1000"},
                {"assetId": USDT.lower(), "amountRaw": "1000"},
            ],
        }
        assert "plan" in reason_of(check_portfolio_withdrawal([batch(self.signed, plan)], self.both))


class TestTheClockAndTheLifetimeMustBeNumbersItCanCompare:
    @pytest.mark.parametrize(
        "over",
        [
            {"now": math.nan},
            {"now": None},
            {"now": math.inf},
            {"now": True},
            {"maxLifetimeSeconds": math.nan},
            {"maxLifetimeSeconds": math.inf},
            {"maxLifetimeSeconds": 0},
            {"maxLifetimeSeconds": -1},
        ],
    )
    def test_refuses_the_request_as_a_whole(self, over: dict[str, Any]) -> None:
        r = check_portfolio_withdrawal([batch(sale_auth())], {**withdraw, **over})
        assert (r.ok, r.step) == (False, None)
        assert "now" in reason_of(r) or "lifetime" in reason_of(r)

    def test_a_missing_now_refuses_too(self) -> None:
        r = check_portfolio_withdrawal(
            [batch(sale_auth())], {k: v for k, v in withdraw.items() if k != "now"}
        )
        assert (r.ok, r.step) == (False, None)

    def test_still_refuses_an_expiry_long_past_the_lifetime_and_one_already_passed(self) -> None:
        assert "more than" in reason_of(
            check_portfolio_withdrawal([batch(sale_auth({"expiresAt": 9_000_000_000}))], withdraw)
        )
        assert "expired" in reason_of(
            check_portfolio_withdrawal([batch(sale_auth({"expiresAt": 1}))], withdraw)
        )


class TestTheTransferDecoderByteByByte:
    def test_refuses_a_transfer_whose_words_are_not_hex_as_not_a_call_to_transfer(self) -> None:
        data = TRANSFER[:74] + "g" * 64
        assert (
            reason_of(check_portfolio_deposit([send(USDT_ADDR, data)], deposit))
            == "the transfer is not a call to transfer(address,uint256)"
        )

    def test_refuses_another_call_to_the_token_as_not_a_call_to_transfer(self) -> None:
        approve = TRANSFER.replace("0xa9059cbb", "0x095ea7b3")
        assert (
            reason_of(check_portfolio_deposit([send(USDT_ADDR, approve)], deposit))
            == "the transfer is not a call to transfer(address,uint256)"
        )

    def test_reads_the_selector_whatever_its_case(self) -> None:
        upper = TRANSFER.replace("0xa9059cbb", "0xA9059CBB")
        assert check_portfolio_deposit([send(USDT_ADDR, upper)], deposit) == PortfolioDepositCheck(ok=True)


def half(n: str) -> dict[str, Any]:
    return sale_auth({"assets": [{"assetId": TOKEN, "amountRaw": n}]})


HALF_OF_400 = {**withdraw, "amount": {"kind": "fraction", "value": "0.5"}}


def pending_with_plan(n: str) -> dict[str, Any]:
    return {
        "kind": "sign_typed_data",
        "chainId": CHAIN,
        "plan": {"liquidate": True, "assets": [{"assetId": TOKEN, "amountRaw": n}]},
    }


class TestAWithdrawalBatchCountsTowardTheTotalsWhateverItsState:
    def test_a_batch_with_no_payload_yet_still_counts_its_plan(self) -> None:
        assert check_portfolio_withdrawal([batch(half("200")), batch(half("200"))], HALF_OF_400).ok is False
        assert (
            check_portfolio_withdrawal([pending_with_plan("200"), batch(half("200"))], HALF_OF_400).ok
            is False
        )
        assert (
            check_portfolio_withdrawal([batch(half("200")), pending_with_plan("200")], HALF_OF_400).ok
            is False
        )
        r = check_portfolio_withdrawal([pending_with_plan("100"), batch(half("100"))], HALF_OF_400)
        assert (r.ok, r.pending) == (True, (0,))

    def test_a_pending_batch_whose_plan_cannot_be_read_is_refused(self) -> None:
        unreadable = {
            "kind": "sign_typed_data",
            "chainId": CHAIN,
            "plan": {"liquidate": True, "assets": [{"assetId": "nope", "amountRaw": "1"}]},
        }
        assert check_portfolio_withdrawal([unreadable, batch(half("100"))], HALF_OF_400).ok is False

    def test_a_withdrawal_with_nothing_to_sign_yet_is_not_ok(self) -> None:
        r = check_portfolio_withdrawal([{"kind": "sign_typed_data", "chainId": CHAIN}], withdraw)
        assert (r.ok, r.step) == (False, None)
        r = check_portfolio_withdrawal([pending_with_plan("1")], withdraw)
        assert (r.ok, r.step) == (False, None)


EXTRAS = {
    "authorizationList": [],
    "chainId": "0x38",
    "gas": "0x5208",
    "maxFeePerGas": "0x1",
    "from": OWNER,
    "nonce": "0x0",
}
G = {"generation": 1, "expiresAt": "2026-11-14T00:00:00.000Z"}


class TestAPortfolioStepCarriesOnlyThePayloadFieldsTheApiDefines:
    @pytest.mark.parametrize(("key", "value"), list(EXTRAS.items()))
    def test_refuses_a_deposit_transfer_whose_payload_carries_another_field(
        self, key: str, value: Any
    ) -> None:
        t = send(USDT_ADDR, TRANSFER)
        r = check_portfolio_deposit([{**t, "payload": {**t["payload"], key: value}}], deposit)
        assert (r.ok, r.step) == (False, 0) and "payload" in reason_of(r)

    def test_refuses_an_enrol_signature_whose_payload_carries_anything_beside_generation_expires_at_and_bytes(
        self,
    ) -> None:
        r = check_portfolio_deposit(
            [{**ENROL, "payload": {**ENROL["payload"], "to": OTHER}}, send(USDT_ADDR, TRANSFER)], deposit
        )
        assert (r.ok, r.step) == (False, 0) and "payload" in reason_of(r)

    def test_admits_generation_and_expires_at_beside_the_fields_each_kind_reads(self) -> None:
        t = send(USDT_ADDR, TRANSFER)
        steps = [{**ENROL, "payload": {**ENROL["payload"], **G}}, {**t, "payload": {**t["payload"], **G}}]
        assert check_portfolio_deposit(steps, deposit) == PortfolioDepositCheck(ok=True)
        b = batch(sale_auth())
        assert check_portfolio_withdrawal([{**b, "payload": {**b["payload"], **G}}], withdraw).ok is True

    @pytest.mark.parametrize(("key", "value"), [("gas", "0x5208"), ("to", OTHER)])
    def test_refuses_a_withdrawal_batch_whose_payload_carries_another_field(
        self, key: str, value: Any
    ) -> None:
        b = batch(sale_auth())
        r = check_portfolio_withdrawal([{**b, "payload": {**b["payload"], key: value}}], withdraw)
        assert (r.ok, r.step) == (False, 0) and "payload" in reason_of(r)

    @pytest.mark.parametrize("key", ["salt", "signature", "account"])
    def test_refuses_typed_data_with_another_top_level_field(self, key: str) -> None:
        r = check_portfolio_withdrawal([batch({**sale_auth(), key: "0x00"})], withdraw)
        assert (r.ok, r.step) == (False, 0)


HUGE = "9" * 4301  # past Python's 4,300-digit int() limit


class TestAmountsPastPythonsDigitLimitAreReadExactly:
    def test_a_signed_amount_too_long_for_int_is_a_refusal_not_an_exception(self) -> None:
        signed = transfer_auth({}, {"assets": [{"assetId": USDT, "amountRaw": HUGE}]})
        r = check_portfolio_withdrawal([batch(signed, plan_of(transfer_auth()))], withdraw)
        assert r.ok is False and r.reason

    def test_holdings_too_long_for_int_are_read_exactly(self) -> None:
        r = check_portfolio_withdrawal(
            [batch(transfer_auth()), batch(sale_auth())], {**withdraw, "holdings": {USDT: HUGE, TOKEN: "400"}}
        )
        assert r.ok is True and r.totals[0].held == HUGE

    def test_a_deposit_amount_too_long_for_int_is_compared_not_raised_on(self) -> None:
        r = check_portfolio_deposit([send(USDT_ADDR, TRANSFER)], {**deposit, "amount": HUGE})
        assert r.ok is False and "amount" in reason_of(r)
