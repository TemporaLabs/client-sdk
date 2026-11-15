"""The typed client for the Tempora API: one method per call, every answer a Result that never raises.

The MCP client is in `temporalabs_client.mcp`. Every named shape of the API is in `temporalabs_client.models`.
"""

from ._result import Err, Ok, Result
from ._version import VERSION
from .check import StepCheck, StepsCheck, VaultCall, VaultIntent, VaultOnChain, check_step, check_steps
from .check_portfolio import (
    PortfolioDepositCheck,
    PortfolioDepositIntent,
    PortfolioTotal,
    PortfolioWithdrawalCheck,
    PortfolioWithdrawalIntent,
    check_portfolio_deposit,
    check_portfolio_withdrawal,
)
from .client import Client, create_client
from .generated import models
from .generated.models import ApiError, Request, Step, Token
from .generated.spec import API_VERSION, CLIENT_KEY_HEADER
from .sign_in import SignedIn, SignInClient, sign_in, with_owner_retry

__version__ = VERSION

__all__ = [
    "API_VERSION",
    "CLIENT_KEY_HEADER",
    "ApiError",
    "Client",
    "Err",
    "Ok",
    "PortfolioDepositCheck",
    "PortfolioDepositIntent",
    "PortfolioTotal",
    "PortfolioWithdrawalCheck",
    "PortfolioWithdrawalIntent",
    "Request",
    "Result",
    "SignInClient",
    "SignedIn",
    "Step",
    "StepCheck",
    "StepsCheck",
    "Token",
    "VaultCall",
    "VaultIntent",
    "VaultOnChain",
    "__version__",
    "check_portfolio_deposit",
    "check_portfolio_withdrawal",
    "check_step",
    "check_steps",
    "create_client",
    "models",
    "sign_in",
    "with_owner_retry",
]
