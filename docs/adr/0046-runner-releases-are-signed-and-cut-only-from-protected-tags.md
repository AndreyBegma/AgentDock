# ADR-0046: Runner releases are signed, and their secrets reach only protected tags

Status: accepted · Date: 2026-10-16 · Amends [ADR-0017](0017-runner-distribution-homebrew-and-npm.md) §3 and §4 ·
Spec: [`docs/specs/card-106-security-high-release-the-runner-only-fr.md`](../specs/card-106-security-high-release-the-runner-only-fr.md)
(security audit 2026-10-16, WI-04)

## Context

ADR-0017 publishes `agentdock-runner` from `.woodpecker/release-runner.yml` on
a `runner-v*` tag and gave its secrets (`github_release_token`, `npm_token`)
to the `tag` and `manual` events. The gating sat in the workflow file, which
anyone who pushes a commit can edit, and nothing tied a tag to `main`. Anyone
who could push a `runner-v*` tag or start a manual run could run the publish
steps with the secrets, and so put a malicious binary on Homebrew and npm.
The release was not signed: the formula and the npm shim trusted whatever
they downloaded.

## Decision

1. **The boundary is in settings a pusher cannot change.** The Woodpecker
   secrets `github_release_token`, `npm_token` and `runner_signing_key` are
   restricted to the `tag` event only, never `manual`. A GitHub tag ruleset
   protects `runner-v*`: only an administrator creates, moves or deletes such
   a tag. The administrator cuts it from a commit on `main`; a ruleset cannot
   check that, so it is part of the release procedure. Both settings are made
   by a person (`deploy/README.md`). The workflow's own `when` is convenience, not
   security, and every step that reads a secret runs on a `runner-v*` tag
   alone.
2. **`SHA256SUMS` is signed with Ed25519.** `build-release.sh` lists the four
   tarballs and the four binaries in `SHA256SUMS` and signs the file with
   `RUNNER_SIGNING_KEY` (`scripts/sign-sums.ts`). `SHA256SUMS.sig` is the raw
   64-byte signature and is published with the Release. The public key is
   `apps/runner/release-key.pub`. A tag run without the key fails before
   building, and a key that is not the private half of `release-key.pub` is
   refused. Any other run signs with a throwaway key, so a dry run still
   builds every asset, but nothing it signs installs.
3. **Plain Ed25519, not minisign or cosign.** Both installers can check it
   with what they already have: Node's `crypto.verify` in the npm shim, and
   Ruby's OpenSSL in the Homebrew formula. Neither needs an extra tool on the
   user's machine, and anyone can check a release by hand with
   `openssl pkeyutl -verify -pubin -inkey release-key.pub -rawin -in SHA256SUMS -sigfile SHA256SUMS.sig`.
4. **The formula checks the signature before installing.** It downloads
   `SHA256SUMS` and `SHA256SUMS.sig` as resources and verifies them against
   the embedded public key. It then installs only a tarball whose checksum
   `SHA256SUMS` lists.
5. **The npm shim checks the binary before running it.** The wrapper package
   carries `SHA256SUMS` and `SHA256SUMS.sig`. The shim runs the platform
   binary only when the signature verifies against the embedded public key
   and the binary's checksum is listed. ADR-0017 §4 keeps holding: there is
   no `postinstall`, so the check cannot be skipped with `--ignore-scripts`
   or by a package manager that blocks install scripts. The binary is hashed
   once. Its size, mtime and digest go to `<binary>.verified`, and later runs
   re-check only the signature and the listing. Whoever can rewrite that file
   can rewrite the binary itself.

## Consequences

- A release needs a fourth thing a person sets up once: the Ed25519 key pair.
  Its private half is the Woodpecker secret `runner_signing_key`, and its
  public half is `apps/runner/release-key.pub`. Rotating the key is a pull
  request that replaces `release-key.pub` and the copies embedded in the npm
  shim and the formula template (tests keep them equal), plus a new secret.
- The manual dry run no longer sees any secret. It cannot rehearse the
  signature with the real key. A tag run with `RUNNER_RELEASE_DRY_RUN=1` can.
- The first run of the npm shim after an install hashes the binary, which
  takes about 50 ms. Later runs only read the stamp.
- The signature proves a release came from a tag run holding the key. It does
  not stop a person who can both push a protected tag and edit the workflow;
  the tag ruleset limits who that is.
