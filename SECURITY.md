# Security Policy

Nautelle runs coding agents on your machines, so a vulnerability can mean
running code on someone's computer. We take reports seriously.

## Supported versions

Security fixes are made for the latest stable release of the product and of
`nautelle-runner`, and for `develop`.

| Version | Supported |
| ------- | --------- |
| Latest stable release (`vX.Y.Z` tag) | :white_check_mark: |
| `develop` | :white_check_mark: fixes land here first |
| Older releases | :x: |

Always run the latest release. The runner is released separately (npm and
Homebrew, signed: [ADR-0049](docs/adr/0049-runner-releases-are-signed-and-cut-only-from-protected-tags.md)),
and `nautelle-runner` also needs updating when a fix is in the runner.

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request for a vulnerability.**

Report it privately through
[GitHub Security Advisories](https://github.com/AndreyBegma/Nautelle/security/advisories/new)
("Report a vulnerability" on the repository's Security tab).

Please include:

- what is affected (API, web app, runner, plugin, install script, CI) and the
  version or commit;
- steps to reproduce, with a proof of concept or logs if you have them;
- the impact: what an attacker gains and what they need first (an account, a
  role, network access, a pull request);
- a suggested fix, if you have one.

### Response targets

| Step | Target |
|---|---|
| Acknowledge your report | within 3 working days |
| First assessment: accepted, declined or needs more information | within 7 days |
| Fix or mitigation for a high or critical issue | within 30 days |
| Fix for a lower-severity issue | next regular release |

These are targets of a small team, not a contract. If we are going to miss one
we will tell you in the advisory. We coordinate disclosure with you: please give
us reasonable time to ship a fix before you publish, and we will credit you in
the advisory unless you prefer not to be named.

## Scope

In scope:

- **The runner's execution boundary.** The runner accepts typed commands from an
  allowlist and never runs a shell string
  ([ADR-0010](docs/adr/0010-typed-command-allowlist-on-the-runner.md)). It keeps
  a local security policy the server cannot change
  ([ADR-0047](docs/adr/0047-a-runner-local-security-policy-the-server-cannot-change.md)).
  A way to make a runner run something outside its allowlist or policy, escape
  its allowed roots, or read files the control plane must never read
  ([ADR-0001](docs/adr/0001-control-plane-and-per-machine-runner.md)) is a
  vulnerability.
- **Authentication and authorization**: sign-in, TOTP, roles, the approval-gated
  sign-up, the first-run setup token, runner pairing, API and webhook signing.
- **Secrets handling**: provider keys, tokens, and what ends up in logs, the
  audit log or session content.
- **CI and release trust**: pull-request pipelines are untrusted
  ([ADR-0053](docs/adr/0053-pull-request-pipelines-are-untrusted.md)); a way for
  a pull request to reach a secret, the Docker socket or a trusted cache beyond
  what that ADR already records as an open risk, or to tamper with a release, is
  in scope.
- The install script and the published Docker images.

Out of scope:

- Anything that needs control of the machine or the account the runner already
  runs as. A runner runs agents as its user by design.
- The known, documented residual risk in ADR-0053 item 7.
- Vulnerabilities in third-party software with no Nautelle-specific misuse;
  report those upstream.
- Denial of service by volume, social engineering, and findings from automated
  scanners without a demonstrated impact.
- Self-hosted deployments you configured insecurely (for example, exposing the
  API without TLS), unless our defaults or docs led you there.

Testing must stay on instances you own. Do not access other people's data, and
do not run tests that degrade a shared service.

Thank you for helping keep Nautelle and its users secure.
