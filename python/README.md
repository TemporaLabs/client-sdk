# Tempora API client for Python

**The typed Python client for the Tempora API.** Built by Tempora Labs and contributors.

[![ci](https://github.com/TemporaLabs/client-sdk/actions/workflows/ci-python.yml/badge.svg?branch=main)](https://github.com/TemporaLabs/client-sdk/actions/workflows/ci-python.yml)

`temporalabs-client` lets an application read Tempora Labs' products, sign a wallet owner in, and take that
owner's deposits and withdrawals into its vaults and portfolios. It is generated from the API's own OpenAPI
document, so every call, input and answer is typed. Every call returns a result instead of raising, and every
answer is checked against the API's schema before your code sees it.

It is the Python version of [`@temporalabs/client`](https://www.npmjs.com/package/@temporalabs/client), made from the
same API document in the same repository. The two make the same calls, send the same headers, refuse the same
options and judge every answer the same way: a shared set of answers in the repository holds both to it.

**The client never signs; the owner's wallet does.** A deposit or a withdrawal comes back as steps for the
owner's wallet to sign or send. Before they reach the wallet, the client can check each step against what the
owner asked for. Your code then hands the signed result back.

> **Pre-1.0.** A minor version (`0.2.0`) may change the client's interface; see [versioning](https://github.com/TemporaLabs/client-sdk/blob/main/docs/versioning.md).
> Deposits and withdrawals move real funds: check every step before the owner signs it.

## Install

```bash
pip install "temporalabs-client @ git+https://github.com/TemporaLabs/client-sdk.git@v0.1.2#subdirectory=python"
```

With uv:

```bash
uv add "temporalabs-client @ git+https://github.com/TemporaLabs/client-sdk.git@v0.1.2#subdirectory=python"
```

It installs from this repository at a release tag; it is not on PyPI. In a `requirements.txt`, or under `dependencies`
in a `pyproject.toml`, use the same quoted string. Keep the tag: without it, pip installs whatever `main` holds.

It needs Python 3.13. Its runtime dependencies are `httpx` and `pydantic`. The client is synchronous.

## A first call

```python
import os

from temporalabs_client import create_client

client = create_client("https://<api origin>", client_key=os.environ["TEMPORALABS_CLIENT_KEY"])
r = client.products()
if r.ok:
    print(r.body.products)
else:
    print(r.error.code, r.error.outcome)
```

A call returns `Ok(status, body, trace_id)` or `Err(status, error, trace_id, retry_after)`; `r.ok` tells them apart.
On an error, `error.outcome` says what happened:

- `refused` or `failed`: nothing happened.
- `unknown`: a write may have gone through, so check its status before trying again.

Inputs are keyword arguments: `path=`, `query=` and `body=` as each call takes them, and `owner_token=` to send a
token other than the client's. A call's answer is a model generated from the API document, with the document's own
field names (`r.body.expiresAt`). Fields the API adds later are kept, in `model_extra`.

A bad option, such as a `base_url` that is not an absolute URL, raises `ValueError` or `TypeError` from
`create_client`, so no call raises for it. Reads of products (`products`, `product`, `product_read`,
`products_route`) need no owner token. Every call, its input and the error codes are listed in
[`llms.txt`](https://github.com/TemporaLabs/client-sdk/blob/main/typescript/llms.txt), written for the TypeScript
client; the Python names are the same.

## Sign in an owner

`sign_in(client, owner=..., sign_message=..., check=...)` runs the challenge, the owner's signature and the verify
call, and returns an owner token. `check` sees the challenge text before anything is signed, so you can refuse one
that does not name your site, this owner and an expiry minutes away; only a return of `True` goes on.
`with_owner_retry` signs in again and repeats a call once, and only once, when the token is refused as
`wallet_proof_required`. Neither one takes a wallet library or stores the token. See
[Sign-in](https://github.com/TemporaLabs/client-sdk/blob/main/docs/sign-in.md).

## Deposits and withdrawals

`deposit` and `withdraw` answer with a request that lists its steps. Check the steps before the owner signs:

- `check_steps` for a vault;
- `check_portfolio_deposit` and `check_portfolio_withdrawal` for a portfolio.

Each check reads every step's own bytes and refuses anything that is not exactly what the owner asked for. None
of them calls the network or signs. They take `request.steps` as the client returns them, and intents as plain
dictionaries with the names the docs use. The owner's wallet signs or sends each step, `submit` hands it back, and
`status` follows the request. See [Requests and steps](https://github.com/TemporaLabs/client-sdk/blob/main/docs/requests-and-steps.md).

## The MCP version

```python
from temporalabs_client import Ok, create_client, sign_in
from temporalabs_client.mcp import create_mcp_client

# Sign in over HTTP, with a token made for the MCP endpoint.
client = create_client("https://api.temporalabs.com")
signed_in = sign_in(client, owner=owner, sign_message=sign_message, audience="mcp")
if isinstance(signed_in, Ok):
    tempora = create_mcp_client("https://api.temporalabs.com/mcp", owner_token=signed_in.body.token)
    r = tempora.positions()
```

- **Same calls:** the same names, inputs and results as `create_client`, except sign-in and sign-out, which are not
  MCP tools: sign in with `create_client` and hand the token over. Each call is one POST in the MCP
  2026-07-28 protocol, so no MCP library is needed. `list_tools()` lists the endpoint's tools.
- **The token:** it must be made for the MCP endpoint, with `sign_in(client, ..., audience="mcp")`, or `"both"`
  when one process also calls the HTTP API.
- **A newer endpoint:** if the endpoint no longer serves this client's protocol revision, it answers
  `unsupported_protocol`. Upgrade the package.
- **Pinning the tools:** `TOOLS` is the API's published tool list and `RELEASED` the same list with its version.
  `tool_breaks(released, current)` lists what a newer list changed that a pinned consumer would notice: a tool or
  input removed, an input made required, an output schema dropped, a changed exposure.

## Security

- **Credentials stay on your origin.** The client key and the owner token go only to the origin of `base_url`.
  Redirects are refused. A call whose URL would leave that origin sends nothing and answers `wrong_origin`.
- **The owner token** is sent only on owner calls, and over MCP on the tool list too. Over MCP it travels in a
  header, never in a tool's arguments.
- **Every answer is checked** against the API's schema. An answer that does not match is the error
  `unreadable_answer`, never an exception.
- **The timeout holds** through the answer's last byte: each call runs on its own thread, and a call still running
  at `timeout_s` is abandoned and answered.
- **The client-key header's name** is exported as `CLIENT_KEY_HEADER`.
- **Private vulnerability reporting:** follow [SECURITY.md](https://github.com/TemporaLabs/client-sdk/blob/main/SECURITY.md), not a public issue.

## Compatibility

`API_VERSION` names the Tempora API version the client was generated from; this release speaks API `0.1.4`.
Within an API version the API only adds: new optional inputs, new answer fields, new calls. The client keeps
answer fields it does not know yet. See [versioning](https://github.com/TemporaLabs/client-sdk/blob/main/docs/versioning.md).

## Documentation

- [Getting started](https://github.com/TemporaLabs/client-sdk/blob/main/docs/getting-started.md) · [Sign-in](https://github.com/TemporaLabs/client-sdk/blob/main/docs/sign-in.md) · [Requests and steps](https://github.com/TemporaLabs/client-sdk/blob/main/docs/requests-and-steps.md)
- [Errors](https://github.com/TemporaLabs/client-sdk/blob/main/docs/errors.md) · [Versioning](https://github.com/TemporaLabs/client-sdk/blob/main/docs/versioning.md) · [Changelog](https://github.com/TemporaLabs/client-sdk/blob/main/CHANGELOG.md)
- [How it is made](https://github.com/TemporaLabs/client-sdk/blob/main/docs/how-it-is-made.md): how both clients
  are made from the API document

The usage guides show TypeScript; every call, option and result has the same name in Python, written in
snake_case where the TypeScript is camelCase (`createClient` is `create_client`, `traceId` is `trace_id`).

## Contributing

Feedback and pull requests are welcome. Most of the client is generated from the API document. See
[CONTRIBUTING.md](https://github.com/TemporaLabs/client-sdk/blob/main/CONTRIBUTING.md) for how it is made and the checks to run before a pull request.

## License

[Apache-2.0](https://github.com/TemporaLabs/client-sdk/blob/main/LICENSE). Keep [LICENSE](https://github.com/TemporaLabs/client-sdk/blob/main/LICENSE) and [NOTICE](https://github.com/TemporaLabs/client-sdk/blob/main/NOTICE) when redistributing. The license does not
grant rights to Tempora Labs' names ("Tempora" and "Tempora Labs", as NOTICE lists them).
