"""The check before signing, for a vault's steps: what this client puts in front of the owner's wallet at all.

Each step is decoded from its own calldata and compared with what the caller knows independently of the step:
the product's vault record (`product.vault`: its chain, vault and asset addresses, read from the API before
the request), the owner's own address, and the amount the owner asked for. Nothing the step says about itself
(`purpose`, `checks`) is trusted. Only these calls are admitted:

  - `approve(vault, n)` on the vault's asset, for exactly the deposit's amount, never more;
  - `deposit(assets, receiver)` on the vault, for exactly the amount asked, receiver = the owner;
  - `withdraw(assets, receiver, owner)` on the vault, for exactly the assets asked, receiver = owner = the
    owner;
  - `redeem(shares, receiver, owner)` on the vault, for exactly the shares asked, receiver = owner = the
    owner. For "all", the shares are not checked (any above zero): only the receiver, the owner and the
    direction are. A caller that knows the owner's share balance should ask for those shares instead.

The vault record is the anchor: a caller that holds its own record of the vault (a pinned configuration)
should pass that one. Passing the product record read from the same API that builds the steps checks the steps
against that API's own record: it catches a wrong step, never a wrong record. No amount of zero is admitted.

The vault's chain must be an EVM chain the API serves (`SERVED_CHAINS`). Every address must be all lower
case, all upper case, or mixed case with a correct EIP-55 checksum.

Every step is a `send_transaction` on the vault's chain carrying no value, and its calldata must be exactly
the canonical encoding of what it decodes to: lower-case hex, no trailing bytes, no bits set above an
address's 20 bytes. A request is `[approve, deposit]`, `[deposit]` or one withdrawal, in that order. Nothing
here calls the network or signs.

A step is passed as the client returns it (a `Step` model) or as a plain mapping with the API's wire names; an
intent is a mapping with the names below.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from types import MappingProxyType
from typing import Any, Final, Literal, NotRequired, TypedDict

from pydantic import BaseModel

from ._evm import UINT256_DIGITS, same, served_chain
from ._evm import is_address as is_address
from .abi.calldata import Word, decode_call

__all__ = [
    "PAYLOAD_FIELDS",
    "StepCheck",
    "StepsCheck",
    "VaultCall",
    "VaultIntent",
    "VaultOnChain",
    "check_step",
    "check_steps",
    "payload_of",
]


class VaultOnChain(TypedDict):
    """The vault as the product record names it (`product.vault`)."""

    chain: str
    vaultAddress: str
    assetAddress: str


class VaultIntent(TypedDict):
    """What the owner asked for, in the terms of the vault record. Amounts are raw integers as decimal
    strings.

    A deposit is `{"action": "deposit", "vault", "owner", "assets"}`; a withdrawal is `{"action": "withdraw",
    "vault", "owner", "amount"}`, where `amount` is `{"kind": "assets", "raw"}`, `{"kind": "shares", "raw"}`
    or `{"kind": "all"}`."""

    action: Literal["deposit", "withdraw"]
    vault: VaultOnChain
    owner: str
    assets: NotRequired[str]
    amount: NotRequired[Mapping[str, str]]


VaultCall = Literal["approve", "deposit", "withdraw", "redeem"]


@dataclass(frozen=True)
class StepCheck:
    """`ok` with the call the step makes, or not `ok` with the reason."""

    ok: bool
    call: VaultCall | None = None
    reason: str | None = None


@dataclass(frozen=True)
class StepsCheck:
    """`ok` with `pending`, the steps with nothing to sign yet, or not `ok` with the first step refused
    (`step`, or None for the request as a whole) and the reason.

    Once each pending step has its payload, check the whole set again with `check_steps`, or check that step
    with `check_step`, passing the call its position takes: on its own, a step does not know where it stands,
    so a valid call in the wrong place would pass."""

    ok: bool
    pending: tuple[int, ...] = ()
    step: int | None = None
    reason: str | None = None


class _Undefined:
    pass


UNDEFINED: Final = _Undefined()

# The payload fields the API defines for each step kind. A payload carrying any other field is refused: a
# caller that hands the payload to a wallet would hand that field over too (an EIP-7702 authorization list,
# another chain, gas, a sender), and no check here reads it. Read-only, so a caller cannot widen it.
PAYLOAD_FIELDS: Final[Mapping[str, tuple[str, ...]]] = MappingProxyType(
    {
        "send_transaction": ("generation", "expiresAt", "to", "data", "value"),
        "sign_message": ("generation", "expiresAt", "bytes"),
        "sign_typed_data": ("generation", "expiresAt", "typedData"),
    }
)


def plain(x: Any) -> Any:
    """A model as the plain JSON it was read from (its wire names, only the fields it carried);
    anything else as is."""
    if isinstance(x, BaseModel):
        return x.model_dump(mode="python", by_alias=True, exclude_unset=True)
    return x


def get(obj: Any, key: str) -> Any:
    """`obj.key` in JavaScript: a member of a mapping, or UNDEFINED."""
    return obj.get(key, UNDEFINED) if isinstance(obj, Mapping) else UNDEFINED


def js_str(v: Any) -> str:
    """A value as JavaScript's String() writes it, for a reason's text."""
    if v is UNDEFINED:
        return "undefined"
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    if isinstance(v, Mapping):
        return "[object Object]"
    if isinstance(v, list | tuple):
        return ",".join("" if x is None else js_str(x) for x in v)
    return str(v)


def js_json(v: Any) -> str:
    """A value as JavaScript's JSON.stringify writes it, for a reason's text."""
    return (
        "undefined"
        if v is UNDEFINED
        else json.dumps(v, separators=(",", ":"), ensure_ascii=False, default=str)
    )


def payload_of(payload: Any, kind: str) -> dict[str, Any] | None:
    """The payload as a plain mapping holding only the fields `kind` defines, or None."""
    payload = plain(payload)
    if not isinstance(payload, Mapping):
        return None
    allowed = PAYLOAD_FIELDS[kind]
    return dict(payload) if all(k in allowed for k in payload) else None


_SELECTORS: Final[Mapping[str, VaultCall]] = {
    "0x095ea7b3": "approve",  # approve(address,uint256)
    "0x6e553f65": "deposit",  # deposit(uint256,address)
    "0xb460af94": "withdraw",  # withdraw(uint256,address,address)
    "0xba087652": "redeem",  # redeem(uint256,address,address)
}
# Each call's argument words, in order: an address or a uint256.
_ARGS: Final[Mapping[VaultCall, tuple[Word, ...]]] = {
    "approve": ("address", "uint"),
    "deposit": ("uint", "address"),
    "withdraw": ("uint", "address", "address"),
    "redeem": ("uint", "address", "address"),
}
_CALLS: Final = {selector: _ARGS[call] for selector, call in _SELECTORS.items()}
# A raw amount is a uint256: at most 78 digits; a longer one is refused as malformed.
_RAW: Final = re.compile(rf"0|[1-9][0-9]{{0,{UINT256_DIGITS - 1}}}", re.ASCII)


def exact_int(digits: str) -> int:
    """A string of decimal digits as an exact int at any length, as JavaScript's BigInt reads it. `int()`
    refuses more than 4,300 digits, and that limit is process-wide, so it is left alone."""
    return int(Decimal(digits))


def exact_str(n: int) -> str:
    """An int as its decimal digits at any length, as JavaScript's BigInt prints it (`str()` has the same
    4,300-digit limit as `int()`)."""
    return str(Decimal(n))


# An approval this large is unlimited in effect, whatever the intent says: never admitted.
_UNLIMITED_APPROVAL: Final = 2**128
_AMOUNT_KINDS: Final = ("assets", "shares", "all")


def _refuse(reason: str) -> StepCheck:
    return StepCheck(ok=False, reason=reason)


def _decode(data: str) -> tuple[VaultCall, list[int | str]] | str:
    """The call and its arguments, or why the calldata is not exactly one of the four calls' canonical
    encodings."""
    d = decode_call(data, _CALLS)
    if d.ok:
        return _SELECTORS[d.selector], d.words
    if d.refused == "encoding":
        return "the calldata is not a valid encoding"
    if d.refused == "selector":
        return "the calldata is not a vault call this client knows"
    return f"the calldata is not the canonical encoding of {_SELECTORS[d.selector or '']}"


def _intent_problem(intent: Any) -> str | None:
    """Why an intent is outside its documented shape; or nothing."""
    action = get(intent, "action")
    if action not in ("deposit", "withdraw"):
        return f"the intent's action {js_json(action)} is not deposit or withdraw"
    kind = get(get(intent, "amount"), "kind")
    if action == "withdraw" and kind not in _AMOUNT_KINDS:
        return f"the withdrawal's amount kind {js_json(kind)} is not assets, shares or all"
    # Checked here, so every check (check_steps too, for a step with nothing to sign yet) reads a complete
    # record.
    vault = get(intent, "vault")
    if (
        not is_address(get(vault, "vaultAddress"))
        or not is_address(get(vault, "assetAddress"))
        or not isinstance(get(vault, "chain"), str)
        or not get(vault, "chain")
    ):
        return "the vault record is not complete"
    if served_chain(get(vault, "chain")) is None:
        return f"the vault's chain {js_json(get(vault, 'chain'))} is not an EVM chain the API serves"
    return None


def _exact(raw: Any, n: int | str | None) -> bool:
    return (
        isinstance(raw, str)
        and _RAW.fullmatch(raw) is not None
        and isinstance(n, int)
        and n == exact_int(raw)
    )


def check_step(
    step: Any, intent: VaultIntent | Mapping[str, Any], expected: VaultCall | None = None
) -> StepCheck:
    """One step, checked against the owner's intent. `expected`, when given, is the call this step's position
    takes in the request (for a deposit's first of two steps, `approve`): any other call is refused, however
    valid alone."""
    problem = _intent_problem(intent)
    if problem:
        return _refuse(problem)
    step = plain(step)
    vault = get(intent, "vault")
    owner = get(intent, "owner")
    if not is_address(owner):
        return _refuse("the owner is not an address")
    chain: str = vault["chain"]
    vault_address: str = vault["vaultAddress"]
    asset_address: str = vault["assetAddress"]
    action = intent["action"]
    amount = get(intent, "amount")
    kind = get(amount, "kind")
    # An amount of nothing is never asked for: refused before any step is read, so no zero-amount call is
    # admitted.
    asked = get(intent, "assets") if action == "deposit" else (None if kind == "all" else get(amount, "raw"))
    if asked is not None and (
        not isinstance(asked, str) or not _RAW.fullmatch(asked) or exact_int(asked) == 0
    ):
        return _refuse("the amount asked for is zero or not a raw amount")
    step_kind = get(step, "kind")
    if step_kind != "send_transaction":
        return _refuse(f"a step of kind {js_str(step_kind)} is not a vault transaction")
    if get(step, "chainId") != chain:
        return _refuse(f"the step is on chain {js_str(get(step, 'chainId'))}, not the vault's chain {chain}")
    if get(step, "payload") is UNDEFINED:
        return _refuse("the step has nothing to sign yet")
    p = payload_of(step["payload"], "send_transaction")
    if p is None:
        return _refuse(
            f"the step's payload is not an object of only {', '.join(PAYLOAD_FIELDS['send_transaction'])}"
        )
    to, data, value = p.get("to"), p.get("data"), p.get("value")
    if not isinstance(to, str) or not isinstance(data, str) or not isinstance(value, str):
        return _refuse("the step has nothing to sign yet")
    if value != "0":
        return _refuse("the step sends value; a vault call carries none")
    if not is_address(to):
        return _refuse("the step is not sent to an address")
    d = _decode(data)
    if isinstance(d, str):
        return _refuse(d)
    call, words = d
    if expected is not None and call != expected:
        return _refuse(f"a {call} is not the call this step's position takes: {expected}")
    a, b, c = [*words, None, None, None][:3]

    if call == "approve":
        if action != "deposit":
            return _refuse("an approval is not what was asked for")
        if not same(to, asset_address):
            return _refuse("the approval is not sent to the vault's asset")
        if not isinstance(a, str) or not same(a, vault_address):
            return _refuse("the approval names a spender other than the vault")
        if isinstance(b, int) and b >= _UNLIMITED_APPROVAL:
            return _refuse("the approval is unlimited in effect (2^128 or more)")
        if not _exact(get(intent, "assets"), b):
            return _refuse("the approval's amount is not exactly the deposit's")
        return StepCheck(ok=True, call="approve")
    if call == "deposit":
        if action != "deposit":
            return _refuse("a deposit is not what was asked for")
        if not same(to, vault_address):
            return _refuse("the deposit is not sent to the vault")
        if not _exact(get(intent, "assets"), a):
            return _refuse("the deposit's amount is not exactly the one asked for")
        if not isinstance(b, str) or not same(b, owner):
            return _refuse("the deposit's receiver is not the owner")
        return StepCheck(ok=True, call="deposit")
    # withdraw or redeem
    if action != "withdraw":
        return _refuse(f"a {call} is not what was asked for")
    wanted = "withdraw" if kind == "assets" else "redeem"
    if call != wanted:
        return _refuse(f"a {call} is not what was asked for: the amount was given in {kind}")
    if not same(to, vault_address):
        return _refuse(f"the {call} is not sent to the vault")
    if not isinstance(b, str) or not same(b, owner):
        return _refuse(f"the {call}'s receiver is not the owner")
    if not isinstance(c, str) or not same(c, owner):
        return _refuse(f"the {call}'s owner is not the owner")
    if kind == "assets" and not _exact(get(amount, "raw"), a):
        return _refuse("the withdrawal's amount is not exactly the one asked for")
    if kind == "shares" and not _exact(get(amount, "raw"), a):
        return _refuse("the redeem is not for exactly the shares asked for")
    if kind == "all" and not (isinstance(a, int) and a > 0):
        return _refuse("the redeem is for no shares")
    return StepCheck(ok=True, call=call)


# The order a request's calls may come in: one step at most of each, in this sequence.
_SHAPES: Final[Mapping[str, tuple[tuple[VaultCall, ...], ...]]] = {
    "deposit": (("approve", "deposit"), ("deposit",)),
    "withdraw": (("withdraw",), ("redeem",)),
}


def check_steps(steps: Sequence[Any], intent: VaultIntent | Mapping[str, Any]) -> StepsCheck:
    """Every step of a request: each one that has something to sign is checked by `check_step`, and the steps
    together must be one of the admitted shapes. A step with nothing to sign yet (a deposit waiting on its
    approval) is checked by its kind and chain only, and takes its place in the shape. `step` names the first
    step refused, or None for the request as a whole."""
    problem = _intent_problem(intent)
    if problem:
        return StepsCheck(ok=False, step=None, reason=problem)
    action = intent["action"]
    shapes = _SHAPES[action]
    longest = max(len(s) for s in shapes)
    # Too many steps names the first one past the longest shape; too few (none) names the request.
    if not any(len(s) == len(steps) for s in shapes):
        return StepsCheck(
            ok=False,
            step=longest if len(steps) > longest else None,
            reason=f"a {action} request has {len(steps)} step(s), which is not a shape this client admits",
        )
    chain = get(get(intent, "vault"), "chain")
    calls: list[VaultCall | None] = []
    for i, raw in enumerate(steps):
        s = plain(raw)
        if get(s, "payload") is UNDEFINED:
            if get(s, "kind") != "send_transaction":
                return StepsCheck(
                    ok=False,
                    step=i,
                    reason=f"a step of kind {js_str(get(s, 'kind'))} is not a vault transaction",
                )
            if get(s, "chainId") != chain:
                return StepsCheck(
                    ok=False,
                    step=i,
                    reason=f"the step is on chain {js_str(get(s, 'chainId'))}, "
                    f"not the vault's chain {js_str(chain)}",
                )
            calls.append(None)
            continue
        r = check_step(s, intent)
        if not r.ok:
            return StepsCheck(ok=False, step=i, reason=r.reason)
        calls.append(r.call)

    def fits(shape: tuple[VaultCall, ...]) -> bool:
        return len(shape) == len(calls) and all(c is None or c == shape[i] for i, c in enumerate(calls))

    if any(fits(s) for s in shapes):
        return StepsCheck(ok=True, pending=tuple(i for i, c in enumerate(calls) if c is None))
    # The first step that fits no shape of this length.
    candidates = [s for s in shapes if len(s) == len(calls)]
    at = next(
        (i for i, c in enumerate(calls) if c is not None and all(s[i] != c for s in candidates)),
        None,
    )
    return StepsCheck(
        ok=False, step=at, reason=f"the steps are not in an order this client admits for a {action}"
    )


# The EIP-5792 version of the `wallet_sendCalls` params this client admits.
EIP5792_VERSION: Final = "2.0.0"

# The fields the API defines for a bundle and for its `sendCalls`. Any other field is refused: `sendCalls`
# goes to the wallet as it is, so an extra field (`capabilities`, a paymaster, an id) would go with it, and no
# check here reads it. Read-only, so a caller cannot widen it.
BUNDLE_FIELDS: Final[Mapping[str, tuple[str, ...]]] = MappingProxyType(
    {
        "bundle": ("stepIds", "sendCalls"),
        "sendCalls": ("version", "from", "chainId", "atomicRequired", "calls"),
        "call": ("to", "data", "value"),
    }
)

# A chain id as `wallet_sendCalls` takes it: lower-case hex, no leading zero.
_HEX_QUANTITY: Final = re.compile(r"0x(0|[1-9a-f][0-9a-f]*)", re.ASCII)
# A call's value: every admitted vault call carries none.
_NO_VALUE: Final = "0x0"


@dataclass(frozen=True)
class BundleCheck:
    """`ok`, or not `ok` with the reason."""

    ok: bool
    reason: str | None = None


def _only(x: Any, fields: tuple[str, ...]) -> bool:
    return isinstance(x, Mapping) and all(k in fields for k in x)


def check_bundle(request: Any, intent: VaultIntent | Mapping[str, Any]) -> BundleCheck:
    """A vault deposit's `bundle`, the steps offered as one `wallet_sendCalls` batch, checked before it goes
    to the wallet. The steps themselves must pass `check_steps` with nothing pending; the bundle must then be
    exactly those steps: its `stepIds` every step's id in order, and each call the step's `to` and `data`
    byte for byte, with no value. Its `sendCalls` must be from the owner, on the vault's chain, all-or-nothing
    (`atomicRequired: true`), EIP-5792 version `2.0.0`, and carry no field beyond those. A request with no
    bundle is refused: send its steps one at a time.

    The request is passed as the client returns it (a `Request` model) or as a plain mapping with the API's
    wire names."""
    problem = _intent_problem(intent)
    if problem:
        return BundleCheck(ok=False, reason=problem)
    if intent["action"] != "deposit":
        return BundleCheck(ok=False, reason="a bundle is offered only for a deposit")
    req = plain(request)
    steps = get(req, "steps")
    if not isinstance(steps, list | tuple):
        return BundleCheck(ok=False, reason="the request has no steps")
    steps = [plain(s) for s in steps]
    s = check_steps(steps, intent)
    if not s.ok:
        return BundleCheck(ok=False, reason=s.reason if s.step is None else f"step {s.step}: {s.reason}")
    if s.pending:
        return BundleCheck(ok=False, reason="a step has nothing to sign yet, so the bundle cannot be checked")
    b = plain(get(req, "bundle"))
    if b is UNDEFINED or b is None:
        return BundleCheck(ok=False, reason="the request offers no bundle; send its steps one at a time")
    if not _only(b, BUNDLE_FIELDS["bundle"]):
        return BundleCheck(
            ok=False, reason=f"the bundle is not an object of only {', '.join(BUNDLE_FIELDS['bundle'])}"
        )
    ids = get(b, "stepIds")
    if (
        not isinstance(ids, list | tuple)
        or len(ids) != len(steps)
        or any(not isinstance(i, str) or i != get(st, "stepId") for i, st in zip(ids, steps, strict=True))
    ):
        return BundleCheck(ok=False, reason="the bundle's stepIds are not the request's steps, in order")
    sc = get(b, "sendCalls")
    if not _only(sc, BUNDLE_FIELDS["sendCalls"]):
        return BundleCheck(
            ok=False,
            reason=f"the bundle's sendCalls is not an object of only {', '.join(BUNDLE_FIELDS['sendCalls'])}",
        )
    if get(sc, "version") != EIP5792_VERSION:
        return BundleCheck(ok=False, reason=f"the bundle is not EIP-5792 version {EIP5792_VERSION}")
    if get(sc, "atomicRequired") is not True:
        return BundleCheck(ok=False, reason="the bundle is not all-or-nothing (atomicRequired is not true)")
    frm = get(sc, "from")
    if not is_address(frm) or not same(frm, intent["owner"]):
        return BundleCheck(ok=False, reason="the bundle is not from the owner")
    chain = get(get(intent, "vault"), "chain")
    cid = get(sc, "chainId")
    # The vault's chain, a served one, written as hex. A chain id is never converted to decimal: thousands of
    # digits would raise there instead of refusing.
    want = f"0x{int(str(served_chain(chain))):x}"
    if not isinstance(cid, str) or not _HEX_QUANTITY.fullmatch(cid) or cid != want:
        return BundleCheck(ok=False, reason=f"the bundle is not on the vault's chain {js_str(chain)}")
    calls = get(sc, "calls")
    if not isinstance(calls, list | tuple) or len(calls) != len(steps):
        return BundleCheck(ok=False, reason="the bundle does not have one call per step")
    for i, (c, st) in enumerate(zip(calls, steps, strict=True)):
        if not _only(c, BUNDLE_FIELDS["call"]):
            return BundleCheck(
                ok=False, reason=f"call {i} is not an object of only {', '.join(BUNDLE_FIELDS['call'])}"
            )
        p = get(st, "payload")
        if get(c, "to") != get(p, "to") or get(c, "data") != get(p, "data"):
            return BundleCheck(ok=False, reason=f"call {i} is not step {i}'s to and data, byte for byte")
        if get(c, "value") != _NO_VALUE:
            return BundleCheck(ok=False, reason=f"call {i} sends value; a vault call carries none")
    return BundleCheck(ok=True)
