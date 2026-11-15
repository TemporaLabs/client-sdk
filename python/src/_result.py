"""What every call returns: `Ok` or `Err`, never a raised exception for an API or network problem."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Generic, Literal, TypeVar

from .generated.models import ApiError

T = TypeVar("T", covariant=True)

__all__ = ["ApiError", "Err", "Ok", "Result"]


@dataclass(frozen=True)
class Ok(Generic[T]):
    """A call the API answered with its documented answer, checked against the API's schema."""

    status: int
    body: T
    trace_id: str | None = None
    ok: Literal[True] = True


@dataclass(frozen=True)
class Err:
    """A call that did not succeed. `error.outcome` says what happened: `refused` or `failed` (nothing
    happened) or `unknown` (a write may have gone through: check its status before trying again). `status` is
    0 when the call got no HTTP answer. `retry_after` is the seconds the API asks the caller to wait, when it
    says."""

    status: int
    error: ApiError
    trace_id: str | None = None
    retry_after: float | None = None
    ok: Literal[False] = False


Result = Ok[T] | Err
