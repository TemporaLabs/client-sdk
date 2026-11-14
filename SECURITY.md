# Security Policy

This client carries a server-side client key and, on owner calls, an owner token. A defect here could
leak either, so we treat reports seriously.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately to Tempora Labs through GitHub's
private vulnerability reporting: [report a vulnerability](https://github.com/TemporaLabs/client-sdk/security/advisories/new)
(Security, then Report a vulnerability, on this repository). Include the affected file, a
minimal reproduction and the impact as you understand it.

## What to expect

| step | commitment |
|---|---|
| Acknowledgement | within 3 business days |
| Triage and severity | within 7 days of acknowledgement |
| Fix and disclosure | as fast as severity demands; a fix ships with a CHANGELOG entry naming the class of defect |

## What the client does to protect your credentials

- The client key goes only to the origin of the base URL you configure. Each call checks its final URL
  before any header is attached and sends nothing if it is off that origin (`wrong_origin`) or if a path
  value is `.` or `..` (`invalid_path_value`). Redirects are refused, never followed.
- The owner token is sent only on calls that need it.
- Every answer is checked against the API's own schema before it reaches your code.
- The package has one runtime dependency (zod) and no install scripts.
