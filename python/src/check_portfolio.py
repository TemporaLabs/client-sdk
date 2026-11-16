"""The checks before signing for a portfolio's steps: what this client puts in front of the owner's wallet for
a portfolio withdrawal or deposit. Like `check_step` for a vault, each one reads the step's own bytes and
compares them with what the caller knows; nothing a step says about itself is trusted. Nothing here calls the
network or signs.

**A withdrawal** is one or more EIP-712 authorizations, the provider's `Withdrawal` struct. Admitted, and
nothing else:
  - the struct exactly: its domain name and version (`1` for a plain transfer, `2` for a sale), its field
  lists IN
    ORDER (a reordered struct hashes differently), no field shown that is not signed and none signed that is
    not read;
  - on the portfolio's chain, debiting the owner's smart account (`verifyingContract`), paying the owner's
  own wallet
    (`recipientAccountId`), for the named portfolio;
  - a sale settles in the settlement asset; a plain transfer moves only that asset;
  - each amount a whole number of units above zero, each asset named once, each entry exactly `{assetId,
  amountRaw}`;
  - expiring in the future, and no later than `maxLifetimeSeconds` from now (the provider gives ten minutes);
  `now`
    and the lifetime must be finite numbers, the lifetime above zero, or nothing is admitted;
  - each batch exactly the plan the API attached to its step (same kind, every asset at exactly its amount,
  every
    signed asset planned, none planned twice);
  - each asset's total over every batch at most the asked fraction (or all) of what the caller says the smart
  account
    holds, which the caller reads from the API's `positions`. An asset not held is refused.
Every chain, account and asset id is read with one strict parser: `eip155:<reference>` with no leading zero,
and a 20-byte address compared in any letter case, refused when mixed case with a wrong EIP-55 checksum. The
portfolio's chain must be an EVM chain the API serves (`SERVED_CHAINS`).

**A deposit** is the enrol signature (only when not yet enrolled), then the transfer of the deposit token to
the smart account the API names for this owner. Admitted: `[enrol, transfer]`, `[transfer]`, or `[enrol]` when
no amount was asked. The transfer is exactly `transfer(smartAccount, amount)` on the token, on the portfolio's
chain, with no value, in its canonical encoding.

**The enrol signature is blind.** Its payload is a 32-byte hash the provider builds, and the provider does not
publish how. This check confirms its kind, purpose, chain and length, and nothing about what it commits to.
`personal_sign`'s prefix means the signature cannot be replayed as a transaction, but many smart accounts
accept a `personal_sign` over a 32-byte hash as an ERC-1271 signature, so a blind hash may still count as an
off-chain approval. What the hash enrols is guarded only by the API, which refuses an enrolment whose agent is
not on its allow list before the hash is offered for signing.
"""

from __future__ import annotations

import math
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Final, Literal, NotRequired, TypedDict

from ._evm import served_chain
from .abi.calldata import decode_call
from .check import (
    PAYLOAD_FIELDS,
    UNDEFINED,
    exact_int,
    exact_str,
    get,
    is_address,
    js_json,
    js_str,
    payload_of,
    plain,
)

__all__ = [
    "PortfolioDepositCheck",
    "PortfolioDepositIntent",
    "PortfolioTotal",
    "PortfolioWithdrawalCheck",
    "PortfolioWithdrawalIntent",
    "check_portfolio_deposit",
    "check_portfolio_withdrawal",
]


class PortfolioWithdrawalIntent(TypedDict):
    """What the owner asked to withdraw from a portfolio, and what the caller knows independently of the
    steps.

    `owner` is the connected wallet, the only recipient there is; `smartAccount` the smart account the API
    names for this owner's portfolio (the request's `smartAccount`); `portfolioId` the portfolio the owner
    chose; `chain` the portfolio's chain as `eip155:<reference>`; `settlementAssetId` the asset a sale settles
    in, and the only one a plain transfer may move; `amount` all of each holding (`{"kind": "all"}`) or a
    fraction of each (`{"kind": "fraction", "value"}`, a decimal above 0 and at most 1 with up to 18 places);
    `holdings` what the smart account holds, raw units by asset id, as the caller read it from `positions`;
    `now` now, in milliseconds since the epoch; `maxLifetimeSeconds` the longest an authorization may stay
    valid from now, one hour when left out."""

    owner: str
    smartAccount: str
    portfolioId: str
    chain: str
    settlementAssetId: str
    amount: Mapping[str, str]
    holdings: Mapping[str, str]
    now: float
    maxLifetimeSeconds: NotRequired[float]


class PortfolioDepositIntent(TypedDict):
    """What the owner asked to deposit into a portfolio: the portfolio's `chain` (`eip155:<reference>`), the
    deposit token's contract on it (`tokenAddress`), the `smartAccount` the API names for this owner, and the
    raw `amount` asked for, left out for an enrol-only request."""

    chain: str
    tokenAddress: str
    smartAccount: str
    amount: NotRequired[str]


@dataclass(frozen=True)
class PortfolioTotal:
    asset_id: str
    amount: str
    held: str


@dataclass(frozen=True)
class PortfolioWithdrawalCheck:
    """`ok` with each signed batch's kind, each asset's total against what is held, the earliest expiry and
    the batches with nothing to sign yet; or not `ok` with the first step refused (None for the request) and
    the reason."""

    ok: bool
    kinds: tuple[Literal["transfer", "sale"], ...] = ()
    totals: tuple[PortfolioTotal, ...] = ()
    expires_at: datetime | None = None
    pending: tuple[int, ...] = ()
    step: int | None = None
    reason: str | None = None


@dataclass(frozen=True)
class PortfolioDepositCheck:
    ok: bool
    pending: tuple[int, ...] = ()
    step: int | None = None
    reason: str | None = None


_TYPED_DATA_FIELDS: Final = ("domain", "types", "primaryType", "message")
_DOMAIN_NAME: Final = "Glider Withdrawal Authorization"
_TRANSFER_FIELDS: Final = (
    ("portfolioId", "string"),
    ("recipientAccountId", "string"),
    ("assets", "WithdrawalAsset[]"),
    ("nonce", "bytes32"),
    ("expiresAt", "uint256"),
)
_FIELDS: Final = {
    "transfer": _TRANSFER_FIELDS,
    "sale": (*_TRANSFER_FIELDS, ("liquidate", "bool"), ("settlementAssetId", "string")),
}
_ASSET_FIELDS: Final = (("assetId", "string"), ("amountRaw", "string"))
# EIP-712's own order for the domain fields it uses.
_DOMAIN_FIELDS: Final = (
    ("name", "string"),
    ("version", "string"),
    ("chainId", "uint256"),
    ("verifyingContract", "address"),
)
_DEFAULT_LIFETIME_S: Final = 3_600
_MS_PER_S: Final = 1_000
_FRACTION_PLACES: Final = 18
_MAX_SAFE_INTEGER: Final = 2**53 - 1

# A raw amount is a uint256: at most 78 digits. Anything longer can never match a chain value, so it is
# refused as malformed, and no client spends unbounded time converting it.
_RAW_POSITIVE: Final = re.compile(r"[1-9][0-9]{0,77}", re.ASCII)
_DIGITS: Final = re.compile(r"[0-9]{1,78}", re.ASCII)
_BYTES32: Final = re.compile(r"0x[0-9a-fA-F]{64}", re.ASCII)
_CHAIN: Final = re.compile(r"eip155:([1-9][0-9]*)", re.ASCII)
_ACCOUNT: Final = re.compile(r"eip155:([1-9][0-9]*):(0x[0-9a-fA-F]{40})", re.ASCII)
_ASSET: Final = re.compile(r"eip155:([1-9][0-9]*)/erc20:(0x[0-9a-fA-F]{40})", re.ASCII)
_FRACTION: Final = re.compile(rf"(0|1)(?:\.(\d{{1,{_FRACTION_PLACES}}}))?", re.ASCII)


def _asset_key(v: Any) -> str | None:
    """`eip155:<ref>/erc20:<address>` as one comparable string, or None. One parser for every asset id."""
    m = _ASSET.fullmatch(v) if isinstance(v, str) else None
    return f"eip155:{m.group(1)}/erc20:{m.group(2).lower()}" if m and is_address(m.group(2)) else None


def _chain_ref(v: Any) -> str | None:
    m = _CHAIN.fullmatch(v) if isinstance(v, str) else None
    return m.group(1) if m else None


def _same(a: str, b: str) -> bool:
    return a.lower() == b.lower()


def _keys_are(o: Mapping[str, Any], want: Sequence[str]) -> bool:
    return len(o) == len(want) and all(w in o for w in want)


def _fields_are(fields: Any, want: Sequence[tuple[str, str]]) -> bool:
    """The struct's fields exactly as listed, in order."""
    return (
        isinstance(fields, list)
        and len(fields) == len(want)
        and all(
            isinstance(f, Mapping)
            and _keys_are(f, ("name", "type"))
            and f["name"] == want[i][0]
            and f["type"] == want[i][1]
            for i, f in enumerate(fields)
        )
    )


def _is_number(v: Any) -> bool:
    return isinstance(v, int | float) and not isinstance(v, bool)


def _fraction_of(a: Any) -> tuple[int, int] | None:
    """`all`, or the fraction as (numerator, denominator); None for anything else."""
    if get(a, "kind") == "all":
        return 1, 1
    value = get(a, "value")
    m = _FRACTION.fullmatch(value) if get(a, "kind") == "fraction" and isinstance(value, str) else None
    if not m:
        return None
    den = 10**_FRACTION_PLACES
    num = int(m.group(1)) * den + int((m.group(2) or "").ljust(_FRACTION_PLACES, "0"))
    return None if num == 0 or num > den else (num, den)


Amounts = dict[str, tuple[str, int]]


def _add_to(totals: Amounts, more: Amounts) -> None:
    for k, (asset_id, amount) in more.items():
        had = totals.get(k)
        totals[k] = (had[0] if had else asset_id, (had[1] if had else 0) + amount)


def _read_plan(plan: Any) -> Amounts | None:
    """A batch's plan as each asset's amount, or None when it is not a list of distinct assets with
    whole amounts."""
    assets = get(plan, "assets")
    if not isinstance(plan, Mapping) or not isinstance(assets, list):
        return None
    out: Amounts = {}
    for p in assets:
        k = _asset_key(get(p, "assetId"))
        raw = get(p, "amountRaw")
        if k is None or k in out or not isinstance(raw, str) or not _DIGITS.fullmatch(raw):
            return None
        out[k] = (p["assetId"], exact_int(raw))
    return out


def _expiry_of(raw: Any) -> int | None:
    """The expiry in seconds, when it is a safe whole number above zero."""
    if _is_number(raw):
        n: float = raw
    elif isinstance(raw, str) and _DIGITS.fullmatch(raw):
        n = exact_int(raw)
    else:
        return None
    if isinstance(n, float) and (not math.isfinite(n) or not n.is_integer()):
        return None
    n = int(n)
    return n if 0 < n <= _MAX_SAFE_INTEGER else None


def check_portfolio_withdrawal(
    steps: Sequence[Any], intent: PortfolioWithdrawalIntent | Mapping[str, Any]
) -> PortfolioWithdrawalCheck:
    """Every step of a portfolio withdrawal, together: each batch's authorization, then the totals against the
    holdings."""

    def whole(reason: str) -> PortfolioWithdrawalCheck:
        return PortfolioWithdrawalCheck(ok=False, step=None, reason=reason)

    owner = get(intent, "owner")
    smart_account = get(intent, "smartAccount")
    chain = get(intent, "chain")
    if not is_address(owner):
        return whole("the owner is not an address")
    if not is_address(smart_account):
        return whole("the smart account is not an address")
    ref = served_chain(chain)
    if not ref:
        return whole(f"the chain {js_json(chain)} is not an EVM chain the API serves")
    settlement = _asset_key(get(intent, "settlementAssetId"))
    if not settlement:
        return whole("the settlement asset is not an asset id")
    amount = get(intent, "amount")
    fraction = _fraction_of(amount)
    if not fraction:
        return whole("the fraction asked for is not a decimal above 0 and at most 1")
    if len(steps) == 0:
        return whole("a withdrawal with no steps has nothing to check")
    # A clock or a lifetime that is not a finite number would admit any expiry.
    now = get(intent, "now")
    if not _is_number(now) or not math.isfinite(now):
        return whole("now is not a finite number of milliseconds")
    lifetime = get(intent, "maxLifetimeSeconds")
    lifetime_s = _DEFAULT_LIFETIME_S if lifetime is UNDEFINED or lifetime is None else lifetime
    if not _is_number(lifetime_s) or not math.isfinite(lifetime_s) or lifetime_s <= 0:
        return whole("the longest lifetime is not a finite number of seconds above zero")
    now_s = now / _MS_PER_S

    kinds: list[Literal["transfer", "sale"]] = []
    pending: list[int] = []
    totals: Amounts = {}
    earliest: float = math.inf

    for i, raw_step in enumerate(steps):
        s = plain(raw_step)

        def refuse(reason: str, i: int = i) -> PortfolioWithdrawalCheck:
            return PortfolioWithdrawalCheck(ok=False, step=i, reason=reason)

        not_the_form = refuse("it is not in the form the provider's withdrawal authorization takes")
        if get(s, "kind") != "sign_typed_data":
            return refuse(f"a step of kind {js_str(get(s, 'kind'))} is not a withdrawal authorization")
        if _chain_ref(get(s, "chainId")) != ref:
            return refuse(f"the step is on chain {js_str(get(s, 'chainId'))}, not {chain}")
        if get(s, "payload") is UNDEFINED:
            # A batch with nothing to sign yet still counts its plan toward the totals, so checking a request
            # in turns, as its batches arrive, cannot admit more than checking it whole.
            if get(s, "plan") is not UNDEFINED:
                plan = _read_plan(s["plan"])
                if plan is None:
                    return refuse("its plan cannot be read")
                _add_to(totals, plan)
            pending.append(i)
            continue
        payload = payload_of(s["payload"], "sign_typed_data")
        if payload is None:
            return refuse(
                f"its payload is not an object of only {', '.join(PAYLOAD_FIELDS['sign_typed_data'])}"
            )
        typed = payload.get("typedData")
        # Exactly the four EIP-712 fields: anything else beside them would reach the wallet unread.
        if not isinstance(typed, Mapping) or not _keys_are(typed, _TYPED_DATA_FIELDS):
            return not_the_form
        domain = typed["domain"] if isinstance(typed["domain"], Mapping) else {}
        types = typed["types"] if isinstance(typed["types"], Mapping) else {}
        m = typed["message"] if isinstance(typed["message"], Mapping) else {}
        sale = m.get("liquidate") is True
        shape: Literal["transfer", "sale"] = "sale" if sale else "transfer"

        if (
            typed["primaryType"] != "Withdrawal"
            or domain.get("name") != _DOMAIN_NAME
            or domain.get("version") != ("2" if sale else "1")
        ):
            return not_the_form
        if not _keys_are(domain, [f[0] for f in _DOMAIN_FIELDS]):
            return not_the_form
        if any(t not in ("Withdrawal", "WithdrawalAsset", "EIP712Domain") for t in types):
            return not_the_form
        # A domain type, if present, replaces the one the signature uses: the standard four, in EIP-712's
        # order.
        if "EIP712Domain" in types and not _fields_are(types["EIP712Domain"], _DOMAIN_FIELDS):
            return not_the_form
        if not _fields_are(types.get("Withdrawal"), _FIELDS[shape]) or not _fields_are(
            types.get("WithdrawalAsset"), _ASSET_FIELDS
        ):
            return not_the_form
        if not _keys_are(m, [f[0] for f in _FIELDS[shape]]):
            return not_the_form

        chain_id = domain.get("chainId")
        if not _is_number(chain_id) or js_str(chain_id) != ref:
            return refuse(f"it is for chain {js_str(chain_id)}, not {chain}")
        verifying = domain.get("verifyingContract")
        if not isinstance(verifying, str) or not is_address(verifying) or not _same(verifying, smart_account):
            return refuse(
                f"it would take funds from {js_str(verifying)}, not the smart account {smart_account}"
            )
        if m["portfolioId"] != get(intent, "portfolioId"):
            return refuse("it is for another portfolio")
        recipient = m["recipientAccountId"]
        to = _ACCOUNT.fullmatch(recipient) if isinstance(recipient, str) else None
        if not to or to.group(1) != ref or not is_address(to.group(2)) or not _same(to.group(2), owner):
            return refuse(f"it would pay {js_str(recipient)}, not the owner {owner} on {chain}")
        if sale and _asset_key(m["settlementAssetId"]) != settlement:
            return refuse(
                f"it settles in {js_str(m['settlementAssetId'])}, not {intent['settlementAssetId']}"
            )
        if not isinstance(m["nonce"], str) or not _BYTES32.fullmatch(m["nonce"]):
            return not_the_form

        expiry = _expiry_of(m["expiresAt"])
        if expiry is None:
            return not_the_form
        if expiry <= now_s:
            return refuse("it has expired")
        if expiry > now_s + lifetime_s:
            return refuse(f"it stays valid for more than {js_str(lifetime_s)} seconds")
        earliest = min(earliest, expiry)

        assets = m["assets"] if isinstance(m["assets"], list) else []
        if not assets:
            return refuse("it names no asset")
        signed: Amounts = {}
        for x in assets:
            if not isinstance(x, Mapping):
                return not_the_form
            key = _asset_key(x.get("assetId"))
            raw = x.get("amountRaw")
            if (
                not key
                or ref != re.split(r"[:/]", key)[1]
                or not isinstance(raw, str)
                or not _RAW_POSITIVE.fullmatch(raw)
            ):
                return refuse(
                    f"it names an asset that is not a token on {chain}, "
                    "or an amount that is not a whole number of "
                    "units above zero"
                )
            if not _keys_are(x, [f[0] for f in _ASSET_FIELDS]):
                return not_the_form
            if key in signed:
                return refuse("it names the same asset twice")
            if not sale and key != settlement:
                return refuse("it would move a holding other than the settlement asset without selling it")
            signed[key] = (x["assetId"], exact_int(raw))

        # The API's own plan for this batch: what it asked the provider for. The signed batch must be exactly
        # that, both ways. A batch with no plan is refused (the API attaches one to every batch).
        step_plan = get(s, "plan")
        plan = _read_plan(step_plan)
        matches = (
            isinstance(step_plan, Mapping)
            and step_plan.get("liquidate") is sale
            and plan is not None
            and len(plan) == len(signed)
            and all(k in signed and signed[k][1] == p[1] for k, p in plan.items())
            and all(k in plan for k in signed)
        )
        if not matches:
            return refuse(
                "it is not the plan the API attached to this step: another kind, another amount, "
                "an asset added or "
                "left out, or one named twice"
            )
        kinds.append(shape)
        _add_to(totals, signed)
    if len(pending) == len(steps):
        return whole("none of the withdrawal steps has anything to sign yet")

    # The bound: each asset's total over every batch, against what the caller says the smart account holds.
    held: dict[str, int] = {}
    holdings = get(intent, "holdings")
    for asset_id, raw in holdings.items() if isinstance(holdings, Mapping) else []:
        k = _asset_key(asset_id)
        if k and isinstance(raw, str) and _DIGITS.fullmatch(raw):
            held[k] = exact_int(raw)
    out: list[PortfolioTotal] = []
    for k, (asset_id, total) in totals.items():
        h = held.get(k, 0)
        if h == 0:
            return whole(f"the withdrawal names {asset_id}, which the smart account does not hold")
        allowed = h * fraction[0] // fraction[1]
        if total > allowed:
            what = (
                "the account holds" if get(amount, "kind") == "all" else "the fraction asked of what it holds"
            )
            return whole(
                f"the withdrawal asks for {exact_str(total)} units of {asset_id}, more than {what} "
                f"({exact_str(allowed)} of {exact_str(h)})"
            )
        out.append(PortfolioTotal(asset_id=asset_id, amount=exact_str(total), held=exact_str(h)))
    expires = datetime.fromtimestamp(0 if earliest == math.inf else earliest, tz=UTC)
    return PortfolioWithdrawalCheck(
        ok=True, kinds=tuple(kinds), totals=tuple(out), expires_at=expires, pending=tuple(pending)
    )


_TRANSFER: Final = {"0xa9059cbb": ("address", "uint")}  # transfer(address,uint256)
_ENROL_PURPOSE: Final = "enrol"


def check_portfolio_deposit(
    steps: Sequence[Any], intent: PortfolioDepositIntent | Mapping[str, Any]
) -> PortfolioDepositCheck:
    """A portfolio deposit's steps: the enrol signature when there is one, then the transfer."""

    def whole(reason: str) -> PortfolioDepositCheck:
        return PortfolioDepositCheck(ok=False, step=None, reason=reason)

    chain = get(intent, "chain")
    ref = served_chain(chain)
    if not ref:
        return whole(f"the chain {js_json(chain)} is not an EVM chain the API serves")
    smart_account = get(intent, "smartAccount")
    token = get(intent, "tokenAddress")
    if not is_address(smart_account):
        return whole("the smart account is not an address")
    if not is_address(token):
        return whole("the token is not an address")
    amount = get(intent, "amount")
    # Left out means enrol only; null is not leaving it out, and is refused below as not a raw amount.
    no_amount = amount is UNDEFINED
    if not no_amount and (not isinstance(amount, str) or not _RAW_POSITIVE.fullmatch(amount)):
        return whole("the amount asked for is zero or not a raw amount")

    want: list[tuple[str, ...]] = [("enrol",)] if no_amount else [("enrol", "transfer"), ("transfer",)]
    shape = next((w for w in want if len(w) == len(steps)), None)
    if shape is None:
        return whole(
            f"a portfolio deposit{' with no amount' if no_amount else ''} with {len(steps)} steps "
            "is not a shape "
            "this client admits"
        )
    pending: list[int] = []

    for i, raw_step in enumerate(steps):
        s = plain(raw_step)

        def refuse(reason: str, i: int = i) -> PortfolioDepositCheck:
            return PortfolioDepositCheck(ok=False, step=i, reason=reason)

        role = shape[i]
        is_enrol = get(s, "kind") == "sign_message"
        if (role == "enrol") != is_enrol:
            return refuse(
                "the steps are not in the order a portfolio deposit takes: "
                "the enrol signature, then the transfer"
            )
        if _chain_ref(get(s, "chainId")) != ref:
            return refuse(f"the step is on chain {js_str(get(s, 'chainId'))}, not {chain}")
        if role == "enrol":
            if get(s, "purpose") != _ENROL_PURPOSE:
                return refuse(
                    f"a signature with purpose {js_str(get(s, 'purpose'))} is not the enrol signature"
                )
            if get(s, "payload") is UNDEFINED:
                pending.append(i)
                continue
            enrol = payload_of(s["payload"], "sign_message")
            if enrol is None:
                return refuse(
                    "the enrol signature's payload is not an object of only "
                    + ", ".join(PAYLOAD_FIELDS["sign_message"])
                )
            if not isinstance(enrol.get("bytes"), str) or not _BYTES32.fullmatch(enrol["bytes"]):
                return refuse("the enrol signature is not exactly 32 bytes")
            continue
        if get(s, "kind") != "send_transaction":
            return refuse(f"a step of kind {js_str(get(s, 'kind'))} is not the deposit transfer")
        if get(s, "payload") is UNDEFINED:
            pending.append(i)
            continue
        p = payload_of(s["payload"], "send_transaction")
        if p is None:
            return refuse(
                "the transfer's payload is not an object of only "
                + ", ".join(PAYLOAD_FIELDS["send_transaction"])
            )
        to, data, value = p.get("to"), p.get("data"), p.get("value")
        if not isinstance(to, str) or not isinstance(data, str) or not isinstance(value, str):
            return refuse("the transfer has nothing to send")
        if value != "0":
            return refuse("the transfer sends value; a token transfer carries none")
        if not is_address(to) or not _same(to, token):
            return refuse("the transfer is not sent to the deposit token's contract")
        d = decode_call(data, _TRANSFER)  # type: ignore[arg-type]
        if not d.ok and d.refused != "canonical":
            return refuse("the transfer is not a call to transfer(address,uint256)")
        if not d.ok:
            return refuse("the calldata is not the canonical encoding of transfer")
        recipient, sent = d.words[0], d.words[1]
        if not isinstance(recipient, str) or not _same(recipient, smart_account):
            return refuse(f"the transfer pays {recipient}, not the smart account {smart_account}")
        if no_amount or sent != exact_int(amount):
            return refuse("the transfer's amount is not exactly the one asked for")
    return PortfolioDepositCheck(ok=True, pending=tuple(pending))
