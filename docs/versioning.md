# Versioning

## Generated from the API document

The client is generated from the Tempora API's own OpenAPI document. `spec/openapi.json` is a copy of
that document, taken at an API release, and `spec/SOURCE` records its API version and its sha256.
`npm run generate` reads it and the API's MCP tool list (`spec/tools.json`). From them it writes `llms.txt`
and, in `src/generated/`, the types, the answer schemas and the MCP tool list. Nothing in `src/generated/` is
written by hand. The checks fail if the document does not match `spec/SOURCE`, or if the generated files
differ from what the document produces.

A wrong or missing shape is fixed in the API's document, and the client is regenerated from it. It is
never patched by hand here.

## `API_VERSION`

The package exports `API_VERSION`, the API version the client was generated from:

```ts
import { API_VERSION } from '@temporalabs/client'

console.log(`client generated for the Tempora API ${API_VERSION}`)
```

## Answers only grow within an API version

Within one API version, the API only adds: new optional inputs, new answer fields, new calls. The API's
changelog records this promise. The client tolerates answer fields it does not know yet: they are left on
the body, not refused. Open lists, such as request and step states, gate ids, error codes and step kinds,
are typed as their known values or any string, so a value added later still reads.

A step's `payload` is the exception. It goes to the owner's wallet, so the checks before signing refuse a payload
field they do not know. A field the API adds to a payload later is refused until the client is updated to read it.

Some objects allow fields beyond their named ones (the EIP-712 `domain`, for example). Their types carry
an index signature, so a misspelled field name type-checks as `unknown` instead of failing: read such
fields deliberately.

## Version numbers

The client has its own version, separate from the API's. `API_VERSION` says which API version a client
speaks; the package version says which release of the client it is. Before `1.0.0`, a minor version
(`0.2.0`) may change the client's interface; a patch version (`0.1.1`) does not.

| client | speaks the Tempora API |
|---|---|
| `0.1.0` | `0.1.2` |

## Release tags

Each release is published to npm as `@temporalabs/client` at its version and tagged `vX.Y.Z` on this
repository. The first is `v0.1.0`. The tag is that version's source. See
[Getting started](getting-started.md#install).

What changed in each release is in the [changelog](../CHANGELOG.md).
